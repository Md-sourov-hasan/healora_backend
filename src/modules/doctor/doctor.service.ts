import { Inject, Injectable } from "@nestjs/common";

import { AccessService } from "../../common/access.service.ts";
import { AuditService } from "../../common/audit.service.ts";
import type { StaffPrincipal } from "../../common/auth/principal.ts";
import { db, nowIso } from "../../common/db.ts";
import { badRequest, conflict, forbidden, found } from "../../common/errors.ts";
import { EventsService } from "../../common/events.service.ts";
import { NotificationService } from "../../common/notification.service.ts";
import { DOCTORS } from "../../common/roles.ts";
import { canTransition, isTerminal } from "../../common/workflow.ts";
import { ClinicalContextService } from "../clinical-core/clinical-context.service.ts";
import { type Disposition, EncounterCompletionService } from "../clinical-core/encounter-completion.service.ts";

type Decision = "reviewed_no_action" | "remeasurement_requested" | "follow_up" | "teleconsult" | "referral" | "urgent_review";
const SEVERITY_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };

@Injectable()
export class DoctorService {
  constructor(
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(EventsService) private readonly events: EventsService,
    @Inject(NotificationService) private readonly notifications: NotificationService,
    @Inject(ClinicalContextService) private readonly ctx: ClinicalContextService,
    @Inject(EncounterCompletionService) private readonly completion: EncounterCompletionService,
  ) {}

  private requireDoctor(p: StaffPrincipal) {
    if (!this.ctx.isDoctor(p)) throw forbidden("Doctor role required");
    return this.ctx.doctorRole(p)!;
  }

  /** Encounters awaiting review in my hubs plus ones assigned to me, most severe first. */
  async reviewQueue(p: StaffPrincipal, hubId?: string) {
    this.requireDoctor(p);
    const scope = await this.access.hubScope(p, DOCTORS);
    if (hubId) this.access.assertInScope(scope, hubId);
    const statuses = ["submitted_for_review", "escalated", "awaiting_remeasurement"];
    const inScope =
      scope === "all" || scope.length
        ? await db.orm.clinical.Encounter.select("id", "patientId", "hubId", "sessionId", "status", "submittedAt", "openedAt")
            .where((e) => e.status.in(statuses as never))
            .where((e) => (hubId ? e.hubId.eq(hubId) : scope === "all" ? e.hubId.isNotNull() : e.hubId.in(scope)))
            .limit(500)
            .all()
        : [];
    const mineAssigned = await db.orm.clinical.EncounterAssignment.select("encounterId").where({ userId: p.userId }).where((a) => a.status.in(["assigned", "accepted", "started"])).all();
    const extraIds = mineAssigned.map((a) => a.encounterId).filter((id) => !inScope.some((e) => e.id === id));
    const extra = extraIds.length
      ? await db.orm.clinical.Encounter.select("id", "patientId", "hubId", "sessionId", "status", "submittedAt", "openedAt").where((e) => e.id.in(extraIds)).where((e) => e.status.in(statuses as never)).all()
      : [];
    const encounters = [...inScope, ...extra];
    if (!encounters.length) return [];

    const ids = encounters.map((e) => e.id);
    const alerts = await db.orm.clinical.ObservationAlert.select("encounterId", "severity", "action").where((a) => a.encounterId.in(ids)).where((a) => a.status.in(["open", "acknowledged"])).all();
    const hubs = await db.orm.hub.Hub.select("id", "code", "name").where((h) => h.id.in([...new Set(encounters.map((e) => e.hubId).filter((x): x is string => !!x))])).all();
    const rows = [];
    for (const e of encounters) {
      const mine = alerts.filter((a) => a.encounterId === e.id);
      const top = mine.reduce((m, a) => Math.max(m, SEVERITY_RANK[a.severity] ?? 0), 0);
      const pt = await this.ctx.minimalPatient(db, e.patientId);
      rows.push({
        encounterId: e.id,
        status: e.status,
        submittedAt: e.submittedAt,
        openedAt: e.openedAt,
        hub: hubs.find((h) => h.id === e.hubId) ?? null,
        patient: pt ? { healoraCode: pt.healoraCode, fullName: pt.fullName, sex: pt.sex, ageYears: pt.ageYears } : null,
        openAlerts: mine.length,
        topSeverity: Object.entries(SEVERITY_RANK).find(([, r]) => r === top)?.[0] ?? null,
        _rank: top,
      });
    }
    rows.sort((a, b) => b._rank - a._rank || String(a.submittedAt ?? a.openedAt).localeCompare(String(b.submittedAt ?? b.openedAt)));
    return rows.map(({ _rank, ...r }) => r);
  }

