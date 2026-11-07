import { Inject, Injectable } from "@nestjs/common";
import { or } from "@prisma/orm-postgres/orm-client";

import { AccessService } from "../../common/access.service.ts";
import { AuditService } from "../../common/audit.service.ts";
import type { StaffPrincipal } from "../../common/auth/principal.ts";
import { db, dhakaDate, nowIso, toDate } from "../../common/db.ts";
import { badRequest, conflict, forbidden, found, unprocessable } from "../../common/errors.ts";
import { EventsService } from "../../common/events.service.ts";
import { NotificationService } from "../../common/notification.service.ts";
import { CAPTURE, CREDENTIALED, DOCTORS, type StaffRole, TEAM } from "../../common/roles.ts";
import { assertTransition, canTransition } from "../../common/workflow.ts";
import { ClinicalContextService } from "../clinical-core/clinical-context.service.ts";
import { EncounterCompletionService } from "../clinical-core/encounter-completion.service.ts";
import { ObservationRejection, ObservationService, type ObservationValue, REVIEW_ALERT_ACTIONS } from "../clinical-core/observation.service.ts";
import { CAPTURABLE } from "./sync.service.ts";

const ACTIVE_ASSIGNMENT = ["assigned", "accepted", "started"] as const;

@Injectable()
export class TeamService {
  constructor(
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(EventsService) private readonly events: EventsService,
    @Inject(NotificationService) private readonly notifications: NotificationService,
    @Inject(ClinicalContextService) private readonly ctx: ClinicalContextService,
    @Inject(ObservationService) private readonly observations: ObservationService,
    @Inject(EncounterCompletionService) private readonly completion: EncounterCompletionService,
  ) {}

  private requireTeam(p: StaffPrincipal) {
    if (!this.access.hasRole(p, TEAM)) throw forbidden("Team app role required");
  }

  // ---- devices --------------------------------------------------------------

  async registerDevice(p: StaffPrincipal, input: { platform: "android" | "ios" | "web"; appVersion: string; deviceModel?: string; hubId?: string }) {
    this.requireTeam(p);
    if (input.hubId) await this.access.require(p, TEAM, { hubId: input.hubId }, "device.register");
    const device = await db.orm.ops.DeviceInstallation.create({
      userId: p.userId,
      platform: input.platform,
      appVersion: input.appVersion,
      deviceModel: input.deviceModel ?? null,
      hubId: input.hubId ?? null,
      lastSeenAt: nowIso(),
    });
    await this.audit.record(p, { action: "device.register", targetType: "device_installation", targetId: device.id, hubId: input.hubId ?? null });
    return device;
  }

  private async ownDevice(p: StaffPrincipal, id: string) {
    const device = found(await db.orm.ops.DeviceInstallation.first({ id }), "Device");
    if (device.userId !== p.userId) throw forbidden();
    return device;
  }

  async heartbeat(p: StaffPrincipal, id: string, input: { pendingCount: number; oldestPendingAt?: string | null; lastSyncAt?: string | null; appVersion?: string }) {
    const device = await this.ownDevice(p, id);
    if (device.revokedAt) throw forbidden("Device has been revoked", "DEVICE_REVOKED");
    return db.orm.ops.DeviceInstallation.where({ id }).update({
      pendingCount: input.pendingCount,
      oldestPendingAt: input.pendingCount > 0 ? (input.oldestPendingAt ?? device.oldestPendingAt ?? nowIso()) : null,
      lastSyncAt: input.lastSyncAt ?? device.lastSyncAt,
      appVersion: input.appVersion ?? device.appVersion,
      lastSeenAt: nowIso(),
    });
  }

  async revokeDevice(p: StaffPrincipal, id: string, reason: string) {
    const device = await this.ownDevice(p, id);
    if (device.pendingCount > 0) throw conflict("PENDING_DATA", "This device still reports unsynced clinical data; sync before revoking");
    await db.orm.ops.DeviceInstallation.where({ id }).update({ revokedAt: nowIso(), revokedReason: reason });
    await this.audit.record(p, { action: "device.revoke", targetType: "device_installation", targetId: id, reason });
    return { id, revoked: true };
  }

  // ---- my work ---------------------------------------------------------------

  async mySessions(p: StaffPrincipal) {
    this.requireTeam(p);
    const from = dhakaDate(new Date(Date.now() - 24 * 3600_000));
    const shifts = await db.orm.hub.StaffShift.where({ userId: p.userId })
      .where((s) => s.status.in(["approved", "checked_in"]))
      .where((s) => s.sessionId.isNotNull())
      .include("session", (s) => s.select("id", "title", "titleBn", "status", "sessionDate", "startsAt", "endsAt", "hubId", "serviceTypeId", "teamLeadUserId"))
      .include("hub", (h) => h.select("id", "code", "name", "nameBn", "addressLine", "contactPhone"))
      .include("station", (s) => s.select("id", "code", "name", "stationType", "status"))
      .orderBy((s) => s.startsAt.asc())
      .all();
    return shifts
      .filter((s) => s.session && s.session.sessionDate >= from && !["cancelled", "completed"].includes(s.session.status))
      .map((s) => ({ shiftId: s.id, role: s.role, shiftStatus: s.status, startsAt: s.startsAt, endsAt: s.endsAt, session: s.session, hub: s.hub, station: s.station, isTeamLead: s.session?.teamLeadUserId === p.userId || s.role === "special_team_lead" }));
  }

