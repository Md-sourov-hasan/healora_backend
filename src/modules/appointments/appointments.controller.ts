import { Body, Controller, Get, Inject, Param, Post, Query } from "@nestjs/common";

import { AccessService } from "../../common/access.service.ts";
import { AuditService } from "../../common/audit.service.ts";
import { Staff } from "../../common/auth/decorators.ts";
import type { StaffPrincipal } from "../../common/auth/principal.ts";
import { db, nowIso, toDate } from "../../common/db.ts";
import { conflict, found } from "../../common/errors.ts";
import { EventsService } from "../../common/events.service.ts";
import { DOCTORS, HUB_FLOOR, RECEPTION } from "../../common/roles.ts";
import { assertTransition } from "../../common/workflow.ts";
import { parse, z, zId, zPage, zReason } from "../../common/validation.ts";
import { MIN_PATIENT_FIELDS, minimalPatient } from "../patients/patient-view.ts";
import { BookingService } from "./booking.service.ts";

const BOOKERS = [...RECEPTION, ...DOCTORS];

const zCreate = z.object({
  patientId: zId,
  slotId: zId.optional(),
  source: z.enum(["operations_assignment", "referral", "local_doctor", "campaign"]),
  hubAssignmentBasis: z.enum(["operations_assignment", "referral", "campaign", "patient_choice", "catchment_default"]).optional(),
  referralNote: z.string().max(1000).optional(),
  idempotencyKey: z.string().min(8).max(100).optional(),
});

const zStatusFilter = z.object({
  status: z.enum(["pending_confirmation", "confirmed", "arrived", "checked_in", "in_service", "completed", "cancelled", "no_show", "unable_to_complete", "referred"]).optional(),
});

@Controller()
export class AppointmentsController {
  constructor(
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(EventsService) private readonly events: EventsService,
    @Inject(BookingService) private readonly booking: BookingService,
  ) {}

  /** Session roster: expected arrivals with minimal identity (PRD §8.8). */
  @Get("sessions/:sessionId/appointments")
  async roster(@Staff() p: StaffPrincipal, @Param("sessionId") sessionId: string, @Query() q: unknown) {
    parse(zId, sessionId);
    await this.access.require(p, HUB_FLOOR, { sessionId }, "appointment.roster");
    const { status } = parse(zStatusFilter, q);
    let query = db.orm.hub.Appointment.where({ sessionId });
    if (status) query = query.where({ status });
    const rows = await query
      .include("patient", (pt) => pt.select(...MIN_PATIENT_FIELDS))
      .include("slot", (s) => s.select("id", "startsAt", "endsAt"))
      .orderBy([(a) => a.createdAt.asc()])
      .all();
    return {
      sessionId,
      items: rows.map(({ patient, slot, ...a }) => ({
        id: a.id,
        code: a.code,
        status: a.status,
        source: a.source,
        hubAssignmentBasis: a.hubAssignmentBasis,
        isWalkIn: a.isWalkIn,
        isOutOfCatchment: a.isOutOfCatchment,
        slot,
        confirmedAt: a.confirmedAt,
        arrivedAt: a.arrivedAt,
        checkedInAt: a.checkedInAt,
        cancelledAt: a.cancelledAt,
        noShowAt: a.noShowAt,
        patient: patient ? minimalPatient(patient) : null,
      })),
    };
  }

