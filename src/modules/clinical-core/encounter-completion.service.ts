import { Inject, Injectable } from "@nestjs/common";

import { AuditService } from "../../common/audit.service.ts";
import type { StaffPrincipal } from "../../common/auth/principal.ts";
import { nowIso, type Tx } from "../../common/db.ts";
import { conflict, notFound } from "../../common/errors.ts";
import { EventsService } from "../../common/events.service.ts";
import { NotificationService } from "../../common/notification.service.ts";
import { canTransition, isTerminal } from "../../common/workflow.ts";

export type Disposition = "completed" | "follow_up_required" | "referred" | "unable_to_complete";

const ENCOUNTER_TARGET: Record<Disposition, "completed" | "referred" | "unable_to_complete"> = {
  completed: "completed",
  follow_up_required: "completed",
  referred: "referred",
  unable_to_complete: "unable_to_complete",
};
const APPOINTMENT_TARGET: Record<Disposition, "completed" | "referred" | "unable_to_complete"> = {
  completed: "completed",
  follow_up_required: "completed",
  referred: "referred",
  unable_to_complete: "unable_to_complete",
};
const QUEUE_TARGET: Record<Disposition, "completed" | "referred"> = {
  completed: "completed",
  follow_up_required: "completed",
  referred: "referred",
  unable_to_complete: "completed",
};

/**
 * Closes an encounter and everything operational hanging off it (PRD §9.7
 * step 6, §12.4). `doctorOverride` lets an authorised clinician close from
 * any open state; otherwise the encounter state machine applies.
 */
@Injectable()
export class EncounterCompletionService {
  constructor(
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(EventsService) private readonly events: EventsService,
    @Inject(NotificationService) private readonly notifications: NotificationService,
  ) {}

  async complete(tx: Tx, p: StaffPrincipal, encounterId: string, disposition: Disposition, opts: { doctorOverride?: boolean; reason?: string } = {}) {
    const enc = await tx.orm.clinical.Encounter.where({ id: encounterId }).forNoKeyUpdate().first();
    if (!enc) throw notFound("Encounter");
    if (isTerminal("encounter", enc.status)) throw conflict("ENCOUNTER_CLOSED", "Encounter is already closed");
    const target = ENCOUNTER_TARGET[disposition];

    const direct = canTransition("encounter", enc.status, target);
    const viaReview = target === "completed" && enc.status === "submitted_for_review" && (await tx.orm.clinical.ClinicalReview.where({ encounterId }).first()) !== null;
    if (!direct && !viaReview && !opts.doctorOverride) {
      throw conflict("INVALID_TRANSITION", `Cannot close encounter from '${enc.status}' with disposition '${disposition}'`);
    }

    // Unresolved safety prompts block a normal completion (PRD §12.6 rule 15).
    if (target === "completed") {
      const openAlerts = await tx.orm.clinical.ObservationAlert.where({ encounterId })
        .where((a) => a.status.in(["open", "acknowledged"]))
        .all();
      if (openAlerts.length) {
        throw conflict("OPEN_ALERTS", "Resolve open safety alerts before completing (or refer the patient)", { openAlertIds: openAlerts.map((a) => a.id) });
      }
    }

    const now = nowIso();
    await tx.orm.clinical.Encounter.where({ id: encounterId }).update({
      status: target,
      disposition,
      closedAt: now,
      closedById: p.userId,
      version: enc.version + 1,
    });

    if (enc.appointmentId) {
      const appt = await tx.orm.hub.Appointment.where({ id: enc.appointmentId }).forNoKeyUpdate().first();
      const apptTarget = APPOINTMENT_TARGET[disposition];
      if (appt && canTransition("appointment", appt.status, apptTarget)) {
        await tx.orm.hub.Appointment.where({ id: appt.id }).update({ status: apptTarget, completedAt: now, version: appt.version + 1 });
      }
    }

    const ticket = await tx.orm.hub.QueueTicket.where({ encounterId }).forNoKeyUpdate().first();
    if (ticket) {
      const qTarget = QUEUE_TARGET[disposition];
      if (canTransition("queue", ticket.status, qTarget)) {
        await tx.orm.hub.QueueTicket.where({ id: ticket.id }).update({ status: qTarget, completedAt: now, version: ticket.version + 1 });
        await tx.orm.hub.QueueTicketEvent.create({ ticketId: ticket.id, fromStatus: ticket.status, toStatus: qTarget, actorUserId: p.userId, reason: `encounter ${disposition}`, occurredAt: now });
      }
    }

    await tx.orm.clinical.EncounterAssignment.where({ encounterId })
      .where((a) => a.status.in(["assigned", "accepted", "started"]))
      .updateAll({ status: "completed", endedAt: now });

    const reviewed = await tx.orm.clinical.ClinicalReview.where({ encounterId }).first();
    if (reviewed) {
      await tx.orm.clinical.Observation.where({ encounterId, reviewStatus: "pending" }).updateAll({ reviewStatus: "reviewed" });
    }

    const hasResults = await tx.orm.clinical.Observation.select("id").where({ encounterId }).first();
    if (hasResults) {
      await this.notifications.enqueue(tx, {
        template: "results.available",
        patientId: enc.patientId,
        deepLink: `healora://encounters/${encounterId}`,
        relatedType: "encounter",
        relatedId: encounterId,
      });
    }

    await this.events.emit(tx, {
      eventType: "encounter.completed",
      aggregateType: "encounter",
      aggregateId: encounterId,
      hubId: enc.hubId,
      sessionId: enc.sessionId,
      correlationId: p.correlationId,
      payload: { encounterId, status: target, disposition, appointmentId: enc.appointmentId },
    });
    await this.audit.record(
      p,
      { action: "encounter.close", targetType: "encounter", targetId: encounterId, hubId: enc.hubId, patientId: enc.patientId, reason: opts.reason ?? null, metadata: { disposition, from: enc.status, override: !direct && !viaReview } },
      tx,
    );
    return { encounterId, status: target, disposition, closedAt: now };
  }
}
