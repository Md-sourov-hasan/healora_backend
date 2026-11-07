import { Inject, Injectable } from "@nestjs/common";
import { and } from "@prisma/orm-postgres/orm-client";

import { AccessService } from "../../common/access.service.ts";
import { AuditService } from "../../common/audit.service.ts";
import type { StaffPrincipal } from "../../common/auth/principal.ts";
import { db, type DbLike, dhakaDate, nowIso, toDate, type Tx } from "../../common/db.ts";
import { EventsService } from "../../common/events.service.ts";
import { badRequest, conflict, found, unprocessable } from "../../common/errors.ts";
import { NotificationService } from "../../common/notification.service.ts";
import { HUB_MANAGEMENT, OPS_READ, REGIONAL } from "../../common/roles.ts";
import type { Page } from "../../common/validation.ts";
import { assertTransition } from "../../common/workflow.ts";
import { evaluateReadiness } from "./session-readiness.ts";
import type { CapacityInput, CreateSessionInput, ListSessionsQuery, UpdateSessionInput } from "./sessions.schemas.ts";

type Cond = Parameters<typeof and>[number];

/** Fields that may still change after publication (times/capacity may not). */
const POST_PUBLISH_FIELDS = new Set([
  "title",
  "titleBn",
  "patientDescription",
  "patientDescriptionBn",
  "operationalNotes",
  "eligibilityCriteria",
  "bookingClosesAt",
  "teamLeadUserId",
  "lateArrivalGraceMinutes",
  "waitlistEnabled",
]);

const CANCELLABLE_APPOINTMENTS = ["pending_confirmation", "confirmed", "arrived"] as const;
const LIVE_SHIFTS = ["proposed", "approved", "checked_in"] as const;

@Injectable()
export class SessionsService {
  constructor(
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(EventsService) private readonly events: EventsService,
    @Inject(NotificationService) private readonly notifications: NotificationService,
  ) {}

  async load(id: string, tx: DbLike = db) {
    return found(await tx.orm.hub.HubSession.first({ id }), "Session");
  }

  // ---- create / update -----------------------------------------------------

  async create(p: StaffPrincipal, input: CreateSessionInput) {
    const hub = found(await db.orm.hub.Hub.first({ id: input.hubId }), "Hub");
    await this.access.require(p, HUB_MANAGEMENT, { hubId: hub.id }, "session.create");
    if (hub.status === "permanently_closed") throw conflict("HUB_CLOSED", "Hub is permanently closed");
    const serviceType = found(await db.orm.hub.ServiceType.first({ id: input.serviceTypeId }), "Service type");
    if (serviceType.status !== "active") throw conflict("SERVICE_INACTIVE", "Service type is inactive");
    const offering = await db.orm.hub.HubServiceOffering.where({ hubId: hub.id, serviceTypeId: serviceType.id, status: "approved" }).first();
    if (!offering) throw conflict("SERVICE_NOT_APPROVED", "This service is not an approved offering for the hub");
    this.assertWindow(input.startsAt, input.endsAt);
    if (input.teamLeadUserId) found(await db.orm.identity.User.first({ id: input.teamLeadUserId }), "Team lead");

    return db.transaction(async (tx) => {
      const session = await tx.orm.hub.HubSession.create({
        hubId: hub.id,
        serviceTypeId: serviceType.id,
        protocolId: serviceType.protocolId,
        title: input.title,
        titleBn: input.titleBn ?? null,
        sessionType: input.sessionType,
        sessionDate: input.sessionDate ?? dhakaDate(new Date(input.startsAt)),
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        venueAddress: input.venueAddress ?? null,
        venueLatitude: input.venueLatitude ?? null,
        venueLongitude: input.venueLongitude ?? null,
        appointmentCapacity: input.appointmentCapacity,
        walkInCapacity: input.walkInCapacity,
        slotMinutes: input.slotMinutes ?? serviceType.defaultSlotMinutes,
        bufferMinutes: input.bufferMinutes,
        lateArrivalGraceMinutes: input.lateArrivalGraceMinutes,
        allowOverbooking: false,
        waitlistEnabled: input.waitlistEnabled,
        bookingOpensAt: input.bookingOpensAt ?? null,
        bookingClosesAt: input.bookingClosesAt ?? null,
        eligibilityCriteria: input.eligibilityCriteria ?? null,
        patientDescription: input.patientDescription ?? null,
        patientDescriptionBn: input.patientDescriptionBn ?? null,
        operationalNotes: input.operationalNotes ?? null,
        teamLeadUserId: input.teamLeadUserId ?? null,
        recurrenceId: input.recurrenceId ?? null,
        createdById: p.userId,
      });
      await this.audit.record(p, { action: "session.create", targetType: "session", targetId: session.id, hubId: hub.id, metadata: { sessionType: session.sessionType, capacity: session.appointmentCapacity } }, tx);
      return session;
    });
  }

