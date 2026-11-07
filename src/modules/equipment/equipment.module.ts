import { Body, Controller, Delete, Get, Inject, Injectable, Module, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import { and } from "@prisma/orm-postgres/orm-client";

import { AccessService } from "../../common/access.service.ts";
import { AuditService } from "../../common/audit.service.ts";
import { Staff } from "../../common/auth/decorators.ts";
import type { StaffPrincipal } from "../../common/auth/principal.ts";
import { db, dhakaDate, nowIso, toDate, type Tx } from "../../common/db.ts";
import { EventsService } from "../../common/events.service.ts";
import { badRequest, conflict, found } from "../../common/errors.ts";
import { NotificationService } from "../../common/notification.service.ts";
import { EQUIPMENT, OPS_READ, type StaffRole, TEAM } from "../../common/roles.ts";
import { parse, z, zDate, zId, zInstant, zPage, zReason } from "../../common/validation.ts";

type Cond = Parameters<typeof and>[number];

const CATEGORIES = ["bp_monitor", "glucometer", "weighing_scale", "stadiometer", "thermometer", "pulse_oximeter", "tablet", "printer", "other"] as const;
const STATUSES = ["available", "assigned", "maintenance", "calibration_due", "out_of_service", "retired"] as const;
type EquipmentStatus = (typeof STATUSES)[number];
const UNASSIGNABLE: EquipmentStatus[] = ["out_of_service", "retired", "maintenance"];
/** Sessions that are still upcoming or live. */
const LIVE_SESSIONS = ["draft", "published", "open_for_booking", "full", "in_progress", "paused"] as const;
const PUBLISHED_SESSIONS = ["published", "open_for_booking", "full", "in_progress", "paused"] as const;
/** Team members may report a fault they notice during a session. */
const FAULT_REPORTERS: StaffRole[] = [...EQUIPMENT, "queue_coordinator", ...TEAM];

const registerSchema = z.object({
  hubId: zId,
  stationId: zId.optional(),
  assetTag: z.string().trim().min(1).max(60),
  category: z.enum(CATEGORIES),
  make: z.string().trim().max(120).optional(),
  model: z.string().trim().max(120).optional(),
  serialNumber: z.string().trim().max(120).optional(),
  ownerName: z.string().trim().max(120).optional(),
  supportedObservationCodes: z.array(z.string().trim().min(1).max(60)).max(30).default([]),
  supportedUnits: z.array(z.string().trim().min(1).max(30)).max(30).default([]),
  purchasedOn: zDate.optional(),
  activatedOn: zDate.optional(),
  nextCalibrationDue: zDate.optional(),
  serviceProvider: z.string().trim().max(200).optional(),
  notes: z.string().trim().max(2000).optional(),
});
const updateSchema = registerSchema.omit({ hubId: true, assetTag: true }).partial().extend({ stationId: zId.nullable().optional() }).strict();
const listSchema = z.object({
  hubId: zId.optional(),
  stationId: zId.optional(),
  status: z.enum(STATUSES).optional(),
  category: z.enum(CATEGORIES).optional(),
  calibrationDueWithinDays: z.coerce.number().int().min(0).max(365).optional(),
});
const statusSchema = z.object({ status: z.enum(STATUSES).exclude(["retired"]), reason: zReason });
const faultSchema = z.object({ notes: zReason, sessionId: zId.optional(), takeOutOfService: z.boolean().default(true) });
const resolveSchema = z.object({ notes: zReason, status: z.enum(["available", "assigned", "calibration_due"]).default("available") });
const serviceEventSchema = z.object({
  kind: z.enum(["inspection", "calibration", "maintenance"]),
  occurredAt: zInstant.optional(),
  nextDueOn: zDate.optional(),
  serviceProvider: z.string().trim().max(200).optional(),
  notes: z.string().trim().max(2000).optional(),
});
const assignSchema = z.object({ equipmentId: zId, stationId: zId.optional(), mandatory: z.boolean().default(true) });
const reasonSchema = z.object({ reason: zReason });

@Injectable()
class EquipmentService {
  constructor(
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(EventsService) private readonly events: EventsService,
    @Inject(NotificationService) private readonly notifications: NotificationService,
  ) {}

  private async load(id: string) {
    return found(await db.orm.hub.Equipment.first({ id }), "Equipment");
  }

  private async assertStation(stationId: string | null | undefined, hubId: string) {
    if (!stationId) return;
    const st = found(await db.orm.hub.HubStation.first({ id: stationId }), "Station");
    if (st.hubId !== hubId) throw badRequest("STATION_HUB_MISMATCH", "Station belongs to another hub");
  }

  async register(p: StaffPrincipal, body: unknown) {
    const input = parse(registerSchema, body);
    const hub = found(await db.orm.hub.Hub.first({ id: input.hubId }), "Hub");
    await this.access.require(p, EQUIPMENT, { hubId: hub.id }, "equipment.register");
    await this.assertStation(input.stationId, hub.id);
    return db.transaction(async (tx) => {
      const eq = await tx.orm.hub.Equipment.create({
        ...input,
        stationId: input.stationId ?? null,
        status: input.nextCalibrationDue && input.nextCalibrationDue < dhakaDate() ? "calibration_due" : "available",
      });
      await this.audit.record(p, { action: "equipment.register", targetType: "equipment", targetId: eq.id, hubId: hub.id, metadata: { assetTag: eq.assetTag, category: eq.category } }, tx);
      return eq;
    });
  }

  async update(p: StaffPrincipal, id: string, body: unknown) {
    const input = parse(updateSchema, body);
    const eq = await this.load(id);
    await this.access.require(p, EQUIPMENT, { hubId: eq.hubId }, "equipment.update");
    if (eq.status === "retired") throw conflict("EQUIPMENT_RETIRED", "Retired equipment cannot be edited");
    await this.assertStation(input.stationId, eq.hubId);
    return db.transaction(async (tx) => {
      const updated = await tx.orm.hub.Equipment.where({ id }).update(input as never);
      await this.audit.record(p, { action: "equipment.update", targetType: "equipment", targetId: id, hubId: eq.hubId, metadata: { fields: Object.keys(input) } }, tx);
      return updated;
    });
  }

  async list(p: StaffPrincipal, query: unknown) {
    const q = parse(listSchema, query);
    const page = parse(zPage, query);
    const scope = await this.access.hubScope(p, OPS_READ);
    if (q.hubId) this.access.assertInScope(scope, q.hubId);
    if (scope !== "all" && scope.length === 0) return { items: [], limit: page.limit, offset: page.offset };
    const dueBy = q.calibrationDueWithinDays !== undefined ? dhakaDate(new Date(Date.now() + q.calibrationDueWithinDays * 86400000)) : null;
    const items = await db.orm.hub.Equipment.where((e) => {
      const c: Cond[] = [];
      if (scope !== "all") c.push(e.hubId.in(scope));
      if (q.hubId) c.push(e.hubId.eq(q.hubId));
      if (q.stationId) c.push(e.stationId.eq(q.stationId));
      if (q.status) c.push(e.status.eq(q.status));
      if (q.category) c.push(e.category.eq(q.category));
      if (dueBy) c.push(and(e.nextCalibrationDue.isNotNull(), e.nextCalibrationDue.lte(dueBy)));
      return c.length ? and(...c) : e.id.isNotNull();
    })
      .orderBy([(e) => e.assetTag.asc()])
      .limit(page.limit)
      .offset(page.offset)
      .all();
    const today = dhakaDate();
    return { items: items.map((e) => ({ ...e, calibrationOverdue: !!e.nextCalibrationDue && e.nextCalibrationDue < today })), limit: page.limit, offset: page.offset };
  }

  async get(p: StaffPrincipal, id: string) {
    const eq = await this.load(id);
    await this.access.require(p, [...OPS_READ, ...TEAM], { hubId: eq.hubId }, "equipment.read");
    return eq;
  }

  /**
   * Single place where status changes. Taking an item out of service raises an
   * equipment_fault exception for every upcoming published session that relies
   * on it as mandatory, and alerts the hub manager.
   */
  private async changeStatus(tx: Tx, p: StaffPrincipal, eq: { id: string; hubId: string; status: string; assetTag: string }, to: EquipmentStatus, reason: string, extra: Record<string, unknown> = {}) {
    if (eq.status === "retired") throw conflict("EQUIPMENT_RETIRED", "Retired equipment cannot change status");
    const updated = await tx.orm.hub.Equipment.where({ id: eq.id }).update({ status: to, statusReason: reason, ...extra } as never);
    if (eq.status !== to) {
      await tx.orm.hub.EquipmentEvent.create({ equipmentId: eq.id, kind: "status_change", occurredAt: nowIso(), statusFrom: eq.status as EquipmentStatus, statusTo: to, reportedById: p.userId, notes: reason });
      await this.events.emit(tx, { eventType: "equipment.status_changed", aggregateType: "equipment", aggregateId: eq.id, hubId: eq.hubId, correlationId: p.correlationId, payload: { equipmentId: eq.id, from: eq.status, to } });
    }
    if (UNASSIGNABLE.includes(to) && !UNASSIGNABLE.includes(eq.status as EquipmentStatus)) {
      await this.raiseForSessions(tx, p, eq, to);
    }
    return updated;
  }

  private async raiseForSessions(tx: Tx, p: StaffPrincipal, eq: { id: string; hubId: string; assetTag: string }, to: string) {
    const now = nowIso();
    const links = await tx.orm.hub.SessionEquipment.where({ equipmentId: eq.id, mandatory: true })
      .include("session", (s) => s.select("id", "hubId", "status", "endsAt", "title"))
      .all();
    const affected = links
      .map((l) => l.session)
      .filter((s): s is NonNullable<typeof s> => !!s && (PUBLISHED_SESSIONS as readonly string[]).includes(s.status) && toDate(s.endsAt)!.getTime() > Date.now());
    if (affected.length === 0) return;
    for (const s of affected) {
      const dedupeKey = `equipment_fault:${s.id}:${eq.id}`;
      const open = await tx.orm.hub.OperationalException.where({ dedupeKey }).where((x) => x.status.in(["open", "acknowledged", "escalated"])).first();
      if (open) continue;
      const exc = await tx.orm.hub.OperationalException.create({
        hubId: eq.hubId,
        sessionId: s.id,
        equipmentId: eq.id,
        type: "equipment_fault",
        severity: "high",
        status: "open",
        summary: `Mandatory equipment ${eq.assetTag} is ${to} for session "${s.title}"`,
        dedupeKey,
        raisedAt: now,
      });
      await this.events.emit(tx, { eventType: "exception.raised", aggregateType: "operational_exception", aggregateId: exc.id, hubId: eq.hubId, sessionId: s.id, correlationId: p.correlationId, payload: { exceptionId: exc.id, type: "equipment_fault", equipmentId: eq.id } });
    }
    const hub = await tx.orm.hub.Hub.select("managerUserId").first({ id: eq.hubId });
    if (hub?.managerUserId) {
      await this.notifications.enqueue(tx, { template: "staff.equipment_alert", userId: hub.managerUserId, relatedType: "equipment", relatedId: eq.id, deepLink: `healora-hub://equipment/${eq.id}` });
    }
  }

  async setStatus(p: StaffPrincipal, id: string, body: unknown) {
    const input = parse(statusSchema, body);
    const eq = await this.load(id);
    await this.access.require(p, EQUIPMENT, { hubId: eq.hubId }, "equipment.status");
    return db.transaction(async (tx) => {
      const updated = await this.changeStatus(tx, p, eq, input.status, input.reason);
      await this.audit.record(p, { action: "equipment.status", targetType: "equipment", targetId: id, hubId: eq.hubId, reason: input.reason, metadata: { from: eq.status, to: input.status } }, tx);
      return updated;
    });
  }

  async retire(p: StaffPrincipal, id: string, reason: string) {
    const eq = await this.load(id);
    await this.access.require(p, EQUIPMENT, { hubId: eq.hubId }, "equipment.retire");
    return db.transaction(async (tx) => {
      const updated = await this.changeStatus(tx, p, eq, "retired", reason, { retiredAt: nowIso() });
      // Retired items are released from sessions that have not started.
      const links = await tx.orm.hub.SessionEquipment.where({ equipmentId: id }).include("session", (s) => s.select("id", "status")).all();
      const removable = links.filter((l) => l.session && ["draft", "published", "open_for_booking", "full"].includes(l.session.status)).map((l) => l.id);
      if (removable.length) await tx.orm.hub.SessionEquipment.where((l) => l.id.in(removable)).deleteAll();
      await this.audit.record(p, { action: "equipment.retire", targetType: "equipment", targetId: id, hubId: eq.hubId, reason, priority: "high", metadata: { releasedFromSessions: removable.length } }, tx);
      return updated;
    });
  }

  async reportFault(p: StaffPrincipal, id: string, body: unknown) {
    const input = parse(faultSchema, body);
    const eq = await this.load(id);
    await this.access.require(p, FAULT_REPORTERS, { hubId: eq.hubId }, "equipment.fault_report");
    if (input.sessionId) {
      const s = found(await db.orm.hub.HubSession.first({ id: input.sessionId }), "Session");
      if (s.hubId !== eq.hubId) throw badRequest("SESSION_HUB_MISMATCH", "Session belongs to another hub");
    }
    return db.transaction(async (tx) => {
      const event = await tx.orm.hub.EquipmentEvent.create({ equipmentId: id, kind: "fault_reported", occurredAt: nowIso(), sessionId: input.sessionId ?? null, reportedById: p.userId, notes: input.notes });
      if (input.takeOutOfService && eq.status !== "out_of_service") {
        await this.changeStatus(tx, p, eq, "out_of_service", `Fault reported: ${input.notes}`);
      }
      if (input.sessionId) {
        // Fault during a live session is an operational exception even if the item is optional.
        const dedupeKey = `equipment_fault:${input.sessionId}:${id}`;
        const open = await tx.orm.hub.OperationalException.where({ dedupeKey }).where((x) => x.status.in(["open", "acknowledged", "escalated"])).first();
        if (!open) {
          await tx.orm.hub.OperationalException.create({ hubId: eq.hubId, sessionId: input.sessionId, equipmentId: id, type: "equipment_fault", severity: "medium", status: "open", summary: `Fault reported on ${eq.assetTag} during session`, dedupeKey, raisedAt: nowIso() });
        }
      }
      await this.audit.record(p, { action: "equipment.fault_report", targetType: "equipment", targetId: id, hubId: eq.hubId, reason: input.notes, metadata: { sessionId: input.sessionId ?? null } }, tx);
      return event;
    });
  }

  async resolveFault(p: StaffPrincipal, id: string, body: unknown) {
    const input = parse(resolveSchema, body);
    const eq = await this.load(id);
    await this.access.require(p, EQUIPMENT, { hubId: eq.hubId }, "equipment.fault_resolve");
    return db.transaction(async (tx) => {
      const event = await tx.orm.hub.EquipmentEvent.create({ equipmentId: id, kind: "fault_resolved", occurredAt: nowIso(), reportedById: p.userId, notes: input.notes, statusFrom: eq.status, statusTo: input.status });
      const overdue = !!eq.nextCalibrationDue && eq.nextCalibrationDue < dhakaDate();
      await this.changeStatus(tx, p, eq, overdue ? "calibration_due" : input.status, `Fault resolved: ${input.notes}`);
      await this.audit.record(p, { action: "equipment.fault_resolve", targetType: "equipment", targetId: id, hubId: eq.hubId, reason: input.notes }, tx);
      return { ...event, resultingStatus: overdue ? "calibration_due" : input.status };
    });
  }

  /**
   * Inspection / calibration / maintenance record. This is a logged fact about
   * the device; it is not proof of clinical accuracy (PRD §8.9).
   */
  async logService(p: StaffPrincipal, id: string, body: unknown) {
    const input = parse(serviceEventSchema, body);
    const eq = await this.load(id);
    await this.access.require(p, EQUIPMENT, { hubId: eq.hubId }, "equipment.service_log");
    if (eq.status === "retired") throw conflict("EQUIPMENT_RETIRED", "Retired equipment cannot be serviced");
    const occurredAt = input.occurredAt ?? nowIso();
    return db.transaction(async (tx) => {
      const event = await tx.orm.hub.EquipmentEvent.create({ equipmentId: id, kind: input.kind, occurredAt, reportedById: p.userId, serviceProvider: input.serviceProvider ?? null, nextDueOn: input.nextDueOn ?? null, notes: input.notes ?? null });
      const patch: Record<string, unknown> = {};
      if (input.kind === "inspection") patch.lastInspectedAt = occurredAt;
      if (input.kind === "calibration") {
        patch.lastCalibratedAt = occurredAt;
        if (input.nextDueOn) patch.nextCalibrationDue = input.nextDueOn;
      }
      if (input.serviceProvider) patch.serviceProvider = input.serviceProvider;
      await tx.orm.hub.Equipment.where({ id }).update(patch as never);
      if (input.kind === "calibration" && eq.status === "calibration_due") {
        await this.changeStatus(tx, p, eq, "available", "Calibration recorded");
      }
      await this.audit.record(p, { action: `equipment.${input.kind}`, targetType: "equipment", targetId: id, hubId: eq.hubId, metadata: { nextDueOn: input.nextDueOn ?? null } }, tx);
      return event;
    });
  }

  async history(p: StaffPrincipal, id: string, query: unknown) {
    const page = parse(zPage, query);
    const eq = await this.load(id);
    await this.access.require(p, OPS_READ, { hubId: eq.hubId }, "equipment.history");
    const items = await db.orm.hub.EquipmentEvent.where({ equipmentId: id })
      .include("reportedBy", (u) => u.select("id", "name"))
      .orderBy([(e) => e.occurredAt.desc(), (e) => e.id.desc()])
      .limit(page.limit)
      .offset(page.offset)
      .all();
    return { items, limit: page.limit, offset: page.offset };
  }

  // ---- session equipment ----------------------------------------------------

  async sessionEquipment(p: StaffPrincipal, sessionId: string) {
    const s = found(await db.orm.hub.HubSession.first({ id: sessionId }), "Session");
    await this.access.require(p, [...OPS_READ, ...TEAM], { hubId: s.hubId }, "session_equipment.read");
    return db.orm.hub.SessionEquipment.where({ sessionId })
      .include("equipment", (e) => e.select("id", "assetTag", "category", "make", "model", "status", "nextCalibrationDue", "supportedObservationCodes", "supportedUnits"))
      .include("station", (st) => st.select("id", "code", "name"))
      .all();
  }

  async assign(p: StaffPrincipal, sessionId: string, body: unknown) {
    const input = parse(assignSchema, body);
    const session = found(await db.orm.hub.HubSession.first({ id: sessionId }), "Session");
    await this.access.require(p, [...EQUIPMENT], { hubId: session.hubId }, "session_equipment.assign");
    if (session.status === "completed" || session.status === "cancelled") throw conflict("SESSION_CLOSED", `Session is ${session.status}`);
    const eq = await this.load(input.equipmentId);
    if (eq.hubId !== session.hubId) throw badRequest("EQUIPMENT_HUB_MISMATCH", "Equipment belongs to another hub");
    if (UNASSIGNABLE.includes(eq.status as EquipmentStatus)) throw conflict("EQUIPMENT_UNAVAILABLE", `Equipment is ${eq.status}`);
    if (eq.nextCalibrationDue && eq.nextCalibrationDue < session.sessionDate && input.mandatory) {
      throw conflict("CALIBRATION_OVERDUE", "Equipment calibration is overdue for this session date");
    }
    await this.assertStation(input.stationId, session.hubId);

    return db.transaction(async (tx) => {
      // Lock the equipment row so two concurrent assignments cannot both pass the overlap check.
      await tx.orm.hub.Equipment.where({ id: eq.id }).forNoKeyUpdate().first();
      const links = await tx.orm.hub.SessionEquipment.where({ equipmentId: eq.id })
        .include("session", (s) => s.select("id", "status", "startsAt", "endsAt"))
        .all();
      const clash = links.find(
        (l) => l.session && l.session.id !== sessionId && (LIVE_SESSIONS as readonly string[]).includes(l.session.status) && toDate(l.session.startsAt)!.getTime() < toDate(session.endsAt)!.getTime() && toDate(l.session.endsAt)!.getTime() > toDate(session.startsAt)!.getTime(),
      );
      if (clash) throw conflict("EQUIPMENT_DOUBLE_BOOKED", "Equipment is already assigned to an overlapping session", { sessionId: clash.session!.id });
      const existing = links.find((l) => l.session?.id === sessionId);
      if (existing) throw conflict("ALREADY_ASSIGNED", "Equipment is already assigned to this session");
      const link = await tx.orm.hub.SessionEquipment.create({ sessionId, equipmentId: eq.id, stationId: input.stationId ?? null, mandatory: input.mandatory });
      if (eq.status === "available") await tx.orm.hub.Equipment.where({ id: eq.id }).update({ status: "assigned" });
      await this.audit.record(p, { action: "session_equipment.assign", targetType: "session", targetId: sessionId, hubId: session.hubId, metadata: { equipmentId: eq.id, mandatory: input.mandatory } }, tx);
      return link;
    });
  }

  async unassign(p: StaffPrincipal, sessionId: string, equipmentId: string) {
    const session = found(await db.orm.hub.HubSession.first({ id: sessionId }), "Session");
    await this.access.require(p, EQUIPMENT, { hubId: session.hubId }, "session_equipment.unassign");
    const link = found(await db.orm.hub.SessionEquipment.where({ sessionId, equipmentId }).first(), "Session equipment");
    return db.transaction(async (tx) => {
      await tx.orm.hub.SessionEquipment.where({ id: link.id }).delete();
      const remaining = await tx.orm.hub.SessionEquipment.where({ equipmentId })
        .include("session", (s) => s.select("status"))
        .all();
      const stillAssigned = remaining.some((r) => r.session && (LIVE_SESSIONS as readonly string[]).includes(r.session.status));
      const eq = await tx.orm.hub.Equipment.select("status").first({ id: equipmentId });
      if (eq?.status === "assigned" && !stillAssigned) await tx.orm.hub.Equipment.where({ id: equipmentId }).update({ status: "available" });
      await this.audit.record(p, { action: "session_equipment.unassign", targetType: "session", targetId: sessionId, hubId: session.hubId, metadata: { equipmentId } }, tx);
      return { unassigned: true };
    });
  }
}

const Id = (name = "id") => Param(name, new ParseUUIDPipe());

/** Device inventory, status, faults, calibration history and session allocation (PRD §8.9). */
@Controller()
class EquipmentController {
  constructor(@Inject(EquipmentService) private readonly equipment: EquipmentService) {}

  @Post("equipment")
  register(@Staff() p: StaffPrincipal, @Body() body: unknown) {
    return this.equipment.register(p, body);
  }

  @Get("equipment")
  list(@Staff() p: StaffPrincipal, @Query() query: unknown) {
    return this.equipment.list(p, query);
  }

  @Get("equipment/:id")
  get(@Staff() p: StaffPrincipal, @Id() id: string) {
    return this.equipment.get(p, id);
  }

  @Patch("equipment/:id")
  update(@Staff() p: StaffPrincipal, @Id() id: string, @Body() body: unknown) {
    return this.equipment.update(p, id, body);
  }

  @Post("equipment/:id/status")
  status(@Staff() p: StaffPrincipal, @Id() id: string, @Body() body: unknown) {
    return this.equipment.setStatus(p, id, body);
  }

  @Post("equipment/:id/retire")
  retire(@Staff() p: StaffPrincipal, @Id() id: string, @Body() body: unknown) {
    return this.equipment.retire(p, id, parse(reasonSchema, body).reason);
  }

  @Post("equipment/:id/faults")
  fault(@Staff() p: StaffPrincipal, @Id() id: string, @Body() body: unknown) {
    return this.equipment.reportFault(p, id, body);
  }

  @Post("equipment/:id/faults/resolve")
  resolve(@Staff() p: StaffPrincipal, @Id() id: string, @Body() body: unknown) {
    return this.equipment.resolveFault(p, id, body);
  }

  @Post("equipment/:id/service-events")
  service(@Staff() p: StaffPrincipal, @Id() id: string, @Body() body: unknown) {
    return this.equipment.logService(p, id, body);
  }

  @Get("equipment/:id/events")
  history(@Staff() p: StaffPrincipal, @Id() id: string, @Query() query: unknown) {
    return this.equipment.history(p, id, query);
  }

  @Get("sessions/:sessionId/equipment")
  sessionEquipment(@Staff() p: StaffPrincipal, @Id("sessionId") sessionId: string) {
    return this.equipment.sessionEquipment(p, sessionId);
  }

  @Post("sessions/:sessionId/equipment")
  assign(@Staff() p: StaffPrincipal, @Id("sessionId") sessionId: string, @Body() body: unknown) {
    return this.equipment.assign(p, sessionId, body);
  }

  @Delete("sessions/:sessionId/equipment/:equipmentId")
  unassign(@Staff() p: StaffPrincipal, @Id("sessionId") sessionId: string, @Id("equipmentId") equipmentId: string) {
    return this.equipment.unassign(p, sessionId, equipmentId);
  }
}

@Module({ controllers: [EquipmentController], providers: [EquipmentService] })
export class EquipmentModule {}