  async myTasks(p: StaffPrincipal) {
    this.requireTeam(p);
    const rows = await db.orm.clinical.EncounterAssignment.where({ userId: p.userId })
      .where((a) => a.status.in([...ACTIVE_ASSIGNMENT]))
      .include("encounter", (e) => e.select("id", "status", "patientId", "hubId", "sessionId", "identityMatchStatus", "openedAt", "serviceTypeId"))
      .include("station", (s) => s.select("id", "code", "name"))
      .orderBy((a) => a.assignedAt.asc())
      .all();
    const out = [];
    for (const a of rows) {
      const e = a.encounter!;
      const ticket = await db.orm.hub.QueueTicket.select("displayCode", "status", "priorityLevel").where({ encounterId: e.id }).first();
      const hub = e.hubId ? await db.orm.hub.Hub.select("id", "code", "name").first({ id: e.hubId }) : null;
      const session = e.sessionId ? await db.orm.hub.HubSession.select("id", "title", "sessionDate").first({ id: e.sessionId }) : null;
      const pt = await this.ctx.minimalPatient(db, e.patientId);
      out.push({
        assignmentId: a.id,
        assignmentStatus: a.status,
        role: a.role,
        assignedAt: a.assignedAt,
        station: a.station,
        encounter: { id: e.id, status: e.status, identityMatchStatus: e.identityMatchStatus, openedAt: e.openedAt },
        queue: ticket,
        hub,
        session,
        patient: pt ? { healoraCode: pt.healoraCode, fullName: pt.fullName, fullNameBn: pt.fullNameBn, sex: pt.sex, ageYears: pt.ageYears } : null,
      });
    }
    return out;
  }

  /** Offline assignment package: only my encounters in this session (PRD §9.3 step 5, §10.6). */
  async offlinePackage(p: StaffPrincipal, sessionId: string) {
    const session = found(await db.orm.hub.HubSession.first({ id: sessionId }), "Session");
    const shift = await db.orm.hub.StaffShift.where({ userId: p.userId, sessionId }).where((s) => s.status.in(["approved", "checked_in"])).first();
    if (!shift) throw forbidden("You are not rostered on this session");
    const assignments = await db.orm.clinical.EncounterAssignment.where({ userId: p.userId })
      .where((a) => a.status.in([...ACTIVE_ASSIGNMENT]))
      .include("encounter", (e) => e.select("id", "status", "patientId", "sessionId", "protocolId", "identityMatchStatus"))
      .all();
    const mine = assignments.filter((a) => a.encounter?.sessionId === sessionId);
    const checklistCache = new Map<string, Awaited<ReturnType<ClinicalContextService["checklist"]>>>();
    const encounters = [];
    for (const a of mine) {
      const e = a.encounter!;
      if (e.protocolId && !checklistCache.has(e.protocolId)) checklistCache.set(e.protocolId, await this.ctx.checklist(db, e.protocolId));
      const tasks = await db.orm.clinical.EncounterTask.select("observationCode", "required", "status").where({ encounterId: e.id }).all();
      encounters.push({
        encounterId: e.id,
        assignmentId: a.id,
        status: e.status,
        identityMatchStatus: e.identityMatchStatus,
        protocolId: e.protocolId,
        patient: await this.ctx.minimalPatient(db, e.patientId),
        consent: await this.ctx.consentStatus(db, e.patientId),
        tasks,
      });
    }
    const devices = await db.orm.hub.Equipment.select("id", "assetTag", "category", "make", "model", "stationId", "supportedObservationCodes", "supportedUnits", "status")
      .where({ hubId: session.hubId })
      .where((q) => q.status.in(["available", "assigned"]))
      .all();
    const generatedAt = nowIso();
    const expiresAt = new Date(Math.min((toDate(session.endsAt)?.getTime() ?? Date.now()) + 2 * 3600_000, Date.now() + 12 * 3600_000)).toISOString();
    await this.audit.record(p, { action: "offline_package.download", targetType: "session", targetId: sessionId, hubId: session.hubId, metadata: { encounterCount: encounters.length } });
    return {
      generatedAt,
      expiresAt,
      session: { id: session.id, title: session.title, sessionDate: session.sessionDate, startsAt: session.startsAt, endsAt: session.endsAt, hubId: session.hubId },
      protocols: Object.fromEntries(checklistCache),
      encounters,
      devices,
      rules: { deleteAfterAcknowledgedSync: true, encryptAtRest: true },
    };
  }

  // ---- assignments -----------------------------------------------------------

  private async myAssignment(p: StaffPrincipal, assignmentId: string) {
    const a = found(await db.orm.clinical.EncounterAssignment.first({ id: assignmentId }), "Assignment");
    if (a.userId !== p.userId) throw forbidden("This assignment is not yours");
    return a;
  }