  async update(p: StaffPrincipal, id: string, input: UpdateSessionInput) {
    const current = await this.load(id);
    await this.access.require(p, HUB_MANAGEMENT, { hubId: current.hubId }, "session.update");
    if (current.status === "completed" || current.status === "cancelled") throw conflict("SESSION_CLOSED", `Session is ${current.status}`);
    const keys = Object.keys(input).filter((k) => (input as Record<string, unknown>)[k] !== undefined);
    if (current.status !== "draft") {
      const blocked = keys.filter((k) => !POST_PUBLISH_FIELDS.has(k));
      if (blocked.length) throw conflict("FIELD_LOCKED_AFTER_PUBLISH", "These fields cannot change after publication; use the capacity endpoint or cancel and recreate", { fields: blocked });
    }
    const startsAt = input.startsAt ?? current.startsAt;
    const endsAt = input.endsAt ?? current.endsAt;
    if (input.startsAt || input.endsAt) this.assertWindow(startsAt, endsAt);

    return db.transaction(async (tx) => {
      const patch: Record<string, unknown> = {};
      for (const k of keys) patch[k] = (input as Record<string, unknown>)[k];
      if (input.startsAt && !input.sessionDate) patch.sessionDate = dhakaDate(new Date(input.startsAt));
      patch.version = current.version + 1;
      const updated = await tx.orm.hub.HubSession.where({ id }).update(patch as never);
      await this.audit.record(p, { action: "session.update", targetType: "session", targetId: id, hubId: current.hubId, metadata: { fields: keys } }, tx);
      if (current.status !== "draft") {
        await this.events.emit(tx, { eventType: "session.updated", aggregateType: "session", aggregateId: id, hubId: current.hubId, sessionId: id, correlationId: p.correlationId, payload: { sessionId: id, fields: keys } });
      }
      return updated;
    });
  }

  private assertWindow(startsAt: string, endsAt: string) {
    const s = toDate(startsAt);
    const e = toDate(endsAt);
    if (!s || !e || e <= s) throw badRequest("INVALID_WINDOW", "endsAt must be after startsAt");
    if (e.getTime() - s.getTime() > 24 * 3600 * 1000) throw badRequest("INVALID_WINDOW", "A session cannot be longer than 24 hours");
  }

  // ---- reads ---------------------------------------------------------------

  async list(p: StaffPrincipal, q: ListSessionsQuery & Page) {
    const scope = await this.access.hubScope(p, OPS_READ);
    if (scope !== "all" && scope.length === 0) return { items: [], limit: q.limit, offset: q.offset };
    if (q.hubId) this.access.assertInScope(scope, q.hubId);
    const items = await db.orm.hub.HubSession.where((s) => {
      const c: Cond[] = [];
      if (scope !== "all") c.push(s.hubId.in(scope));
      if (q.hubId) c.push(s.hubId.eq(q.hubId));
      if (q.from) c.push(s.sessionDate.gte(q.from));
      if (q.to) c.push(s.sessionDate.lte(q.to));
      if (q.status) c.push(s.status.in(q.status));
      if (q.sessionType) c.push(s.sessionType.eq(q.sessionType));
      if (q.serviceTypeId) c.push(s.serviceTypeId.eq(q.serviceTypeId));
      return c.length ? and(...c) : s.id.isNotNull();
    })
      .include("hub", (h) => h.select("id", "code", "name"))
      .include("serviceType", (t) => t.select("id", "code", "name"))
      .orderBy([(s) => s.startsAt.asc(), (s) => s.id.asc()])
      .limit(q.limit)
      .offset(q.offset)
      .all();
    return { items, limit: q.limit, offset: q.offset };
  }

