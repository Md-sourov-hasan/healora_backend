import { Inject, Injectable } from "@nestjs/common";

import { AuditService } from "../../common/audit.service.ts";
import type { StaffPrincipal } from "../../common/auth/principal.ts";
import { db, nowIso, type Tx } from "../../common/db.ts";
import { conflict, found, unprocessable } from "../../common/errors.ts";
import { EventsService } from "../../common/events.service.ts";
import { NotificationService } from "../../common/notification.service.ts";
import { CAPTURE, CREDENTIALED, type StaffRole } from "../../common/roles.ts";
import { assertTransition, isTerminal } from "../../common/workflow.ts";
import { dhakaDate } from "../../common/db.ts";
import { PatientsService } from "../patients/patients.service.ts";

const CHECK_IN_SESSION_STATUSES = ["published", "open_for_booking", "full", "in_progress", "paused"];

@Injectable()
export class FrontdeskService {
  constructor(
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(EventsService) private readonly events: EventsService,
    @Inject(NotificationService) private readonly notifications: NotificationService,
    @Inject(PatientsService) private readonly patients: PatientsService,
  ) {}

  /**
   * Check-in (PRD §9.4–9.5): confirm identity, open the hub encounter with its
   * protocol checklist, and issue a queue token — atomically. Idempotent.
   */
  async checkInTx(tx: Tx, p: StaffPrincipal, appointmentId: string) {
    const appt = found(await tx.orm.hub.Appointment.where({ id: appointmentId }).forNoKeyUpdate().first(), "Appointment");

    if (appt.status === "checked_in" || appt.status === "in_service") {
      const encounter = await tx.orm.clinical.Encounter.select("id", "status").where({ appointmentId }).first();
      const ticket = encounter ? await tx.orm.hub.QueueTicket.where({ encounterId: encounter.id }).first() : null;
      if (encounter && ticket) return { appointment: appt, encounter, ticket, alreadyCheckedIn: true };
    }
    assertTransition("appointment", appt.status, "checked_in");

    const patient = found(await tx.orm.clinical.Patient.select("id", "status").first({ id: appt.patientId }), "Patient");
    if (patient.status !== "active") throw conflict("PATIENT_NOT_ACTIVE", "Patient record is not active (merged or inactive)");
    if (await this.patients.openDuplicateFor(patient.id, tx)) {
      throw conflict("IDENTITY_UNRESOLVED", "This patient has an unresolved possible-duplicate record; resolve it before check-in");
    }

    // Session lock also serialises ticket numbering.
    const session = found(await tx.orm.hub.HubSession.where({ id: appt.sessionId }).forNoKeyUpdate().first(), "Session");
    if (!CHECK_IN_SESSION_STATUSES.includes(session.status)) throw conflict("SESSION_NOT_ACTIVE", `Session is ${session.status}`);
    if (session.sessionDate !== dhakaDate() && process.env.ALLOW_OFF_DAY_CHECKIN !== "true") {
      throw conflict("NOT_SESSION_DAY", "Check-in is only possible on the session day");
    }
    const serviceType = found(await tx.orm.hub.ServiceType.first({ id: appt.serviceTypeId }), "Service type");
    const protocolId = session.protocolId ?? serviceType.protocolId;

    const now = nowIso();
    const encounter = await tx.orm.clinical.Encounter.create({
      patientId: appt.patientId,
      encounterType: "hub_visit",
      hubId: appt.hubId,
      sessionId: appt.sessionId,
      appointmentId: appt.id,
      serviceTypeId: appt.serviceTypeId,
      protocolId,
      status: "created",
      identityMatchStatus: "confirmed",
      identityConfirmedById: p.userId,
      identityConfirmedAt: now,
      requiresDoctorReview: serviceType.requiresDoctorReview,
      openedAt: now,
    });

    let taskCount = 0;
    if (protocolId) {
      const items = await tx.orm.clinical.ProtocolObservation.where({ protocolId }).orderBy((o) => o.sortOrder.asc()).all();
      for (const item of items) {
        await tx.orm.clinical.EncounterTask.create({ encounterId: encounter.id, observationCode: item.observationCode, required: item.required });
        taskCount++;
      }
    }

    const last = await tx.orm.hub.QueueTicket.where({ sessionId: session.id }).aggregate((a) => ({ max: a.max("ticketNumber") }));
    const ticketNumber = (last.max ?? 0) + 1;
    const ticket = await tx.orm.hub.QueueTicket.create({
      encounterId: encounter.id,
      appointmentId: appt.id,
      hubId: appt.hubId,
      sessionId: session.id,
      ticketNumber,
      displayCode: `${appt.isWalkIn ? "W" : "A"}-${String(ticketNumber).padStart(3, "0")}`,
      status: "waiting",
      issuedAt: now,
    });
    await tx.orm.hub.QueueTicketEvent.create({ ticketId: ticket.id, toStatus: "waiting", actorUserId: p.userId, occurredAt: now, reason: "checked in" });

    const updated = await tx.orm.hub.Appointment.where({ id: appt.id }).update({
      status: "checked_in",
      arrivedAt: appt.arrivedAt ?? now,
      checkedInAt: now,
      checkedInById: p.userId,
      version: appt.version + 1,
    });

    await this.audit.record(p, { action: "patient.checked_in", targetType: "appointment", targetId: appt.id, hubId: appt.hubId, patientId: appt.patientId, metadata: { encounterId: encounter.id, ticketId: ticket.id, tasks: taskCount } }, tx);
    await this.events.emit(tx, {
      eventType: "patient.checked_in",
      aggregateType: "encounter",
      aggregateId: encounter.id,
      hubId: appt.hubId,
      sessionId: session.id,
      correlationId: p.correlationId,
      payload: { appointmentId: appt.id, encounterId: encounter.id, patientId: appt.patientId, ticketId: ticket.id, displayCode: ticket.displayCode },
    });
    await this.notifications.enqueue(tx, {
      template: "patient.checked_in",
      patientId: appt.patientId,
      relatedType: "queue_ticket",
      relatedId: ticket.id,
      deepLink: `healora://visits/${encounter.id}`,
      serviceCritical: true,
    });
    return { appointment: updated, encounter: { id: encounter.id, status: encounter.status }, ticket, alreadyCheckedIn: false };
  }