  async accept(p: StaffPrincipal, assignmentId: string) {
    const a = await this.myAssignment(p, assignmentId);
    if (a.status !== "assigned") throw conflict("INVALID_TRANSITION", `Assignment is '${a.status}'`);
    return db.transaction(async (tx) => {
      const row = await tx.orm.clinical.EncounterAssignment.where({ id: a.id }).update({ status: "accepted", acceptedAt: nowIso() });
      const enc = found(await tx.orm.clinical.Encounter.first({ id: a.encounterId }), "Encounter");
      await this.events.emit(tx, { eventType: "encounter.assigned", aggregateType: "encounter", aggregateId: enc.id, hubId: enc.hubId, sessionId: enc.sessionId, correlationId: p.correlationId, payload: { encounterId: enc.id, assignmentId: a.id, assignmentStatus: "accepted" } });
      return row;
    });
  }

  async start(p: StaffPrincipal, assignmentId: string) {
    const a = await this.myAssignment(p, assignmentId);
    if (!["assigned", "accepted"].includes(a.status)) throw conflict("INVALID_TRANSITION", `Assignment is '${a.status}'`);
    return db.transaction(async (tx) => {
      const enc = found(await tx.orm.clinical.Encounter.where({ id: a.encounterId }).forNoKeyUpdate().first(), "Encounter");
      if (enc.identityMatchStatus !== "confirmed") throw conflict("IDENTITY_UNCONFIRMED", "Confirm the patient's identity before starting");
      const now = nowIso();
      await tx.orm.clinical.EncounterAssignment.where({ id: a.id }).update({ status: "started", startedAt: now, acceptedAt: a.acceptedAt ?? now });
      if (enc.status !== "in_progress") {
        assertTransition("encounter", enc.status, "in_progress");
        await tx.orm.clinical.Encounter.where({ id: enc.id }).update({ status: "in_progress", version: enc.version + 1 });
      }
      if (enc.appointmentId) {
        const appt = await tx.orm.hub.Appointment.where({ id: enc.appointmentId }).forNoKeyUpdate().first();
        if (appt && canTransition("appointment", appt.status, "in_service")) await tx.orm.hub.Appointment.where({ id: appt.id }).update({ status: "in_service", version: appt.version + 1 });
      }
      const ticket = await tx.orm.hub.QueueTicket.where({ encounterId: enc.id }).forNoKeyUpdate().first();
      if (ticket && ticket.status !== "in_service" && canTransition("queue", ticket.status, "in_service")) {
        await tx.orm.hub.QueueTicket.where({ id: ticket.id }).update({ status: "in_service", serviceStartedAt: ticket.serviceStartedAt ?? now, calledAt: ticket.calledAt ?? now, version: ticket.version + 1 });
        await tx.orm.hub.QueueTicketEvent.create({ ticketId: ticket.id, fromStatus: ticket.status, toStatus: "in_service", toStationId: a.stationId, actorUserId: p.userId, occurredAt: now });
      }
      await this.events.emit(tx, { eventType: "encounter.started", aggregateType: "encounter", aggregateId: enc.id, hubId: enc.hubId, sessionId: enc.sessionId, correlationId: p.correlationId, payload: { encounterId: enc.id, assignmentId: a.id, status: "in_progress" } });
      return { encounterId: enc.id, status: "in_progress", startedAt: now };
    });
  }

  async transfer(p: StaffPrincipal, assignmentId: string, input: { toUserId: string; handoverNote: string; reason?: string }) {
    const a = found(await db.orm.clinical.EncounterAssignment.first({ id: assignmentId }), "Assignment");
    const enc = found(await db.orm.clinical.Encounter.first({ id: a.encounterId }), "Encounter");
    const isLead = await this.ctx.isSessionLead(db, p.userId, enc.sessionId);
    if (a.userId !== p.userId && !isLead) throw forbidden("Only the assignee or the session team lead can hand over");
    if (!ACTIVE_ASSIGNMENT.includes(a.status as never)) throw conflict("INVALID_TRANSITION", `Assignment is '${a.status}'`);
    if (input.toUserId === a.userId) throw badRequest("SAME_ASSIGNEE", "Choose a different team member");

    // Eligibility: rostered on the session, capture role, valid credential (PRD §8.7).
    if (!enc.sessionId) throw conflict("NO_SESSION", "Walk-in encounters without a session must be reassigned from the hub website");
    const shift = await db.orm.hub.StaffShift.where({ userId: input.toUserId, sessionId: enc.sessionId }).where((s) => s.status.in(["approved", "checked_in"])).first();
    if (!shift) throw unprocessable("TARGET_NOT_ROSTERED", "That person is not rostered on this session");
    const now = nowIso();
    const roles = await db.orm.identity.RoleAssignment.select("role").where({ userId: input.toUserId, status: "active" }).where((r) => r.validFrom.lte(now)).where((r) => or(r.validTo.isNull(), r.validTo.gt(now))).all();
    const role = (CAPTURE.includes(shift.role as StaffRole) ? shift.role : roles.map((r) => r.role).find((r) => CAPTURE.includes(r as StaffRole))) as StaffRole | undefined;
    if (!role || !roles.some((r) => r.role === role)) throw unprocessable("TARGET_NOT_ELIGIBLE", "That person has no active team role for capture");
    if (CREDENTIALED.includes(role) && !(await this.ctx.activeCredential(db, input.toUserId))) throw unprocessable("TARGET_CREDENTIAL_INVALID", "That person has no active verified credential");

    return db.transaction(async (tx) => {
      const next = await tx.orm.clinical.EncounterAssignment.create({
        encounterId: enc.id,
        userId: input.toUserId,
        role,
        stationId: shift.stationId ?? a.stationId,
        status: "assigned",
        assignedById: p.userId,
        assignedAt: now,
        reason: input.reason ?? "handover",
      });
      await tx.orm.clinical.EncounterAssignment.where({ id: a.id }).update({ status: "transferred", endedAt: now, transferredToId: next.id, handoverNote: input.handoverNote, reason: input.reason ?? "handover" });
      await this.events.emit(tx, { eventType: "encounter.assigned", aggregateType: "encounter", aggregateId: enc.id, hubId: enc.hubId, sessionId: enc.sessionId, correlationId: p.correlationId, payload: { encounterId: enc.id, assignmentId: next.id, previousAssignmentId: a.id, assignedStaffUserId: input.toUserId, assignmentRole: role } });
      await this.notifications.enqueue(tx, { template: "staff.encounter_assigned", userId: input.toUserId, deepLink: `healora-team://encounters/${enc.id}`, relatedType: "encounter", relatedId: enc.id });
      await this.audit.record(p, { action: "encounter.reassign", targetType: "encounter", targetId: enc.id, hubId: enc.hubId, patientId: enc.patientId, reason: input.reason ?? "handover", metadata: { from: a.userId, to: input.toUserId } }, tx);
      return { previousAssignmentId: a.id, assignment: next };
    });
  }