  async get(p: StaffPrincipal, id: string) {
    const session = await this.load(id);
    await this.access.require(p, OPS_READ, { hubId: session.hubId }, "session.read");
    const hub = await db.orm.hub.Hub.select("id", "code", "name", "status", "timezone").first({ id: session.hubId });
    const serviceType = await db.orm.hub.ServiceType.select("id", "code", "name", "requiresDoctorReview").first({ id: session.serviceTypeId });
    const byStatus = await db.orm.hub.Appointment.where({ sessionId: id }).groupBy("status").aggregate((a) => ({ n: a.count() }));
    const walkIns = await db.orm.hub.Appointment.where({ sessionId: id, isWalkIn: true }).aggregate((a) => ({ n: a.count() }));
    const shifts = await db.orm.hub.StaffShift.where({ sessionId: id }).where((s) => s.status.in([...LIVE_SHIFTS])).groupBy("role", "status").aggregate((a) => ({ n: a.count() }));
    const requirements = await db.orm.hub.ServiceTypeRequirement.where({ serviceTypeId: session.serviceTypeId, kind: "staff_role" }).all();
    const counts: Record<string, number> = {};
    for (const row of byStatus) counts[row.status] = row.n;
    const staffing = requirements.map((r) => ({
      role: r.staffRole,
      required: r.minCount,
      mandatory: r.mandatory,
      approved: shifts.filter((s) => s.role === r.staffRole && (s.status === "approved" || s.status === "checked_in")).reduce((sum, s) => sum + s.n, 0),
      checkedIn: shifts.filter((s) => s.role === r.staffRole && s.status === "checked_in").reduce((sum, s) => sum + s.n, 0),
      proposed: shifts.filter((s) => s.role === r.staffRole && s.status === "proposed").reduce((sum, s) => sum + s.n, 0),
    }));
    return {
      ...session,
      hub,
      serviceType,
      counts: {
        booked: session.bookedCount,
        walkIns: walkIns.n,
        remainingAppointments: Math.max(0, session.appointmentCapacity - session.bookedCount),
        remainingWalkIns: Math.max(0, session.walkInCapacity - session.walkInCount),
        byStatus: counts,
        checkedIn: (counts.checked_in ?? 0) + (counts.in_service ?? 0) + (counts.completed ?? 0),
        completed: counts.completed ?? 0,
        noShow: counts.no_show ?? 0,
        cancelled: counts.cancelled ?? 0,
      },
      staffing,
    };
  }

  async readiness(p: StaffPrincipal, id: string) {
    const session = await this.load(id);
    await this.access.require(p, OPS_READ, { hubId: session.hubId }, "session.readiness");
    const r = await evaluateReadiness(id);
    return { sessionId: id, ready: r.ready, unmet: r.unmet, warnings: r.warnings };
  }

  // ---- lifecycle -----------------------------------------------------------

  async publish(p: StaffPrincipal, id: string, overrideReason?: string) {
    const session = await this.load(id);
    await this.access.require(p, HUB_MANAGEMENT, { hubId: session.hubId }, "session.publish");
    assertTransition("session", session.status, "published");
    const readiness = await evaluateReadiness(id);
    if (!readiness.ready) {
      if (!overrideReason) throw unprocessable("SESSION_NOT_READY", "Session does not meet minimum staffing/equipment requirements", { unmet: readiness.unmet });
      await this.access.require(p, REGIONAL, { hubId: session.hubId }, "session.publish_override");
      if (readiness.unmet.some((u) => u.kind === "hub" || u.code === "hub_closure")) {
        throw conflict("HUB_NOT_BOOKABLE", "A closed or inactive hub cannot be overridden", { unmet: readiness.unmet });
      }
    }
    return db.transaction(async (tx) => {
      const locked = found(await tx.orm.hub.HubSession.where({ id }).forNoKeyUpdate().first(), "Session");
      assertTransition("session", locked.status, "published");
      const overridden = !readiness.ready;
      const updated = await tx.orm.hub.HubSession.where({ id }).update({
        status: "published",
        publishedAt: nowIso(),
        publishedById: p.userId,
        publishOverrideReason: overridden ? overrideReason! : null,
        publishOverrideById: overridden ? p.userId : null,
        requirementsSnapshot: { ...readiness.snapshot, overridden, unmetAtPublish: readiness.unmet } as never,
        version: locked.version + 1,
      });
      await this.audit.record(p, { action: overridden ? "session.publish_override" : "session.publish", targetType: "session", targetId: id, hubId: session.hubId, reason: overridden ? overrideReason : null, priority: overridden ? "high" : "normal", metadata: { unmet: readiness.unmet.map((u) => u.code) } }, tx);
      await this.events.emit(tx, { eventType: "session.published", aggregateType: "session", aggregateId: id, hubId: session.hubId, sessionId: id, correlationId: p.correlationId, payload: { sessionId: id, hubId: session.hubId, serviceTypeId: session.serviceTypeId, startsAt: session.startsAt } });
      await this.notifyStaff(tx, id, "staff.roster_changed");
      return updated;
    });
  }

