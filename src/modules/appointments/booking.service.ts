import { randomInt } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";
import { or } from "@prisma/orm-postgres/orm-client";

import { AuditService } from "../../common/audit.service.ts";
import type { Principal } from "../../common/auth/principal.ts";
import { db, nowIso, toDate, type Tx } from "../../common/db.ts";
import { conflict, notFound, unprocessable } from "../../common/errors.ts";
import { EventsService } from "../../common/events.service.ts";
import { NotificationService } from "../../common/notification.service.ts";
import { ACTIVE_APPOINTMENT_STATUSES, assertTransition } from "../../common/workflow.ts";

export type BookingSource = "patient_app" | "operations_assignment" | "campaign" | "referral" | "local_doctor" | "walk_in";
export type HubAssignmentBasis = "patient_choice" | "operations_assignment" | "campaign" | "referral" | "walk_in" | "catchment_default";

export interface BookInput {
  patientId: string;
  sessionId: string;
  slotId?: string | null;
  source: BookingSource;
  hubAssignmentBasis: HubAssignmentBasis;
  isWalkIn?: boolean;
  bookedByUserId?: string | null;
  bookedByRepresentativeId?: string | null;
  referralNote?: string | null;
  idempotencyKey?: string | null;
}

export interface SideEffects {
  /** Send patient notifications (default true). */
  notify?: boolean;
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/**
 * Capacity-safe booking (PRD §8.6, §9.10, §12.6 rule 1). Callers authorise;
 * this service enforces session/hub/capacity/duplicate rules under row locks.
 */
@Injectable()
export class BookingService {
  constructor(
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(EventsService) private readonly events: EventsService,
    @Inject(NotificationService) private readonly notifications: NotificationService,
  ) {}

  book(actor: Principal, input: BookInput) {
    return db.transaction((tx) => this.bookInTx(tx, actor, input));
  }

  cancel(actor: Principal, appointmentId: string, reason: string) {
    return db.transaction((tx) => this.cancelInTx(tx, actor, appointmentId, reason));
  }

  reschedule(actor: Principal, appointmentId: string, input: { sessionId: string; slotId?: string | null }) {
    return db.transaction(async (tx) => {
      const old = await tx.orm.hub.Appointment.where({ id: appointmentId }).forNoKeyUpdate().first();
      if (!old) throw notFound("Appointment");
      if (old.status !== "pending_confirmation" && old.status !== "confirmed") {
        throw conflict("NOT_RESCHEDULABLE", "Only pending or confirmed appointments can be rescheduled");
      }
      if (old.sessionId === input.sessionId && (old.slotId ?? null) === (input.slotId ?? null)) {
        throw conflict("SAME_SLOT", "The new session/slot is the same as the current one");
      }
      // Free the old capacity first so a same-session slot move never double-holds.
      await this.cancelInTx(tx, actor, old.id, "rescheduled", { notify: false });
      const fresh = await this.bookInTx(
        tx,
        actor,
        {
          patientId: old.patientId,
          sessionId: input.sessionId,
          slotId: input.slotId ?? null,
          source: old.source as BookingSource,
          hubAssignmentBasis: old.hubAssignmentBasis as HubAssignmentBasis,
          bookedByUserId: actor.kind === "staff" ? actor.userId : null,
          bookedByRepresentativeId: actor.kind === "patient" ? actor.representativeId : null,
          referralNote: old.referralNote,
        },
        { notify: false },
        old.id,
      );
      await this.notifications.enqueue(tx, {
        template: "appointment.changed",
        patientId: old.patientId,
        relatedType: "appointment",
        relatedId: fresh.id,
        deepLink: `healora://appointments/${fresh.id}`,
        serviceCritical: true,
      });
      return fresh;
    });
  }

  // ---- transactional building blocks (also used by front desk / waitlist) ----