  async release(p: StaffPrincipal, assignmentId: string, reason: string) {
    const a = await this.myAssignment(p, assignmentId);
    if (!ACTIVE_ASSIGNMENT.includes(a.status as never)) throw conflict("INVALID_TRANSITION", `Assignment is '${a.status}'`);
    return db.transaction(async (tx) => {
      const enc = found(await tx.orm.clinical.Encounter.first({ id: a.encounterId }), "Encounter");
      await tx.orm.clinical.EncounterAssignment.where({ id: a.id }).update({ status: "released", endedAt: nowIso(), reason });
      await this.events.emit(tx, { eventType: "encounter.updated", aggregateType: "encounter", aggregateId: enc.id, hubId: enc.hubId, sessionId: enc.sessionId, correlationId: p.correlationId, payload: { encounterId: enc.id, assignmentId: a.id, assignmentStatus: "released" } });
      await this.audit.record(p, { action: "encounter.release", targetType: "encounter", targetId: enc.id, hubId: enc.hubId, patientId: enc.patientId, reason }, tx);
      return { assignmentId: a.id, status: "released" };
    });
  }

  // ---- encounter context, identity, consent ----------------------------------

  async context(p: StaffPrincipal, encounterId: string) {
    const { encounter: enc, assignment } = await this.access.requireEncounterAccess(p, encounterId, "read");
    const isDoctor = this.ctx.isDoctor(p);
    const checklist = await this.ctx.checklist(db, enc.protocolId);
    const tasks = await db.orm.clinical.EncounterTask.select("observationCode", "required", "status", "missingReason").where({ encounterId }).all();
    let previous: Record<string, unknown[]> | undefined;
    if (isDoctor) {
      previous = {};
      for (const item of checklist) {
        previous[item.observationCode] = await db.orm.clinical.Observation.select("valueNumeric", "valueCode", "unit", "context", "measuredAt", "sourceType", "validationStatus")
          .where({ patientId: enc.patientId, observationCode: item.observationCode })
          .where((o) => o.encounterId.neq(encounterId))
          .where((o) => o.status.in(["final", "amended"]))
          .orderBy((o) => o.measuredAt.desc())
          .limit(3)
          .all();
      }
    }
    const hub = enc.hubId ? await db.orm.hub.Hub.select("id", "code", "name", "emergencyContactName", "emergencyContactPhone", "nearestReferralFacility", "referralFacilityPhone", "referralInstructions").first({ id: enc.hubId }) : null;
    await this.audit.record(p, { action: "encounter.context.read", targetType: "encounter", targetId: encounterId, hubId: enc.hubId, patientId: enc.patientId, metadata: { includesPriorValues: isDoctor } });
    return {
      encounter: { id: enc.id, status: enc.status, identityMatchStatus: enc.identityMatchStatus, requiresDoctorReview: enc.requiresDoctorReview, protocolId: enc.protocolId, sessionId: enc.sessionId, openedAt: enc.openedAt },
      myAssignment: assignment ? { id: assignment.id, status: assignment.status, role: assignment.role } : null,
      patient: await this.ctx.minimalPatient(db, enc.patientId),
      consent: await this.ctx.consentStatus(db, enc.patientId),
      checklist,
      tasks,
      hub,
      ...(previous ? { previousValues: previous } : {}),
    };
  }