  async transition(p: StaffPrincipal, id: string, action: "open_booking" | "pause" | "resume" | "start" | "complete", reason?: string) {
    const session = await this.load(id);
    await this.access.require(p, HUB_MANAGEMENT, { hubId: session.hubId }, `session.${action}`);
    if (action === "pause" && !reason) throw badRequest("REASON_REQUIRED", "A reason is required to pause a session");

    return db.transaction(async (tx) => {
      const s = found(await tx.orm.hub.HubSession.where({ id }).forNoKeyUpdate().first(), "Session");
      if (action === "resume" && s.status !== "paused") throw conflict("INVALID_TRANSITION", "Only a paused session can be resumed");
      const target = {
        open_booking: "open_for_booking",
        pause: "paused",
        resume: s.startedAt ? "in_progress" : "open_for_booking",
        start: "in_progress",
        complete: "completed",
      }[action];
      assertTransition("session", s.status, target);
      // A session with no remaining capacity opens straight into "full".
      const status = target === "open_for_booking" && s.bookedCount >= s.appointmentCapacity ? "full" : target;
      const patch: Record<string, unknown> = { status, version: s.version + 1 };
      if (action === "start") patch.startedAt = nowIso();
      if (action === "complete") patch.completedAt = nowIso();
      const updated = await tx.orm.hub.HubSession.where({ id }).update(patch as never);
      await this.audit.record(p, { action: `session.${action}`, targetType: "session", targetId: id, hubId: s.hubId, reason: reason ?? null, metadata: { from: s.status, to: patch.status } }, tx);
      await this.events.emit(tx, { eventType: "session.updated", aggregateType: "session", aggregateId: id, hubId: s.hubId, sessionId: id, correlationId: p.correlationId, payload: { sessionId: id, from: s.status, to: patch.status } });
      if (action === "pause" || action === "resume") await this.notifyStaff(tx, id, "staff.roster_changed");
      return updated;
    });
  }