  /** Full clinical view of one encounter with provenance (audited medical-data access). */
  async encounterView(p: StaffPrincipal, encounterId: string) {
    this.requireDoctor(p);
    const { encounter: enc } = await this.access.requireEncounterAccess(p, encounterId, "review");
    const observations = await db.orm.clinical.Observation.where({ encounterId })
      .include("performer", (u) => u.select("id", "name"))
      .include("equipment", (e) => e.select("id", "assetTag", "category", "make", "model"))
      .include("definition", (d) => d.select("code", "name", "nameBn", "canonicalUnit"))
      .orderBy([(o) => o.observationCode.asc(), (o) => o.measuredAt.asc()])
      .all();
    const alerts = await db.orm.clinical.ObservationAlert.where({ encounterId }).include("alertRule", (r) => r.select("code", "messageEn", "messageBn", "condition")).all();
    const notes = await db.orm.clinical.ClinicalNote.where({ encounterId }).include("author", (u) => u.select("id", "name")).orderBy((n) => n.createdAt.asc()).all();
    const reviews = await db.orm.clinical.ClinicalReview.where({ encounterId }).include("reviewer", (u) => u.select("id", "name")).orderBy((r) => r.signedAt.asc()).all();
    const tasks = await db.orm.clinical.EncounterTask.select("observationCode", "required", "status", "missingReason", "missingNote", "completedAt").where({ encounterId }).all();
    const remeasurements = await db.orm.clinical.RemeasurementRequest.where({ encounterId }).all();
    const escalations = await db.orm.clinical.EncounterEscalation.where({ encounterId }).all();
    const hub = enc.hubId ? await db.orm.hub.Hub.select("id", "code", "name").first({ id: enc.hubId }) : null;
    await this.audit.record(p, { action: "encounter.clinical.read", targetType: "encounter", targetId: encounterId, hubId: enc.hubId, patientId: enc.patientId });
    return {
      encounter: enc,
      hub,
      patient: await this.ctx.minimalPatient(db, enc.patientId),
      consent: await this.ctx.consentStatus(db, enc.patientId),
      observations: observations.map((o) => ({
        ...o,
        provenance: {
          performer: o.performer,
          performerRole: o.performerRole,
          device: o.equipment,
          deviceAttributionMissingReason: o.deviceAttributionMissingReason,
          measuredAt: o.measuredAt,
          clientRecordedAt: o.clientRecordedAt,
          serverReceivedAt: o.serverReceivedAt,
          sourceType: o.sourceType,
          repeatOfId: o.repeatOfId,
          supersedesId: o.supersedesId,
        },
      })),
      alerts,
      tasks,
      notes,
      reviews,
      remeasurements,
      escalations,
    };
  }

