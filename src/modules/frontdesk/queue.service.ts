import { Inject, Injectable } from "@nestjs/common";

import { AuditService } from "../../common/audit.service.ts";
import type { StaffPrincipal } from "../../common/auth/principal.ts";
import { db, minutesBetween, nowIso } from "../../common/db.ts";
import { conflict, found, unprocessable } from "../../common/errors.ts";
import { EventsService } from "../../common/events.service.ts";
import { ACTIVE_QUEUE_STATUSES, assertTransition } from "../../common/workflow.ts";
import { queuePatient } from "../patients/patient-view.ts";

export type QueueAction =
  | { kind: "call" }
  | { kind: "start" }
  | { kind: "transfer"; stationId: string; reason?: string }
  | { kind: "pause"; reason?: string }
  | { kind: "resume" }
  | { kind: "delay"; delayReason: DelayReason | null }
  | { kind: "cancel"; reason: string }
  | { kind: "no_show"; reason?: string }
  | { kind: "priority"; policyId: string }
  | { kind: "complete" }
  | { kind: "reopen"; reason: string };

export type DelayReason = "station_unavailable" | "staff_unavailable" | "sync_pending" | "equipment_issue" | "high_volume" | "other";

const TARGET: Partial<Record<QueueAction["kind"], string>> = {
  call: "called",
  start: "in_service",
  transfer: "transferred",
  pause: "paused",
  resume: "waiting",
  cancel: "cancelled",
  no_show: "no_show",
  complete: "completed",
};

@Injectable()
export class QueueService {
  constructor(
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(EventsService) private readonly events: EventsService,
  ) {}

  /** Apply one operational queue action (PRD §12.5). Never touches clinical data. */
  async apply(p: StaffPrincipal, ticketId: string, action: QueueAction) {
    return db.transaction(async (tx) => {
      const t = found(await tx.orm.hub.QueueTicket.where({ id: ticketId }).forNoKeyUpdate().first(), "Queue ticket");
      const now = nowIso();
      const patch: Record<string, unknown> = { version: t.version + 1 };
      let to: string = t.status;
      let reason: string | null = null;
      let toStationId: string | null = null;

      switch (action.kind) {
        case "delay":
          patch.delayReason = action.delayReason;
          break;
        case "priority": {
          const policy = await tx.orm.hub.QueuePriorityPolicy.first({ id: action.policyId });
          if (!policy || policy.status !== "active") throw unprocessable("INVALID_POLICY", "Priority must use an active, approved queue policy");
          patch.priorityPolicyId = policy.id;
          patch.priorityLevel = policy.priorityLevel;
          reason = `policy ${policy.code} v${policy.version}`;
          break;
        }
        case "reopen": {
          if (!["completed", "no_show", "cancelled"].includes(t.status)) throw conflict("NOT_CLOSED", "Only a closed queue item can be reopened");
          const enc = await tx.orm.clinical.Encounter.select("status").first({ id: t.encounterId });
          if (enc && (enc.status === "completed" || enc.status === "unable_to_complete")) {
            throw conflict("ENCOUNTER_CLOSED", "The encounter is already closed; it cannot be reopened from the queue");
          }
          const session = await tx.orm.hub.HubSession.select("status").first({ id: t.sessionId });
          if (session && (session.status === "completed" || session.status === "cancelled")) throw conflict("SESSION_CLOSED", `Session is ${session.status}`);
          to = "waiting";
          reason = action.reason;
          patch.completedAt = null;
          break;
        }
        default: {
          to = TARGET[action.kind]!;
          assertTransition("queue", t.status, to);
          if (action.kind === "call") patch.calledAt = now;
          if (action.kind === "start") {
            patch.serviceStartedAt = t.serviceStartedAt ?? now;
            patch.delayReason = null;
            const appt = await tx.orm.hub.Appointment.where({ id: t.appointmentId }).forNoKeyUpdate().first();
            if (appt && appt.status === "checked_in") {
              await tx.orm.hub.Appointment.where({ id: appt.id }).update({ status: "in_service", version: appt.version + 1 });
            }
          }
          if (action.kind === "transfer") {
            const station = await tx.orm.hub.HubStation.select("id", "hubId", "status").first({ id: action.stationId });
            if (!station || station.hubId !== t.hubId) throw unprocessable("INVALID_STATION", "Station does not belong to this hub");
            if (station.status === "out_of_service" || station.status === "paused") throw conflict("STATION_UNAVAILABLE", `Station is ${station.status}`);
            patch.currentStationId = station.id;
            toStationId = station.id;
            reason = action.reason ?? null;
          }
          if (action.kind === "complete") {
            const enc = await tx.orm.clinical.Encounter.select("status").first({ id: t.encounterId });
            if (!enc || (enc.status !== "completed" && enc.status !== "unable_to_complete")) {
              throw conflict("ENCOUNTER_OPEN", "The encounter must be completed in the team app before the queue item is closed");
            }
            patch.completedAt = now;
          }
          if (action.kind === "cancel" || action.kind === "no_show" || action.kind === "pause") reason = (action as { reason?: string }).reason ?? null;
        }
      }
      patch.status = to;

      const updated = await tx.orm.hub.QueueTicket.where({ id: ticketId }).update(patch as never);
      await tx.orm.hub.QueueTicketEvent.create({
        ticketId,
        fromStatus: t.status,
        toStatus: to as typeof t.status,
        fromStationId: t.currentStationId,
        toStationId: toStationId ?? t.currentStationId,
        actorUserId: p.userId,
        reason: reason ?? (action.kind === "delay" ? `delay:${action.delayReason ?? "cleared"}` : null),
        occurredAt: now,
      });
      await this.audit.record(p, {
        action: `queue.${action.kind}`,
        targetType: "queue_ticket",
        targetId: ticketId,
        hubId: t.hubId,
        reason,
        priority: action.kind === "reopen" ? "high" : "normal",
        metadata: { from: t.status, to },
      }, tx);
      await this.events.emit(tx, {
        eventType: "queue.updated",
        aggregateType: "queue_ticket",
        aggregateId: ticketId,
        hubId: t.hubId,
        sessionId: t.sessionId,
        correlationId: p.correlationId,
        payload: { ticketId, encounterId: t.encounterId, from: t.status, to, stationId: patch.currentStationId ?? t.currentStationId, action: action.kind },
      });
      return updated;
    });
  }