  async bookInTx(tx: Tx, actor: Principal, input: BookInput, fx: SideEffects = {}, rescheduledFromId: string | null = null) {
    const isWalkIn = input.isWalkIn ?? input.source === "walk_in";

    if (input.idempotencyKey) {
      const existing = await tx.orm.hub.Appointment.where({ idempotencyKey: input.idempotencyKey }).first();
      if (existing) {
        if (existing.patientId !== input.patientId || existing.sessionId !== input.sessionId) {
          throw conflict("IDEMPOTENCY_KEY_REUSED", "Idempotency key was used for a different booking");
        }
        return existing;
      }
    }

    const patient = await tx.orm.clinical.Patient.select("id", "status", "regionId").first({ id: input.patientId });
    if (!patient) throw notFound("Patient");
    if (patient.status !== "active") throw conflict("PATIENT_NOT_ACTIVE", "Patient record is not active (merged or inactive)");

    const session = await tx.orm.hub.HubSession.where({ id: input.sessionId }).forNoKeyUpdate().first();
    if (!session) throw notFound("Session");
    const now = nowIso();
    const nowMs = Date.now();

    const statusOk = session.status === "open_for_booking" || (isWalkIn && session.status === "in_progress");
    if (!statusOk) throw conflict("SESSION_NOT_BOOKABLE", `Session is ${session.status}`);
    if (!isWalkIn) {
      if (session.bookingOpensAt && (toDate(session.bookingOpensAt)?.getTime() ?? 0) > nowMs) {
        throw conflict("BOOKING_NOT_OPEN", "Booking for this session has not opened yet");
      }
      if (session.bookingClosesAt && (toDate(session.bookingClosesAt)?.getTime() ?? Infinity) <= nowMs) {
        throw conflict("BOOKING_CLOSED", "Booking for this session has closed");
      }
    }

    const hub = await tx.orm.hub.Hub.select("id", "status").first({ id: session.hubId });
    if (!hub || hub.status !== "active") throw conflict("HUB_NOT_ACTIVE", "Hub is not accepting bookings");
    const block = await tx.orm.hub.HubAvailabilityBlock.where({ hubId: hub.id })
      .where((b) => b.blockType.in(["closure", "pause"]))
      .where((b) => b.startsAt.lte(now))
      .where((b) => or(b.endsAt.isNull(), b.endsAt.gt(now)))
      .where((b) => b.liftedAt.isNull())
      .first();
    if (block) throw conflict("HUB_CLOSED", "Hub is currently closed or paused");

    const duplicate = await tx.orm.hub.Appointment.select("id")
      .where({ patientId: input.patientId, sessionId: session.id })
      .where((a) => a.status.in([...ACTIVE_APPOINTMENT_STATUSES]))
      .first();
    if (duplicate) throw conflict("DUPLICATE_BOOKING", "Patient already has an active booking for this session", { appointmentId: duplicate.id });

    // Capacity (session + optional slot).
    let slotId: string | null = null;
    if (input.slotId) {
      const slot = await tx.orm.hub.SessionSlot.where({ id: input.slotId }).forNoKeyUpdate().first();
      if (!slot || slot.sessionId !== session.id) throw unprocessable("INVALID_SLOT", "Slot does not belong to this session");
      if (slot.blocked) throw conflict("SLOT_BLOCKED", "Slot is not available");
      if (slot.bookedCount >= slot.capacity) throw conflict("SLOT_FULL", "Slot is full");
      await tx.orm.hub.SessionSlot.where({ id: slot.id }).update({ bookedCount: slot.bookedCount + 1, version: slot.version + 1 });
      slotId = slot.id;
    }

    const sessionPatch: Record<string, unknown> = { version: session.version + 1 };
    if (isWalkIn) {
      if (!session.allowOverbooking && session.walkInCount >= session.walkInCapacity) {
        throw conflict("WALK_IN_CAPACITY_FULL", "No walk-in capacity left for this session");
      }
      sessionPatch.walkInCount = session.walkInCount + 1;
    } else {
      if (!session.allowOverbooking && session.bookedCount >= session.appointmentCapacity) {
        throw conflict("SESSION_FULL", "Session is full");
      }
      const booked = session.bookedCount + 1;
      sessionPatch.bookedCount = booked;
      if (session.status === "open_for_booking" && booked >= session.appointmentCapacity && !session.allowOverbooking) {
        assertTransition("session", session.status, "full");
        sessionPatch.status = "full";
      }
    }
    await tx.orm.hub.HubSession.where({ id: session.id }).update(sessionPatch as never);

    // Out-of-catchment flag (patient region or any ancestor in the hub's catchment).
    let isOutOfCatchment = false;
    if (patient.regionId) {
      const catchments = await tx.orm.hub.HubCatchment.select("regionId").where({ hubId: hub.id }).all();
      if (catchments.length) {
        const chain = await this.regionChain(tx, patient.regionId);
        isOutOfCatchment = !catchments.some((c) => chain.includes(c.regionId));
      }
    }

    const status = input.source === "operations_assignment" ? "pending_confirmation" : "confirmed";
    const appointment = await tx.orm.hub.Appointment.create({
      code: await this.newCode(tx),
      patientId: input.patientId,
      hubId: hub.id,
      sessionId: session.id,
      slotId,
      serviceTypeId: session.serviceTypeId,
      source: input.source,
      hubAssignmentBasis: input.hubAssignmentBasis,
      isWalkIn,
      isOutOfCatchment,
      status,
      bookedByUserId: input.bookedByUserId ?? null,
      bookedByRepresentativeId: input.bookedByRepresentativeId ?? null,
      referralNote: input.referralNote ?? null,
      confirmedAt: status === "confirmed" ? now : null,
      rescheduledFromId,
      idempotencyKey: input.idempotencyKey ?? null,
    });

    await this.audit.record(
      actor,
      {
        action: rescheduledFromId ? "appointment.rescheduled" : "appointment.created",
        targetType: "appointment",
        targetId: appointment.id,
        hubId: hub.id,
        patientId: input.patientId,
        metadata: { sessionId: session.id, source: input.source, isWalkIn, rescheduledFromId },
      },
      tx,
    );
    await this.events.emit(tx, {
      eventType: rescheduledFromId ? "appointment.changed" : "appointment.created",
      aggregateType: "appointment",
      aggregateId: appointment.id,
      hubId: hub.id,
      sessionId: session.id,
      correlationId: actor.correlationId,
      payload: { appointmentId: appointment.id, patientId: input.patientId, status, isWalkIn, rescheduledFromId },
    });
    if (fx.notify !== false && status === "confirmed" && !isWalkIn) {
      await this.notifications.enqueue(tx, {
        template: "appointment.confirmed",
        patientId: input.patientId,
        relatedType: "appointment",
        relatedId: appointment.id,
        deepLink: `healora://appointments/${appointment.id}`,
        serviceCritical: true,
      });
    }
    return appointment;
  }