  async confirmIdentity(p: StaffPrincipal, encounterId: string, input: { confirmed: boolean; method: string; note?: string }) {
    const { encounter: enc } = await this.access.requireEncounterAccess(p, encounterId, "capture");
    return db.transaction(async (tx) => {
      const now = nowIso();
      if (input.confirmed) {
        await tx.orm.clinical.Encounter.where({ id: enc.id }).update({ identityMatchStatus: "confirmed", identityConfirmedById: p.userId, identityConfirmedAt: now });
        await this.audit.record(p, { action: "encounter.identity_confirmed", targetType: "encounter", targetId: enc.id, hubId: enc.hubId, patientId: enc.patientId, metadata: { method: input.method } }, tx);
        return { encounterId: enc.id, identityMatchStatus: "confirmed", confirmedAt: now };
      }
      // Mismatch: stop capture by escalating; nothing is attached to an uncertain identity (PRD §9.4).
      const esc = await tx.orm.clinical.EncounterEscalation.create({ encounterId: enc.id, type: "operational", raisedById: p.userId, raisedAt: now, notes: `Identity mismatch (${input.method})${input.note ? `: ${input.note}` : ""}` });
      if (canTransition("encounter", enc.status, "escalated")) await tx.orm.clinical.Encounter.where({ id: enc.id }).update({ status: "escalated", version: enc.version + 1 });
      if (enc.hubId) {
        await tx.orm.hub.OperationalException.create({ hubId: enc.hubId, sessionId: enc.sessionId, encounterId: enc.id, type: "potential_duplicate_patient", severity: "high", status: "open", summary: "Team member could not confirm patient identity", dedupeKey: `identity:${enc.id}`, raisedAt: now }).catch(() => undefined);
      }
      await this.events.emit(tx, { eventType: "encounter.updated", aggregateType: "encounter", aggregateId: enc.id, hubId: enc.hubId, sessionId: enc.sessionId, correlationId: p.correlationId, payload: { encounterId: enc.id, status: "escalated", reason: "identity_mismatch" } });
      await this.audit.record(p, { action: "encounter.identity_mismatch", targetType: "encounter", targetId: enc.id, hubId: enc.hubId, patientId: enc.patientId, priority: "high", metadata: { method: input.method, escalationId: esc.id } }, tx);
      return { encounterId: enc.id, identityMatchStatus: enc.identityMatchStatus, captureBlocked: true, escalationId: esc.id };
    });
  }

  async consent(p: StaffPrincipal, encounterId: string) {
    const { encounter: enc } = await this.access.requireEncounterAccess(p, encounterId, "read");
    const status = await this.ctx.consentStatus(db, enc.patientId);
    const linked = await db.orm.clinical.EncounterConsent.select("consentId").where({ encounterId }).all();
    const representatives = await db.orm.clinical.PatientRepresentative.select("id", "fullName", "relationship", "validTo")
      .where({ patientId: enc.patientId })
      .where((r) => r.revokedAt.isNull())
      .all();
    const templates = await db.orm.clinical.ConsentTemplate.select("id", "code", "version", "purpose", "language", "title", "body", "verbalScript")
      .where({ status: "approved" })
      .where((t) => t.purpose.in(["hub_service", "health_data_processing", "caregiver_authority"]))
      .all();
    return { ...status, linkedConsentIds: linked.map((l) => l.consentId), representatives, templates };
  }

  async captureConsent(
    p: StaffPrincipal,
    encounterId: string,
    input: { templateId: string; method: "app_acceptance" | "digital_signature" | "verbal_witnessed" | "paper_scanned" | "thumbprint"; representativeId?: string; witnessName?: string; evidenceRef?: string; expiresAt?: string },
  ) {
    const { encounter: enc } = await this.access.requireEncounterAccess(p, encounterId, "capture");
    const now = nowIso();
    const tpl = found(await db.orm.clinical.ConsentTemplate.first({ id: input.templateId }), "Consent template");
    if (tpl.status !== "approved" || (tpl.effectiveFrom && tpl.effectiveFrom > now) || (tpl.effectiveTo && tpl.effectiveTo <= now)) {
      throw unprocessable("TEMPLATE_NOT_APPROVED", "Consent template is not approved or not in effect");
    }
    if (input.method === "verbal_witnessed" && !input.witnessName) throw badRequest("WITNESS_REQUIRED", "witnessName is required for verbal consent");
    if (input.representativeId) {
      const rep = await db.orm.clinical.PatientRepresentative.first({ id: input.representativeId });
      const valid = rep && rep.patientId === enc.patientId && !rep.revokedAt && rep.validFrom <= now && (!rep.validTo || rep.validTo > now);
      if (!valid) throw unprocessable("REPRESENTATIVE_INVALID", "Representative is not a valid, current authority for this patient");
    }
    return db.transaction(async (tx) => {
      const consent = await tx.orm.clinical.Consent.create({
        patientId: enc.patientId,
        representativeId: input.representativeId ?? null,
        templateId: tpl.id,
        purpose: tpl.purpose,
        dataCategories: tpl.dataCategories,
        recipients: tpl.recipients,
        language: tpl.language,
        method: input.method,
        capturedById: p.userId,
        capturedAt: now,
        capturedAtHubId: enc.hubId,
        witnessName: input.witnessName ?? null,
        evidenceRef: input.evidenceRef ?? null,
        expiresAt: input.expiresAt ?? null,
      });
      await tx.orm.clinical.EncounterConsent.create({ encounterId: enc.id, consentId: consent.id });
      await this.audit.record(p, { action: "consent.capture", targetType: "consent", targetId: consent.id, hubId: enc.hubId, patientId: enc.patientId, metadata: { purpose: tpl.purpose, templateCode: tpl.code, version: tpl.version, method: input.method, representative: !!input.representativeId } }, tx);
      return { consent, status: await this.ctx.consentStatus(tx, enc.patientId) };
    });
  }

  // ---- observations: corrections ---------------------------------------------