  async review(
    p: StaffPrincipal,
    encounterId: string,
    input: { decision: Decision; summary?: string; remeasure?: { observationCode: string; reason: string; priorObservationId?: string }[]; supersedesId?: string; amendmentReason?: string },
  ) {
    const role = this.requireDoctor(p);
    const { encounter: enc0 } = await this.access.requireEncounterAccess(p, encounterId, "review");
    const cred = await this.ctx.requireCredential(db, p.userId);
    if (isTerminal("encounter", enc0.status) && !input.supersedesId) throw conflict("ENCOUNTER_CLOSED", "Encounter is closed; amend an existing review instead");
    if (input.decision === "remeasurement_requested" && !input.remeasure?.length) throw badRequest("REMEASURE_REQUIRED", "List the measurements to repeat");
    if (input.supersedesId) {
      const prev = found(await db.orm.clinical.ClinicalReview.first({ id: input.supersedesId }), "Review");
      if (prev.encounterId !== encounterId) throw badRequest("REVIEW_MISMATCH", "Amended review belongs to another encounter");
      if (!input.amendmentReason) throw badRequest("REASON_REQUIRED", "amendmentReason is required");
    }

    return db.transaction(async (tx) => {
      const enc = found(await tx.orm.clinical.Encounter.where({ id: encounterId }).forNoKeyUpdate().first(), "Encounter");
      const now = nowIso();
      const review = await tx.orm.clinical.ClinicalReview.create({
        encounterId,
        reviewerId: p.userId,
        reviewerRole: role,
        credentialId: cred.id,
        decision: input.decision,
        summary: input.summary ?? null,
        signedAt: now,
        supersedesId: input.supersedesId ?? null,
        amendmentReason: input.amendmentReason ?? null,
      });

      let status = enc.status;
      if (input.decision === "remeasurement_requested") {
        for (const r of input.remeasure!) {
          const def = await tx.orm.clinical.ObservationDefinition.where({ code: r.observationCode, status: "active" }).first();
          if (!def) throw badRequest("UNKNOWN_OBSERVATION", `Unknown observation code '${r.observationCode}'`);
          await tx.orm.clinical.RemeasurementRequest.create({ encounterId, observationCode: r.observationCode, priorObservationId: r.priorObservationId ?? null, reason: r.reason, requestedById: p.userId, requestedAt: now });
          const task = await tx.orm.clinical.EncounterTask.where({ encounterId, observationCode: r.observationCode }).first();
          if (task) await tx.orm.clinical.EncounterTask.where({ id: task.id }).update({ status: "pending", missingReason: null, missingNote: null, completedAt: null, completedById: null });
          else await tx.orm.clinical.EncounterTask.create({ encounterId, observationCode: r.observationCode, required: true });
        }
        if (canTransition("encounter", enc.status, "awaiting_remeasurement")) status = "awaiting_remeasurement";
        const workers = await tx.orm.clinical.EncounterAssignment.select("userId").where({ encounterId }).where((a) => a.status.in(["assigned", "accepted", "started"])).all();
        for (const w of workers) {
          await this.notifications.enqueue(tx, { template: "staff.remeasurement_requested", userId: w.userId, deepLink: `healora-team://encounters/${encounterId}`, relatedType: "encounter", relatedId: encounterId });
        }
        const ticket = await tx.orm.hub.QueueTicket.where({ encounterId }).forNoKeyUpdate().first();
        if (ticket && canTransition("queue", ticket.status, "in_service")) {
          await tx.orm.hub.QueueTicket.where({ id: ticket.id }).update({ status: "in_service", version: ticket.version + 1 });
          await tx.orm.hub.QueueTicketEvent.create({ ticketId: ticket.id, fromStatus: ticket.status, toStatus: "in_service", actorUserId: p.userId, reason: "remeasurement requested", occurredAt: now });
        }
      } else if (canTransition("encounter", enc.status, "reviewed")) {
        status = "reviewed";
        await tx.orm.clinical.Observation.where({ encounterId, reviewStatus: "pending" }).updateAll({ reviewStatus: "reviewed" });
      }
      if (status !== enc.status) await tx.orm.clinical.Encounter.where({ id: encounterId }).update({ status, reviewedAt: status === "reviewed" ? now : enc.reviewedAt, version: enc.version + 1 });

      await this.events.emit(tx, { eventType: "doctor.review_completed", aggregateType: "encounter", aggregateId: encounterId, hubId: enc.hubId, sessionId: enc.sessionId, correlationId: p.correlationId, payload: { encounterId, reviewId: review.id, decision: input.decision, status } });
      await this.audit.record(p, { action: input.supersedesId ? "clinical_review.amend" : "clinical_review.create", targetType: "clinical_review", targetId: review.id, hubId: enc.hubId, patientId: enc.patientId, reason: input.amendmentReason ?? null, actorRole: role, metadata: { encounterId, decision: input.decision } }, tx);
      return { review, encounterStatus: status };
    });
  }

  async updateAlert(p: StaffPrincipal, alertId: string, action: "acknowledge" | "resolve", note?: string) {
    this.requireDoctor(p);
    const alert = found(await db.orm.clinical.ObservationAlert.first({ id: alertId }), "Alert");
    const { encounter: enc } = await this.access.requireEncounterAccess(p, alert.encounterId, "review");
    if (alert.status === "resolved") throw conflict("ALREADY_RESOLVED", "Alert is already resolved");
    if (action === "resolve" && !note) throw badRequest("REASON_REQUIRED", "resolutionNote is required");
    if (action === "acknowledge" && alert.status !== "open") throw conflict("INVALID_TRANSITION", "Alert is already acknowledged");
    return db.transaction(async (tx) => {
      const now = nowIso();
      const row =
        action === "acknowledge"
          ? await tx.orm.clinical.ObservationAlert.where({ id: alertId }).update({ status: "acknowledged", acknowledgedById: p.userId, acknowledgedAt: now })
          : await tx.orm.clinical.ObservationAlert.where({ id: alertId }).update({ status: "resolved", resolvedById: p.userId, resolvedAt: now, resolutionNote: note!, acknowledgedById: alert.acknowledgedById ?? p.userId, acknowledgedAt: alert.acknowledgedAt ?? now });
      await this.audit.record(p, { action: `observation_alert.${action}`, targetType: "observation_alert", targetId: alertId, hubId: enc.hubId, patientId: enc.patientId, reason: note ?? null }, tx);
      await this.events.emit(tx, { eventType: "encounter.updated", aggregateType: "encounter", aggregateId: enc.id, hubId: enc.hubId, sessionId: enc.sessionId, payload: { encounterId: enc.id, alertId, alertStatus: action === "acknowledge" ? "acknowledged" : "resolved" } });
      return row;
    });
  }