  async cancelInTx(tx: Tx, actor: Principal, appointmentId: string, reason: string, fx: SideEffects = {}) {
    const appt = await tx.orm.hub.Appointment.where({ id: appointmentId }).forNoKeyUpdate().first();
    if (!appt) throw notFound("Appointment");
    assertTransition("appointment", appt.status, "cancelled");

    const session = await tx.orm.hub.HubSession.where({ id: appt.sessionId }).forNoKeyUpdate().first();
    if (session) {
      const patch: Record<string, unknown> = { version: session.version + 1 };
      if (appt.isWalkIn) patch.walkInCount = Math.max(0, session.walkInCount - 1);
      else {
        const booked = Math.max(0, session.bookedCount - 1);
        patch.bookedCount = booked;
        if (session.status === "full" && booked < session.appointmentCapacity) patch.status = "open_for_booking";
      }
      await tx.orm.hub.HubSession.where({ id: session.id }).update(patch as never);
    }
    if (appt.slotId) {
      const slot = await tx.orm.hub.SessionSlot.where({ id: appt.slotId }).forNoKeyUpdate().first();
      if (slot) await tx.orm.hub.SessionSlot.where({ id: slot.id }).update({ bookedCount: Math.max(0, slot.bookedCount - 1), version: slot.version + 1 });
    }

    const updated = await tx.orm.hub.Appointment.where({ id: appt.id }).update({
      status: "cancelled",
      cancelledAt: nowIso(),
      cancelReason: reason,
      version: appt.version + 1,
    });

    await this.audit.record(
      actor,
      { action: "appointment.cancelled", targetType: "appointment", targetId: appt.id, hubId: appt.hubId, patientId: appt.patientId, reason },
      tx,
    );
    await this.events.emit(tx, {
      eventType: "appointment.changed",
      aggregateType: "appointment",
      aggregateId: appt.id,
      hubId: appt.hubId,
      sessionId: appt.sessionId,
      correlationId: actor.correlationId,
      payload: { appointmentId: appt.id, status: "cancelled" },
    });
    if (fx.notify !== false) {
      await this.notifications.enqueue(tx, {
        template: "appointment.cancelled",
        patientId: appt.patientId,
        relatedType: "appointment",
        relatedId: appt.id,
        deepLink: `healora://appointments/${appt.id}`,
        serviceCritical: true,
      });
    }
    return updated!;
  }

  /** Region and its ancestors, read on the same transaction connection. */
  private async regionChain(tx: Tx, regionId: string): Promise<string[]> {
    const chain: string[] = [];
    let current: string | null = regionId;
    for (let depth = 0; current && depth < 12; depth++) {
      chain.push(current);
      const row: { parentId: string | null } | null = await tx.orm.hub.Region.select("parentId").first({ id: current });
      current = row?.parentId ?? null;
    }
    return chain;
  }

  private async newCode(tx: Tx): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt++) {
      let code = "";
      for (let i = 0; i < 8; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      const clash = await tx.orm.hub.Appointment.select("id").where({ code }).first();
      if (!clash) return code;
    }
    throw new Error("Could not allocate appointment code");
  }
}