  async correct(p: StaffPrincipal, observationId: string, input: ObservationValue & { correctionReason: string; idempotencyKey: string; id?: string }) {
    const old = found(await db.orm.clinical.Observation.first({ id: observationId }), "Observation");
    if (!["final", "amended", "preliminary"].includes(old.status)) throw conflict("NOT_CORRECTABLE", `Observation is '${old.status}'; correct the current version`);
    if (input.observationCode !== old.observationCode) throw badRequest("CODE_MISMATCH", "A correction must keep the same observation code");
    const enc = found(await db.orm.clinical.Encounter.first({ id: old.encounterId }), "Encounter");

    let role: StaffRole | null = null;
    if (old.performerUserId === p.userId) role = old.performerRole as StaffRole;
    else if (this.ctx.isDoctor(p) && (await this.access.can(p, DOCTORS, { hubId: enc.hubId ?? undefined }))) role = this.ctx.doctorRole(p);
    else if (await this.ctx.isSessionLead(db, p.userId, enc.sessionId)) role = "special_team_lead";
    if (!role) {
      await this.audit.record(p, { action: "denied:observation.correct", targetType: "observation", targetId: observationId, hubId: enc.hubId, patientId: enc.patientId, outcome: "denied", priority: "high" });
      throw forbidden("Only the performer, a responsible doctor or the session team lead may correct this measurement");
    }

    try {
      return await db.transaction(async (tx) => {
        const locked = found(await tx.orm.clinical.Observation.where({ id: old.id }).forNoKeyUpdate().first(), "Observation");
        if (locked.status === "superseded") throw conflict("ALREADY_CORRECTED", "This measurement was already corrected");
        await tx.orm.clinical.Observation.where({ id: old.id }).update({ status: "superseded" });
        const { observation, alerts } = await this.observations.insert(tx, p, enc, role, { ...input, repeatOfId: undefined, repeatReason: undefined }, { supersedesId: old.id, correctionReason: input.correctionReason, status: "amended" });
        await this.audit.record(p, { action: "observation.correct", targetType: "observation", targetId: observation.id, hubId: enc.hubId, patientId: enc.patientId, reason: input.correctionReason, metadata: { supersedesId: old.id, encounterId: enc.id } }, tx);
        return { observation, supersededId: old.id, alerts };
      });
    } catch (e) {
      if (e instanceof ObservationRejection) throw unprocessable(`OBSERVATION_${e.category.toUpperCase()}`, e.message);
      throw e;
    }
  }

  // ---- tasks & notes ---------------------------------------------------------

  async markMissing(p: StaffPrincipal, encounterId: string, code: string, input: { reason: "patient_declined" | "patient_unable" | "equipment_unavailable" | "not_clinically_indicated" | "time_constraint" | "other"; note?: string }) {
    const { encounter: enc } = await this.access.requireEncounterAccess(p, encounterId, "capture");
    if (!CAPTURABLE.includes(enc.status)) throw conflict("ENCOUNTER_NOT_OPEN", `Encounter is '${enc.status}'`);
    if (input.reason === "other" && !input.note) throw badRequest("NOTE_REQUIRED", "A note is required when the reason is 'other'");
    const task = found(await db.orm.clinical.EncounterTask.where({ encounterId, observationCode: code }).first(), "Task");
    if (task.status === "captured") throw conflict("ALREADY_CAPTURED", "This measurement was captured; correct it instead");
    return db.transaction(async (tx) => {
      const row = await tx.orm.clinical.EncounterTask.where({ id: task.id }).update({ status: "missing", missingReason: input.reason, missingNote: input.note ?? null, completedById: p.userId, completedAt: nowIso() });
      await this.audit.record(p, { action: "encounter_task.missing", targetType: "encounter", targetId: encounterId, hubId: enc.hubId, patientId: enc.patientId, reason: input.reason, metadata: { code } }, tx);
      return row;
    });
  }

  async waive(p: StaffPrincipal, encounterId: string, code: string, reason: string) {
    if (!this.ctx.isDoctor(p)) throw forbidden("Only a doctor can waive a required measurement");
    const { encounter: enc } = await this.access.requireEncounterAccess(p, encounterId, "review");
    await this.ctx.requireCredential(db, p.userId);
    const task = found(await db.orm.clinical.EncounterTask.where({ encounterId, observationCode: code }).first(), "Task");
    if (task.status === "captured") throw conflict("ALREADY_CAPTURED", "This measurement was captured");
    return db.transaction(async (tx) => {
      const row = await tx.orm.clinical.EncounterTask.where({ id: task.id }).update({ status: "waived", missingReason: "not_clinically_indicated", missingNote: reason, completedById: p.userId, completedAt: nowIso() });
      await this.audit.record(p, { action: "encounter_task.waive", targetType: "encounter", targetId: encounterId, hubId: enc.hubId, patientId: enc.patientId, reason, metadata: { code } }, tx);
      return row;
    });
  }