  /**
   * Assign or reassign an encounter's operational task (PRD §8.10). The target
   * must be rostered on the session in a capture role and, for credentialed
   * roles, hold a verified, unexpired credential for that role.
   */
  async assign(p: StaffPrincipal, encounterId: string, input: { userId: string; role: StaffRole; stationId?: string | null; reason?: string | null }) {
    if (!CAPTURE.includes(input.role)) throw unprocessable("ROLE_NOT_ASSIGNABLE", "Role cannot take encounter assignments");
    return db.transaction(async (tx) => {
      const enc = found(await tx.orm.clinical.Encounter.where({ id: encounterId }).forNoKeyUpdate().first(), "Encounter");
      if (isTerminal("encounter", enc.status)) throw conflict("ENCOUNTER_CLOSED", `Encounter is ${enc.status}`);
      if (enc.identityMatchStatus !== "confirmed") throw conflict("IDENTITY_UNRESOLVED", "Patient identity is not confirmed");
      if (!enc.sessionId || !enc.hubId) throw conflict("NO_SESSION", "Encounter has no hub session");

      const user = found(await tx.orm.identity.User.select("id", "status").first({ id: input.userId }), "User");
      if (user.status !== "active") throw conflict("USER_NOT_ACTIVE", "Staff member is not active");

      const now = nowIso();
      const shift = await tx.orm.hub.StaffShift.where({ userId: input.userId, sessionId: enc.sessionId, role: input.role })
        .where((s) => s.status.in(["approved", "checked_in"]))
        .first();
      if (!shift) throw conflict("NOT_ROSTERED", "Staff member has no approved shift on this session in that role");

      if (CREDENTIALED.includes(input.role)) {
        const today = dhakaDate();
        const creds = await tx.orm.identity.StaffCredential.where({ userId: input.userId, status: "verified" }).all();
        const valid = creds.some((c) => (c.qualifiesForRoles as string[]).includes(input.role) && (!c.expiresAt || c.expiresAt >= today));
        if (!valid) throw conflict("CREDENTIAL_REQUIRED", "Staff member has no verified, unexpired credential for this role");
      }

      if (input.stationId) {
        const station = await tx.orm.hub.HubStation.select("hubId", "status").first({ id: input.stationId });
        if (!station || station.hubId !== enc.hubId) throw unprocessable("INVALID_STATION", "Station does not belong to this hub");
        if (station.status === "out_of_service") throw conflict("STATION_OUT_OF_SERVICE", "Station is out of service");
      }

      const current = await tx.orm.clinical.EncounterAssignment.where({ encounterId })
        .where((a) => a.status.in(["assigned", "accepted", "started"]))
        .all();
      if (current.some((a) => a.userId === input.userId && a.role === input.role)) {
        throw conflict("ALREADY_ASSIGNED", "Encounter is already assigned to this staff member");
      }

      const created = await tx.orm.clinical.EncounterAssignment.create({
        encounterId,
        userId: input.userId,
        role: input.role,
        stationId: input.stationId ?? null,
        status: "assigned",
        assignedById: p.userId,
        assignedAt: now,
        reason: input.reason ?? null,
      });
      for (const old of current) {
        await tx.orm.clinical.EncounterAssignment.where({ id: old.id }).update({ status: "transferred", endedAt: now, transferredToId: created.id, reason: input.reason ?? "reassigned" });
      }

      if (enc.status === "created" || enc.status === "assigned") {
        assertTransition("encounter", enc.status, "assigned");
        await tx.orm.clinical.Encounter.where({ id: encounterId }).update({ status: "assigned", version: enc.version + 1 });
      }

      await this.audit.record(p, {
        action: current.length ? "encounter.reassigned" : "encounter.assigned",
        targetType: "encounter",
        targetId: encounterId,
        hubId: enc.hubId,
        patientId: enc.patientId,
        reason: input.reason ?? null,
        metadata: { assigneeUserId: input.userId, role: input.role, previous: current.map((c) => c.userId) },
      }, tx);
      await this.events.emit(tx, {
        eventType: "encounter.assigned",
        aggregateType: "encounter",
        aggregateId: encounterId,
        hubId: enc.hubId,
        sessionId: enc.sessionId,
        correlationId: p.correlationId,
        payload: {
          hub_id: enc.hubId,
          session_id: enc.sessionId,
          appointment_id: enc.appointmentId,
          encounter_id: encounterId,
          patient_id: enc.patientId,
          assigned_staff_user_id: input.userId,
          assignment_role: input.role,
          team_assignment_id: created.id,
        },
      });
      await this.notifications.enqueue(tx, {
        template: "staff.encounter_assigned",
        userId: input.userId,
        relatedType: "encounter",
        relatedId: encounterId,
        deepLink: `healora-team://encounters/${encounterId}`,
      });
      return created;
    });
  }
}