  /** Hub-scoped appointment search (date / status). */
  @Get("appointments")
  async list(@Staff() p: StaffPrincipal, @Query() q: unknown) {
    const input = parse(zPage.merge(zStatusFilter).extend({ hubId: zId.optional(), patientId: zId.optional(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }), q);
    const scope = await this.access.hubScope(p, HUB_FLOOR);
    if (scope !== "all" && scope.length === 0) return { items: [], limit: input.limit, offset: input.offset };
    if (input.hubId) this.access.assertInScope(scope, input.hubId);
    let query = db.orm.hub.Appointment.where((a) => (scope === "all" ? a.id.isNotNull() : a.hubId.in(scope)));
    if (input.hubId) query = query.where({ hubId: input.hubId });
    if (input.patientId) query = query.where({ patientId: input.patientId });
    if (input.status) query = query.where({ status: input.status });
    if (input.date) query = query.where((a) => a.session.some((s) => s.sessionDate.eq(input.date!)));
    const rows = await query
      .include("patient", (pt) => pt.select(...MIN_PATIENT_FIELDS))
      .include("session", (s) => s.select("id", "title", "sessionDate", "startsAt"))
      .orderBy((a) => a.createdAt.desc())
      .limit(input.limit)
      .offset(input.offset)
      .all();
    return {
      items: rows.map(({ patient, ...a }) => ({ ...a, idempotencyKey: undefined, referralNote: undefined, patient: patient ? minimalPatient(patient) : null })),
      limit: input.limit,
      offset: input.offset,
    };
  }

  @Get("appointments/:id")
  async get(@Staff() p: StaffPrincipal, @Param("id") id: string) {
    parse(zId, id);
    const appt = found(
      await db.orm.hub.Appointment.where({ id })
        .include("patient", (pt) => pt.select(...MIN_PATIENT_FIELDS))
        .include("session", (s) => s.select("id", "title", "sessionDate", "startsAt", "endsAt", "status"))
        .include("slot", (s) => s.select("id", "startsAt", "endsAt"))
        .first(),
      "Appointment",
    );
    await this.access.require(p, HUB_FLOOR, { hubId: appt.hubId }, "appointment.read");
    const { patient, idempotencyKey: _k, ...rest } = appt;
    return { ...rest, patient: patient ? minimalPatient(patient) : null };
  }

  /** Book on a patient's behalf (operations assignment, referral, local doctor). */
  @Post("sessions/:sessionId/appointments")
  async create(@Staff() p: StaffPrincipal, @Param("sessionId") sessionId: string, @Body() body: unknown) {
    parse(zId, sessionId);
    await this.access.require(p, BOOKERS, { sessionId }, "appointment.create");
    const input = parse(zCreate, body);
    return this.booking.book(p, {
      patientId: input.patientId,
      sessionId,
      slotId: input.slotId ?? null,
      source: input.source,
      hubAssignmentBasis: input.hubAssignmentBasis ?? (input.source === "local_doctor" ? "referral" : input.source),
      bookedByUserId: p.userId,
      referralNote: input.referralNote ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
    });
  }

  @Post("appointments/:id/confirm")
  async confirm(@Staff() p: StaffPrincipal, @Param("id") id: string) {
    return this.simpleTransition(p, id, "confirmed", "appointment.confirm", { confirmedAt: nowIso() });
  }

  @Post("appointments/:id/arrived")
  async arrived(@Staff() p: StaffPrincipal, @Param("id") id: string) {
    return this.simpleTransition(p, id, "arrived", "appointment.arrived", { arrivedAt: nowIso() });
  }

  @Post("appointments/:id/cancel")
  async cancel(@Staff() p: StaffPrincipal, @Param("id") id: string, @Body() body: unknown) {
    const appt = await this.load(id);
    await this.access.require(p, RECEPTION, { hubId: appt.hubId }, "appointment.cancel");
    const { reason } = parse(z.object({ reason: zReason }), body);
    return this.booking.cancel(p, id, reason);
  }

  @Post("appointments/:id/reschedule")
  async reschedule(@Staff() p: StaffPrincipal, @Param("id") id: string, @Body() body: unknown) {
    const appt = await this.load(id);
    await this.access.require(p, RECEPTION, { hubId: appt.hubId }, "appointment.reschedule");
    const input = parse(z.object({ sessionId: zId, slotId: zId.optional() }), body);
    await this.access.require(p, BOOKERS, { sessionId: input.sessionId }, "appointment.reschedule_target");
    return this.booking.reschedule(p, id, { sessionId: input.sessionId, slotId: input.slotId ?? null });
  }

  /** No-show only after the slot/session start plus the late-arrival grace period. */
  @Post("appointments/:id/no-show")
  async noShow(@Staff() p: StaffPrincipal, @Param("id") id: string) {
    const appt = await this.load(id);
    await this.access.require(p, RECEPTION, { hubId: appt.hubId }, "appointment.no_show");
    const session = found(await db.orm.hub.HubSession.first({ id: appt.sessionId }), "Session");
    const slot = appt.slotId ? await db.orm.hub.SessionSlot.select("startsAt").first({ id: appt.slotId }) : null;
    const start = toDate(slot?.startsAt ?? session.startsAt)!;
    const graceEnds = start.getTime() + session.lateArrivalGraceMinutes * 60_000;
    if (Date.now() < graceEnds) {
      throw conflict("GRACE_PERIOD_ACTIVE", "The late-arrival grace period has not ended yet", { graceEndsAt: new Date(graceEnds).toISOString() });
    }
    return this.simpleTransition(p, id, "no_show", "appointment.no_show", { noShowAt: nowIso() }, true);
  }

  private async load(id: string) {
    parse(zId, id);
    return found(await db.orm.hub.Appointment.first({ id }), "Appointment");
  }

  private async simpleTransition(p: StaffPrincipal, id: string, to: string, action: string, patch: Record<string, unknown>, skipAuth = false) {
    const appt = await this.load(id);
    if (!skipAuth) await this.access.require(p, RECEPTION, { hubId: appt.hubId }, action);
    return db.transaction(async (tx) => {
      const locked = found(await tx.orm.hub.Appointment.where({ id }).forNoKeyUpdate().first(), "Appointment");
      assertTransition("appointment", locked.status, to);
      const updated = await tx.orm.hub.Appointment.where({ id }).update({ ...patch, status: to, version: locked.version + 1 } as never);
      await this.audit.record(p, { action, targetType: "appointment", targetId: id, hubId: locked.hubId, patientId: locked.patientId, metadata: { from: locked.status, to } }, tx);
      await this.events.emit(tx, {
        eventType: "appointment.changed",
        aggregateType: "appointment",
        aggregateId: id,
        hubId: locked.hubId,
        sessionId: locked.sessionId,
        correlationId: p.correlationId,
        payload: { appointmentId: id, status: to },
      });
      return updated;
    });
  }
}

/** Waitlist for full sessions (PRD §8.5, §9.10). */
@Controller()
export class WaitlistController {
  constructor(
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(BookingService) private readonly booking: BookingService,
  ) {}