  async addNote(p: StaffPrincipal, encounterId: string, input: { noteType: "clinical_assessment" | "follow_up_instruction"; content: string; language: "bn" | "en"; patientVisible: boolean }) {
    const role = this.requireDoctor(p);
    const { encounter: enc } = await this.access.requireEncounterAccess(p, encounterId, "review");
    const cred = await this.ctx.requireCredential(db, p.userId);
    if (input.patientVisible && input.noteType !== "follow_up_instruction") throw badRequest("NOT_PATIENT_VISIBLE", "Only follow-up instructions can be shown to the patient");
    return db.transaction(async (tx) => {
      const note = await tx.orm.clinical.ClinicalNote.create({ encounterId, authorId: p.userId, authorRole: role, credentialId: cred.id, noteType: input.noteType, content: input.content, language: input.language, patientVisible: input.patientVisible, signedAt: nowIso() });
      await this.audit.record(p, { action: "clinical_note.create", targetType: "clinical_note", targetId: note.id, hubId: enc.hubId, patientId: enc.patientId, metadata: { noteType: input.noteType, patientVisible: input.patientVisible } }, tx);
      return note;
    });
  }

  async amendNote(p: StaffPrincipal, noteId: string, input: { content: string; amendmentReason: string; patientVisible?: boolean }) {
    const role = this.requireDoctor(p);
    const prev = found(await db.orm.clinical.ClinicalNote.first({ id: noteId }), "Note");
    if (prev.authorId !== p.userId) throw forbidden("Only the author can amend a note");
    const already = await db.orm.clinical.ClinicalNote.select("id").where({ amendsId: noteId }).first();
    if (already) throw conflict("ALREADY_AMENDED", "Amend the latest version of this note");
    const { encounter: enc } = await this.access.requireEncounterAccess(p, prev.encounterId, "review");
    const cred = await this.ctx.requireCredential(db, p.userId);
    return db.transaction(async (tx) => {
      const note = await tx.orm.clinical.ClinicalNote.create({
        encounterId: prev.encounterId,
        authorId: p.userId,
        authorRole: role,
        credentialId: cred.id,
        noteType: prev.noteType,
        content: input.content,
        language: prev.language,
        patientVisible: input.patientVisible ?? prev.patientVisible,
        signedAt: nowIso(),
        amendsId: prev.id,
        amendmentReason: input.amendmentReason,
      });
      await this.audit.record(p, { action: "clinical_note.amend", targetType: "clinical_note", targetId: note.id, hubId: enc.hubId, patientId: enc.patientId, reason: input.amendmentReason, metadata: { amendsId: prev.id } }, tx);
      return note;
    });
  }

  async close(p: StaffPrincipal, encounterId: string, input: { disposition: Disposition; reason?: string }) {
    this.requireDoctor(p);
    await this.access.requireEncounterAccess(p, encounterId, "review");
    await this.ctx.requireCredential(db, p.userId);
    return db.transaction((tx) => this.completion.complete(tx, p, encounterId, input.disposition, { doctorOverride: true, reason: input.reason }));
  }

  /** Canonical vitals timeline across all encounters/hubs (PRD §12.6 rules 12–13). */
  async timeline(p: StaffPrincipal, patientId: string, q: { code?: string; includeHistory: boolean; limit: number; offset: number }) {
    this.requireDoctor(p);
    await this.access.requirePatientClinicalAccess(p, patientId);
    const statuses = q.includeHistory ? ["final", "amended", "superseded", "entered_in_error", "preliminary"] : ["final", "amended"];
    let query = db.orm.clinical.Observation.where({ patientId }).where((o) => o.status.in(statuses as never));
    if (q.code) query = query.where({ observationCode: q.code });
    const rows = await query
      .include("hub", (h) => h.select("id", "code", "name"))
      .include("performer", (u) => u.select("id", "name"))
      .orderBy([(o) => o.measuredAt.desc(), (o) => o.id.desc()])
      .limit(q.limit)
      .offset(q.offset)
      .all();
    await this.audit.record(p, { action: "patient.timeline.read", targetType: "patient", targetId: patientId, patientId, metadata: { code: q.code ?? null, includeHistory: q.includeHistory } });
    return {
      patient: await this.ctx.minimalPatient(db, patientId),
      items: rows.map((o) => ({
        id: o.id,
        encounterId: o.encounterId,
        observationCode: o.observationCode,
        valueNumeric: o.valueNumeric,
        valueCode: o.valueCode,
        valueText: o.valueText,
        unit: o.unit,
        context: o.context,
        method: o.method,
        bodySite: o.bodySite,
        measuredAt: o.measuredAt,
        serverReceivedAt: o.serverReceivedAt,
        status: o.status,
        validationStatus: o.validationStatus,
        reviewStatus: o.reviewStatus,
        isDerived: o.isDerived,
        supersedesId: o.supersedesId,
        repeatOfId: o.repeatOfId,
        source: { type: o.sourceType, hub: o.hub, performer: o.performer, performerRole: o.performerRole },
      })),
      limit: q.limit,
      offset: q.offset,
    };
  }
}