  /**
   * Cancel: blocks booking, cancels not-yet-started appointments, notifies
   * patients and staff, closes unstarted rosters. Encounters and observations
   * are never deleted (PRD §8.5). Patients already checked in keep their
   * encounter so care in progress is not interrupted.
   */
  async cancel(p: StaffPrincipal, id: string, reason: string) {
    const session = await this.load(id);
    await this.access.require(p, HUB_MANAGEMENT, { hubId: session.hubId }, "session.cancel");
    return db.transaction(async (tx) => {
      const s = found(await tx.orm.hub.HubSession.where({ id }).forNoKeyUpdate().first(), "Session");
      assertTransition("session", s.status, "cancelled");
      const now = nowIso();
      const updated = await tx.orm.hub.HubSession.where({ id }).update({ status: "cancelled", cancelledAt: now, cancelledById: p.userId, cancelReason: reason, version: s.version + 1 });

      const appts = await tx.orm.hub.Appointment.select("id", "patientId", "status")
        .where({ sessionId: id })
        .where((a) => a.status.in([...CANCELLABLE_APPOINTMENTS]))
        .all();
      if (appts.length) {
        await tx.orm.hub.Appointment.where((a) => a.id.in(appts.map((x) => x.id))).updateAll({ status: "cancelled", cancelledAt: now, cancelReason: "session_cancelled" });
      }
      for (const a of appts) {
        await this.notifications.enqueue(tx, { template: "session.cancelled", patientId: a.patientId, serviceCritical: true, deepLink: `healora://appointments/${a.id}`, relatedType: "appointment", relatedId: a.id });
        await this.events.emit(tx, { eventType: "appointment.changed", aggregateType: "appointment", aggregateId: a.id, hubId: s.hubId, sessionId: id, correlationId: p.correlationId, payload: { appointmentId: a.id, status: "cancelled", reason: "session_cancelled" } });
      }
      await tx.orm.hub.WaitlistEntry.where({ sessionId: id, status: "waiting" }).updateAll({ status: "cancelled" });
      await tx.orm.hub.SessionSlot.where({ sessionId: id }).updateAll({ blocked: true });

      await this.notifyStaff(tx, id, "staff.roster_changed");
      await tx.orm.hub.StaffShift.where({ sessionId: id }).where((sh) => sh.status.in(["proposed", "approved"])).updateAll({ status: "cancelled" });

      await this.audit.record(p, { action: "session.cancel", targetType: "session", targetId: id, hubId: s.hubId, reason, priority: "high", metadata: { appointmentsCancelled: appts.length } }, tx);
      await this.events.emit(tx, { eventType: "session.cancelled", aggregateType: "session", aggregateId: id, hubId: s.hubId, sessionId: id, correlationId: p.correlationId, payload: { sessionId: id, appointmentsCancelled: appts.length } });
      return { ...updated, appointmentsCancelled: appts.length };
    });
  }

  private async notifyStaff(tx: Tx, sessionId: string, template: "staff.roster_changed") {
    const shifts = await tx.orm.hub.StaffShift.select("userId").where({ sessionId }).where((s) => s.status.in([...LIVE_SHIFTS])).all();
    for (const userId of new Set(shifts.map((s) => s.userId))) {
      await this.notifications.enqueue(tx, { template, userId, relatedType: "session", relatedId: sessionId, deepLink: `healora-team://sessions/${sessionId}` });
    }
  }

  // ---- capacity ------------------------------------------------------------

  async changeCapacity(p: StaffPrincipal, id: string, input: CapacityInput) {
    const session = await this.load(id);
    await this.access.require(p, HUB_MANAGEMENT, { hubId: session.hubId }, "session.capacity");
    if (session.status === "completed" || session.status === "cancelled") throw conflict("SESSION_CLOSED", `Session is ${session.status}`);

    const snapshot = (session.requirementsSnapshot ?? {}) as { appointmentCapacity?: number; walkInCapacity?: number };
    const raisesBeyond = (next: number | undefined, current: number, original: number | undefined) =>
      next !== undefined && next > current && (next > Math.ceil(current * 1.2) || (original !== undefined && next > original));
    if (
      raisesBeyond(input.appointmentCapacity, session.appointmentCapacity, snapshot.appointmentCapacity) ||
      raisesBeyond(input.walkInCapacity, session.walkInCapacity, snapshot.walkInCapacity)
    ) {
      await this.access.require(p, REGIONAL, { hubId: session.hubId }, "session.capacity_raise");
    }

    return db.transaction(async (tx) => {
      const s = found(await tx.orm.hub.HubSession.where({ id }).forNoKeyUpdate().first(), "Session");
      if (s.version !== input.expectedVersion) throw conflict("VERSION_MISMATCH", "Session changed since you loaded it; reload and retry", { currentVersion: s.version });
      const appointmentCapacity = input.appointmentCapacity ?? s.appointmentCapacity;
      const walkInCapacity = input.walkInCapacity ?? s.walkInCapacity;
      if (appointmentCapacity < s.bookedCount) {
        throw conflict("CAPACITY_BELOW_BOOKINGS", "Capacity cannot be lowered below confirmed bookings; reschedule or cancel bookings explicitly first", { bookedCount: s.bookedCount });
      }
      if (walkInCapacity < s.walkInCount) throw conflict("CAPACITY_BELOW_WALKINS", "Walk-in capacity cannot be lowered below walk-ins already registered", { walkInCount: s.walkInCount });
      let status = s.status;
      if (s.status === "full" && appointmentCapacity > s.bookedCount) status = "open_for_booking";
      if (s.status === "open_for_booking" && appointmentCapacity <= s.bookedCount) status = "full";
      const updated = await tx.orm.hub.HubSession.where({ id }).update({ appointmentCapacity, walkInCapacity, status, version: s.version + 1 });
      await this.audit.record(p, {
        action: "session.capacity_change",
        targetType: "session",
        targetId: id,
        hubId: s.hubId,
        reason: input.reason,
        metadata: { appointmentCapacity: { old: s.appointmentCapacity, new: appointmentCapacity }, walkInCapacity: { old: s.walkInCapacity, new: walkInCapacity } },
      }, tx);
      await this.events.emit(tx, { eventType: "session.updated", aggregateType: "session", aggregateId: id, hubId: s.hubId, sessionId: id, correlationId: p.correlationId, payload: { sessionId: id, appointmentCapacity, walkInCapacity, status } });
      return updated;
    });
  }