  async addNote(p: StaffPrincipal, encounterId: string, input: { noteType: "factual_worker_note" | "clinical_assessment" | "follow_up_instruction" | "handover"; content: string; language: "bn" | "en"; patientVisible: boolean; idempotencyKey?: string }) {
    const clinical = input.noteType === "clinical_assessment" || input.noteType === "follow_up_instruction";
    const { encounter: enc, assignment } = await this.access.requireEncounterAccess(p, encounterId, clinical ? "review" : "read");
    if (!clinical && !assignment && !this.ctx.isDoctor(p)) throw forbidden("Only the assigned team member can add worker notes");
    let credentialId: string | null = null;
    let role: StaffRole | null = (assignment?.role as StaffRole | undefined) ?? null;
    if (clinical) {
      if (!this.ctx.isDoctor(p)) throw forbidden("Clinical notes and follow-up instructions are doctor-only");
      credentialId = (await this.ctx.requireCredential(db, p.userId)).id;
      role = this.ctx.doctorRole(p);
    }
    if (!role) role = this.ctx.doctorRole(p) ?? "field_health_worker";
    if (input.patientVisible && input.noteType !== "follow_up_instruction") throw badRequest("NOT_PATIENT_VISIBLE", "Only follow-up instructions can be shown to the patient");
    if (input.idempotencyKey) {
      const prev = await db.orm.clinical.ClinicalNote.where({ idempotencyKey: input.idempotencyKey }).first();
      if (prev) return { note: prev, duplicate: true };
    }
    return db.transaction(async (tx) => {
      const note = await tx.orm.clinical.ClinicalNote.create({
        encounterId,
        authorId: p.userId,
        authorRole: role!,
        credentialId,
        noteType: input.noteType,
        content: input.content,
        language: input.language,
        patientVisible: input.patientVisible,
        signedAt: clinical ? nowIso() : null,
        idempotencyKey: input.idempotencyKey ?? null,
      });
      await this.audit.record(p, { action: "clinical_note.create", targetType: "clinical_note", targetId: note.id, hubId: enc.hubId, patientId: enc.patientId, metadata: { noteType: input.noteType, patientVisible: input.patientVisible } }, tx);
      return { note, duplicate: false };
    });
  }

  // ---- submit & escalate -----------------------------------------------------

  async submit(p: StaffPrincipal, encounterId: string) {
    const { encounter: enc0 } = await this.access.requireEncounterAccess(p, encounterId, "capture");
    return db.transaction(async (tx) => {
      const enc = found(await tx.orm.clinical.Encounter.where({ id: enc0.id }).forNoKeyUpdate().first(), "Encounter");
      if (!["in_progress", "awaiting_remeasurement", "awaiting_sync"].includes(enc.status)) throw conflict("INVALID_TRANSITION", `Cannot submit an encounter in '${enc.status}'`);
      const pending = await tx.orm.clinical.EncounterTask.select("observationCode").where({ encounterId, required: true, status: "pending" }).all();
      if (pending.length) throw conflict("REQUIRED_MEASUREMENTS_MISSING", "Record or give a reason for each required measurement", { pending: pending.map((t) => t.observationCode) });
      const openRemeasure = await tx.orm.clinical.RemeasurementRequest.where({ encounterId, status: "open" }).all();
      if (openRemeasure.length) throw conflict("REMEASUREMENT_OUTSTANDING", "Doctor-requested remeasurements are outstanding", { codes: openRemeasure.map((r) => r.observationCode) });

      const reviewAlerts = await tx.orm.clinical.ObservationAlert.where({ encounterId })
        .where((a) => a.status.in(["open", "acknowledged"]))
        .where((a) => a.action.in(REVIEW_ALERT_ACTIONS as never))
        .all();
      const implausible = await tx.orm.clinical.Observation.select("id").where({ encounterId, validationStatus: "implausible" }).where((o) => o.status.in(["final", "amended"])).first();
      const needsReview = enc.requiresDoctorReview || reviewAlerts.length > 0 || implausible !== null || enc.status === "awaiting_remeasurement";

      if (!needsReview) {
        const done = await this.completion.complete(tx, p, enc.id, "completed");
        return { ...done, reviewRequested: false };
      }
      const now = nowIso();
      assertTransition("encounter", enc.status === "awaiting_sync" ? "in_progress" : enc.status, "submitted_for_review");
      await tx.orm.clinical.Encounter.where({ id: enc.id }).update({ status: "submitted_for_review", submittedAt: now, version: enc.version + 1 });
      await tx.orm.clinical.Observation.where({ encounterId, reviewStatus: "not_required" }).where((o) => o.status.in(["final", "amended"])).updateAll({ reviewStatus: "pending" });
      const ticket = await tx.orm.hub.QueueTicket.where({ encounterId }).forNoKeyUpdate().first();
      if (ticket && canTransition("queue", ticket.status, "awaiting_review")) {
        await tx.orm.hub.QueueTicket.where({ id: ticket.id }).update({ status: "awaiting_review", version: ticket.version + 1 });
        await tx.orm.hub.QueueTicketEvent.create({ ticketId: ticket.id, fromStatus: ticket.status, toStatus: "awaiting_review", actorUserId: p.userId, occurredAt: now });
      }
      await this.events.emit(tx, { eventType: "doctor.review_requested", aggregateType: "encounter", aggregateId: enc.id, hubId: enc.hubId, sessionId: enc.sessionId, correlationId: p.correlationId, payload: { encounterId: enc.id, alertCount: reviewAlerts.length } });
      for (const userId of await this.ctx.doctorsForHub(tx, enc.hubId)) {
        await this.notifications.enqueue(tx, { template: "staff.review_requested", userId, deepLink: `healora-team://review/${enc.id}`, relatedType: "encounter", relatedId: enc.id });
      }
      await this.audit.record(p, { action: "encounter.submit", targetType: "encounter", targetId: enc.id, hubId: enc.hubId, patientId: enc.patientId, metadata: { reviewRequested: true } }, tx);
      return { encounterId: enc.id, status: "submitted_for_review", reviewRequested: true, submittedAt: now };
    });
  }