  /** Staff queue view: operational state + minimal identifier, no clinical data. */
  async staffView(sessionId: string, includeClosed: boolean) {
    let q = db.orm.hub.QueueTicket.where({ sessionId });
    if (!includeClosed) q = q.where((t) => t.status.in([...ACTIVE_QUEUE_STATUSES]));
    const tickets = await q
      .include("currentStation", (s) => s.select("id", "name", "stationType"))
      .include("encounter", (e) => e.select("id", "status", "patientId").include("patient", (pt) => pt.select("healoraCode", "fullName")))
      .orderBy([(t) => t.priorityLevel.desc(), (t) => t.ticketNumber.asc()])
      .all();

    const encounterIds = tickets.map((t) => t.encounterId);
    const assignments = encounterIds.length
      ? await db.orm.clinical.EncounterAssignment.select("encounterId", "role", "status", "userId")
          .where((a) => a.encounterId.in(encounterIds))
          .where((a) => a.status.in(["assigned", "accepted", "started"]))
          .include("user", (u) => u.select("name"))
          .all()
      : [];
    const now = nowIso();
    let lastUpdated: string | null = null;
    const items = tickets.map((t) => {
      if (!lastUpdated || t.updatedAt > lastUpdated) lastUpdated = t.updatedAt;
      const enc = t.encounter;
      return {
        id: t.id,
        displayCode: t.displayCode,
        ticketNumber: t.ticketNumber,
        status: t.status,
        priorityLevel: t.priorityLevel,
        delayReason: t.delayReason,
        station: t.currentStation,
        issuedAt: t.issuedAt,
        calledAt: t.calledAt,
        serviceStartedAt: t.serviceStartedAt,
        waitingMinutes: minutesBetween(t.issuedAt, t.serviceStartedAt ?? now),
        encounter: enc ? { id: enc.id, status: enc.status } : null,
        patient: enc?.patient ? queuePatient(enc.patient) : null,
        assignedStaff: assignments.filter((a) => a.encounterId === t.encounterId).map((a) => ({ userId: a.userId, name: a.user?.name ?? null, role: a.role, status: a.status })),
      };
    });
    return { sessionId, lastUpdated: lastUpdated ?? now, generatedAt: now, items };
  }

  /** Shared display board: token, station, status, wait — nothing identifying (PRD §14.2). */
  async board(sessionId: string) {
    const tickets = await db.orm.hub.QueueTicket.where({ sessionId })
      .where((t) => t.status.in(["waiting", "called", "in_service", "awaiting_review", "transferred"]))
      .include("currentStation", (s) => s.select("name"))
      .orderBy([(t) => t.priorityLevel.desc(), (t) => t.ticketNumber.asc()])
      .all();
    const now = nowIso();
    const items = tickets.map((t) => ({
      displayCode: t.displayCode,
      station: t.currentStation?.name ?? null,
      status: t.status,
      waitingMinutes: minutesBetween(t.issuedAt, t.serviceStartedAt ?? now),
    }));
    const order = ["called", "in_service", "awaiting_review", "transferred", "waiting"];
    items.sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
    return { generatedAt: now, nowServing: items.filter((i) => i.status === "called" || i.status === "in_service"), items };
  }
}