  // ---- slots ---------------------------------------------------------------

  async generateSlots(p: StaffPrincipal, id: string, perSlotCapacity?: number) {
    const session = await this.load(id);
    await this.access.require(p, HUB_MANAGEMENT, { hubId: session.hubId }, "session.slots_generate");
    if (["completed", "cancelled", "in_progress"].includes(session.status)) throw conflict("SESSION_CLOSED", `Session is ${session.status}`);
    const start = toDate(session.startsAt)!;
    const end = toDate(session.endsAt)!;
    const stepMs = (session.slotMinutes + session.bufferMinutes) * 60000;
    const durMs = session.slotMinutes * 60000;
    const windows: { startsAt: string; endsAt: string }[] = [];
    for (let t = start.getTime(); t + durMs <= end.getTime(); t += stepMs) {
      windows.push({ startsAt: new Date(t).toISOString(), endsAt: new Date(t + durMs).toISOString() });
    }
    if (windows.length === 0) throw unprocessable("NO_SLOTS", "Session window is shorter than one slot");
    const capacity = perSlotCapacity ?? Math.max(1, Math.ceil(session.appointmentCapacity / windows.length));

    return db.transaction(async (tx) => {
      const existing = await tx.orm.hub.SessionSlot.select("startsAt", "bookedCount").where({ sessionId: id }).all();
      const existingStarts = new Set(existing.map((e) => toDate(e.startsAt)!.toISOString()));
      let created = 0;
      for (const w of windows) {
        if (existingStarts.has(w.startsAt)) continue;
        await tx.orm.hub.SessionSlot.create({ sessionId: id, startsAt: w.startsAt, endsAt: w.endsAt, capacity });
        created++;
      }
      await this.audit.record(p, { action: "session.slots_generate", targetType: "session", targetId: id, hubId: session.hubId, metadata: { created, perSlotCapacity: capacity } }, tx);
      return { created, skippedExisting: windows.length - created, perSlotCapacity: capacity };
    });
  }

  async listSlots(p: StaffPrincipal, id: string) {
    const session = await this.load(id);
    await this.access.require(p, OPS_READ, { hubId: session.hubId }, "session.slots_read");
    const slots = await db.orm.hub.SessionSlot.where({ sessionId: id }).orderBy((s) => s.startsAt.asc()).all();
    return slots.map((s) => ({ ...s, remaining: s.blocked ? 0 : Math.max(0, s.capacity - s.bookedCount) }));
  }

  async setSlotBlocked(p: StaffPrincipal, sessionId: string, slotId: string, blocked: boolean, reason?: string) {
    const session = await this.load(sessionId);
    await this.access.require(p, HUB_MANAGEMENT, { hubId: session.hubId }, "session.slot_block");
    const slot = found(await db.orm.hub.SessionSlot.where({ id: slotId, sessionId }).first(), "Slot");
    return db.transaction(async (tx) => {
      const updated = await tx.orm.hub.SessionSlot.where({ id: slot.id }).update({ blocked, version: slot.version + 1 });
      await this.audit.record(p, { action: blocked ? "session.slot_block" : "session.slot_unblock", targetType: "session_slot", targetId: slot.id, hubId: session.hubId, reason: reason ?? null, metadata: { bookedCount: slot.bookedCount } }, tx);
      return { ...updated, warning: blocked && slot.bookedCount > 0 ? "Slot has existing bookings; they are kept and must be rescheduled explicitly" : undefined };
    });
  }
}