  @Get("sessions/:sessionId/waitlist")
  async list(@Staff() p: StaffPrincipal, @Param("sessionId") sessionId: string) {
    parse(zId, sessionId);
    await this.access.require(p, HUB_FLOOR, { sessionId }, "waitlist.read");
    const rows = await db.orm.hub.WaitlistEntry.where({ sessionId })
      .include("patient", (pt) => pt.select(...MIN_PATIENT_FIELDS))
      .orderBy((w) => w.position.asc())
      .all();
    return { items: rows.map(({ patient, ...w }) => ({ ...w, patient: patient ? minimalPatient(patient) : null })) };
  }

  @Post("sessions/:sessionId/waitlist")
  async add(@Staff() p: StaffPrincipal, @Param("sessionId") sessionId: string, @Body() body: unknown) {
    parse(zId, sessionId);
    await this.access.require(p, RECEPTION, { sessionId }, "waitlist.add");
    const { patientId } = parse(z.object({ patientId: zId }), body);
    return db.transaction(async (tx) => {
      const session = found(await tx.orm.hub.HubSession.where({ id: sessionId }).forNoKeyUpdate().first(), "Session");
      if (!session.waitlistEnabled) throw conflict("WAITLIST_DISABLED", "Waitlist is not enabled for this session");
      if (session.status === "cancelled" || session.status === "completed") throw conflict("SESSION_CLOSED", `Session is ${session.status}`);
      found(await tx.orm.clinical.Patient.select("id").first({ id: patientId }), "Patient");
      const last = await tx.orm.hub.WaitlistEntry.where({ sessionId }).aggregate((a) => ({ max: a.max("position") }));
      const entry = await tx.orm.hub.WaitlistEntry.create({ sessionId, patientId, position: (last.max ?? 0) + 1, addedById: p.userId });
      await this.audit.record(p, { action: "waitlist.add", targetType: "waitlist_entry", targetId: entry.id, hubId: session.hubId, patientId }, tx);
      return entry;
    });
  }

  /** Offer a freed place: books through the normal capacity rules. */
  @Post("waitlist/:id/offer")
  async offer(@Staff() p: StaffPrincipal, @Param("id") id: string, @Body() body: unknown) {
    parse(zId, id);
    const entry = found(await db.orm.hub.WaitlistEntry.first({ id }), "Waitlist entry");
    await this.access.require(p, RECEPTION, { sessionId: entry.sessionId }, "waitlist.offer");
    const { slotId } = parse(z.object({ slotId: zId.optional() }), body);
    return db.transaction(async (tx) => {
      const locked = found(await tx.orm.hub.WaitlistEntry.where({ id }).forNoKeyUpdate().first(), "Waitlist entry");
      if (locked.status !== "waiting" && locked.status !== "offered") throw conflict("WAITLIST_NOT_WAITING", `Entry is ${locked.status}`);
      const appointment = await this.booking.bookInTx(tx, p, {
        patientId: locked.patientId,
        sessionId: locked.sessionId,
        slotId: slotId ?? null,
        source: "operations_assignment",
        hubAssignmentBasis: "operations_assignment",
        bookedByUserId: p.userId,
      });
      const updated = await tx.orm.hub.WaitlistEntry.where({ id }).update({ status: "booked", appointmentId: appointment.id });
      return { waitlistEntry: updated, appointment };
    });
  }

  @Post("waitlist/:id/remove")
  async remove(@Staff() p: StaffPrincipal, @Param("id") id: string, @Body() body: unknown) {
    parse(zId, id);
    const entry = found(await db.orm.hub.WaitlistEntry.first({ id }), "Waitlist entry");
    const session = await this.access.require(p, RECEPTION, { sessionId: entry.sessionId }, "waitlist.remove");
    const { reason } = parse(z.object({ reason: zReason }), body);
    return db.transaction(async (tx) => {
      const locked = found(await tx.orm.hub.WaitlistEntry.where({ id }).forNoKeyUpdate().first(), "Waitlist entry");
      if (locked.status !== "waiting" && locked.status !== "offered") throw conflict("WAITLIST_NOT_WAITING", `Entry is ${locked.status}`);
      const updated = await tx.orm.hub.WaitlistEntry.where({ id }).update({ status: "cancelled" });
      await this.audit.record(session, { action: "waitlist.remove", targetType: "waitlist_entry", targetId: id, patientId: locked.patientId, reason }, tx);
      return updated;
    });
  }
}