  async escalate(p: StaffPrincipal, encounterId: string, input: { type: "emergency" | "urgent_clinical" | "referral" | "operational"; notes?: string; contactedName?: string; referralFacility?: string; transportArranged?: boolean }) {
    const enc = found(await db.orm.clinical.Encounter.first({ id: encounterId }), "Encounter");
    // Anyone on the hub's care team may raise an escalation; it must never wait on assignment.
    const assigned = await db.orm.clinical.EncounterAssignment.where({ encounterId, userId: p.userId }).where((a) => a.status.in([...ACTIVE_ASSIGNMENT])).first();
    if (!assigned && !(await this.access.can(p, TEAM, { hubId: enc.hubId ?? undefined }))) {
      await this.access.require(p, TEAM, { hubId: enc.hubId ?? undefined }, "encounter.escalate");
    }
    const hub = enc.hubId
      ? await db.orm.hub.Hub.select("id", "managerUserId", "emergencyContactName", "emergencyContactPhone", "nearestReferralFacility", "referralFacilityPhone", "referralInstructions").first({ id: enc.hubId })
      : null;
    const result = await db.transaction(async (tx) => {
      const now = nowIso();
      const esc = await tx.orm.clinical.EncounterEscalation.create({
        encounterId,
        type: input.type,
        raisedById: p.userId,
        raisedAt: now,
        contactedName: input.contactedName ?? null,
        referralFacility: input.referralFacility ?? null,
        transportArranged: input.transportArranged ?? false,
        notes: input.notes ?? null,
      });
      if (canTransition("encounter", enc.status, "escalated")) await tx.orm.clinical.Encounter.where({ id: enc.id }).update({ status: "escalated", version: enc.version + 1 });
      await this.events.emit(tx, { eventType: "encounter.updated", aggregateType: "encounter", aggregateId: enc.id, hubId: enc.hubId, sessionId: enc.sessionId, correlationId: p.correlationId, payload: { encounterId: enc.id, status: "escalated", escalationId: esc.id, escalationType: input.type } });
      if (hub?.managerUserId) await this.notifications.enqueue(tx, { template: "staff.exception_raised", userId: hub.managerUserId, serviceCritical: true, relatedType: "encounter", relatedId: enc.id });
      for (const userId of await this.ctx.doctorsForHub(tx, enc.hubId)) {
        await this.notifications.enqueue(tx, { template: "staff.review_requested", userId, serviceCritical: true, deepLink: `healora-team://review/${enc.id}`, relatedType: "encounter", relatedId: enc.id });
      }
      await this.audit.record(p, { action: "encounter.escalate", targetType: "encounter", targetId: enc.id, hubId: enc.hubId, patientId: enc.patientId, priority: "high", metadata: { type: input.type, escalationId: esc.id } }, tx);
      return esc;
    });
    return {
      escalation: result,
      emergencyInstructions: hub
        ? { emergencyContactName: hub.emergencyContactName, emergencyContactPhone: hub.emergencyContactPhone, nearestReferralFacility: hub.nearestReferralFacility, referralFacilityPhone: hub.referralFacilityPhone, referralInstructions: hub.referralInstructions }
        : null,
    };
  }

  /** Close an escalation with a handover note; optionally resume capture. */
  async closeEscalation(p: StaffPrincipal, escalationId: string, input: { handoverNote: string; resume: boolean }) {
    const esc = found(await db.orm.clinical.EncounterEscalation.first({ id: escalationId }), "Escalation");
    if (esc.closedAt) throw conflict("ALREADY_CLOSED", "Escalation is already closed");
    const enc = found(await db.orm.clinical.Encounter.first({ id: esc.encounterId }), "Encounter");
    const lead = await this.ctx.isSessionLead(db, p.userId, enc.sessionId);
    if (!lead && !(this.ctx.isDoctor(p) && (await this.access.can(p, DOCTORS, { hubId: enc.hubId ?? undefined })))) throw forbidden("Only the session team lead or a responsible doctor can close an escalation");
    return db.transaction(async (tx) => {
      const now = nowIso();
      await tx.orm.clinical.EncounterEscalation.where({ id: esc.id }).update({ closedAt: now, closedById: p.userId, handoverAt: esc.handoverAt ?? now, handoverNote: input.handoverNote });
      const stillOpen = await tx.orm.clinical.EncounterEscalation.where({ encounterId: enc.id }).where((e) => e.closedAt.isNull()).first();
      if (input.resume && !stillOpen && enc.status === "escalated" && enc.identityMatchStatus === "confirmed") {
        await tx.orm.clinical.Encounter.where({ id: enc.id }).update({ status: "in_progress", version: enc.version + 1 });
      }
      await this.audit.record(p, { action: "encounter.escalation_close", targetType: "encounter", targetId: enc.id, hubId: enc.hubId, patientId: enc.patientId, metadata: { escalationId: esc.id, resume: input.resume } }, tx);
      return { escalationId: esc.id, closedAt: now, encounterResumed: input.resume && !stillOpen && enc.status === "escalated" };
    });
  }
}

