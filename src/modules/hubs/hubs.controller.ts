import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Put, Query } from "@nestjs/common";
import { or } from "@prisma/orm-postgres/orm-client";

import { AccessService } from "../../common/access.service.ts";
import { AuditService } from "../../common/audit.service.ts";
import { Staff } from "../../common/auth/decorators.ts";
import type { StaffPrincipal } from "../../common/auth/principal.ts";
import { db, nowIso } from "../../common/db.ts";
import { EventsService } from "../../common/events.service.ts";
import { badRequest, conflict, found, unprocessable } from "../../common/errors.ts";
import { CLINICAL_GOVERNANCE, HUB_MANAGEMENT, OPS_READ, REGIONAL, TEAM } from "../../common/roles.ts";
import { parse, z, zDecimal, zId, zInstant, zPage, zPhone, zReason, zTime } from "../../common/validation.ts";
import { HubsService } from "./hubs.service.ts";

const HUB_STATUSES = ["draft", "active", "paused", "temporarily_closed", "permanently_closed"] as const;
const OPERATOR_TYPES = ["healora_owned", "partner_clinic", "rented", "temporary_site"] as const;
const HUB_READ = [...new Set([...OPS_READ, ...TEAM, ...CLINICAL_GOVERNANCE])];

const profileFields = {
  name: z.string().trim().min(1).max(200),
  nameBn: z.string().trim().max(200).nullable(),
  addressLine: z.string().trim().min(1).max(500),
  addressLineBn: z.string().trim().max(500).nullable(),
  latitude: zDecimal.nullable(),
  longitude: zDecimal.nullable(),
  directions: z.string().max(2000).nullable(),
  directionsBn: z.string().max(2000).nullable(),
  contactPhone: zPhone.nullable(),
  languages: z.array(z.string().min(2).max(10)).max(10),
  accessibilityNotes: z.string().max(2000).nullable(),
  emergencyContactName: z.string().max(200).nullable(),
  emergencyContactPhone: zPhone.nullable(),
  nearestReferralFacility: z.string().max(300).nullable(),
  referralFacilityPhone: zPhone.nullable(),
  referralInstructions: z.string().max(4000).nullable(),
  operatorName: z.string().max(200).nullable(),
};
/** Changing these changes scope/identity: regional+ only. */
const restrictedFields = {
  code: z.string().trim().min(2).max(30).regex(/^[A-Za-z0-9-_]+$/),
  regionId: zId,
  operatorType: z.enum(OPERATOR_TYPES),
  timezone: z.string().min(3).max(64),
};

const createSchema = z.object({
  ...restrictedFields,
  ...profileFields,
  nameBn: profileFields.nameBn.optional(),
  addressLineBn: profileFields.addressLineBn.optional(),
  latitude: profileFields.latitude.optional(),
  longitude: profileFields.longitude.optional(),
  directions: profileFields.directions.optional(),
  directionsBn: profileFields.directionsBn.optional(),
  contactPhone: profileFields.contactPhone.optional(),
  languages: profileFields.languages.default(["bn"]),
  accessibilityNotes: profileFields.accessibilityNotes.optional(),
  emergencyContactName: profileFields.emergencyContactName.optional(),
  emergencyContactPhone: profileFields.emergencyContactPhone.optional(),
  nearestReferralFacility: profileFields.nearestReferralFacility.optional(),
  referralFacilityPhone: profileFields.referralFacilityPhone.optional(),
  referralInstructions: profileFields.referralInstructions.optional(),
  operatorName: profileFields.operatorName.optional(),
  operatorType: restrictedFields.operatorType.default("healora_owned"),
  timezone: restrictedFields.timezone.default("Asia/Dhaka"),
});
const updateSchema = z.object({ ...profileFields, ...restrictedFields }).partial();

const hoursSchema = z.object({
  hours: z
    .array(z.object({ dayOfWeek: z.number().int().min(1).max(7), opensAt: zTime, closesAt: zTime }))
    .max(28),
});

const blockSchema = z.object({
  blockType: z.enum(["closure", "pause", "capacity_block"]),
  startsAt: zInstant,
  endsAt: zInstant.nullable().optional(),
  remainingCapacityPct: z.number().int().min(0).max(100).optional(),
  reason: zReason,
});

const MANAGER_FIELDS = new Set(Object.keys(profileFields));

@Controller("hubs")
export class HubsController {
  constructor(
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(EventsService) private readonly events: EventsService,
    @Inject(HubsService) private readonly hubs: HubsService,
  ) {}

  // ---- hub profile ----------------------------------------------------------

  @Post()
  async create(@Staff() p: StaffPrincipal, @Body() body: unknown) {
    const input = parse(createSchema, body);
    found(await db.orm.hub.Region.first({ id: input.regionId }), "Region");
    await this.access.require(p, REGIONAL, { regionId: input.regionId }, "hub.create");
    return db.transaction(async (tx) => {
      const hub = await tx.orm.hub.Hub.create({ ...input, status: "draft", createdById: p.userId } as never);
      await this.audit.record(p, { action: "hub.create", targetType: "hub", targetId: hub.id, hubId: hub.id, regionId: hub.regionId }, tx);
      await this.events.emit(tx, { eventType: "hub.created", aggregateType: "hub", aggregateId: hub.id, hubId: hub.id, correlationId: p.correlationId, payload: { hubId: hub.id, code: hub.code, status: hub.status, regionId: hub.regionId } });
      return hub;
    });
  }

  @Get()
  async list(@Staff() p: StaffPrincipal, @Query() query: unknown) {
    await this.access.require(p, HUB_READ, undefined, "hub.list");
    const f = parse(zPage.extend({ regionId: zId.optional(), status: z.enum(HUB_STATUSES).optional(), q: z.string().max(100).optional() }), query);
    const scope = await this.access.hubScope(p, HUB_READ);
    if (scope !== "all" && scope.length === 0) return { items: [], total: 0, limit: f.limit, offset: f.offset };
    let c = db.orm.hub.Hub.orderBy((h) => h.name.asc());
    if (scope !== "all") c = c.where((h) => h.id.in(scope));
    if (f.regionId) {
      const regions = await this.access.regionDescendants([f.regionId]);
      c = c.where((h) => h.regionId.in(regions));
    }
    if (f.status) c = c.where({ status: f.status });
    if (f.q) c = c.where((h) => or(h.name.ilike(`%${f.q}%`), h.code.ilike(`%${f.q}%`)));
    const total = (await c.aggregate((a) => ({ n: a.count() }))).n;
    const items = await c
      .select("id", "code", "name", "nameBn", "status", "regionId", "addressLine", "contactPhone", "managerUserId", "operatorType", "updatedAt")
      .include("region", (r) => r.select("id", "name", "level"))
      .limit(f.limit)
      .offset(f.offset)
      .all();
    return { items, total, limit: f.limit, offset: f.offset };
  }

  @Get(":id")
  async get(@Staff() p: StaffPrincipal, @Param("id") id: string) {
    const hubId = parse(zId, id);
    await this.hubs.loadHub(hubId);
    await this.access.require(p, HUB_READ, { hubId }, "hub.get");
    const hub = found(
      await db.orm.hub.Hub.where({ id: hubId })
        .include("region", (r) => r.select("id", "code", "name", "level"))
        .include("manager", (u) => u.select("id", "name", "phone"))
        .include("regionalOwner", (u) => u.select("id", "name", "phone"))
        .first(),
      "Hub",
    );
    // Sequential on purpose: keeps one pooled connection per request.
    const hours = await db.orm.hub.HubOperatingHours.where({ hubId }).orderBy([(h) => h.dayOfWeek.asc(), (h) => h.opensAt.asc()]).all();
    const catchments = await db.orm.hub.HubCatchment.where({ hubId }).include("region", (r) => r.select("id", "code", "name", "level")).all();
    const offerings = await db.orm.hub.HubServiceOffering.where({ hubId }).include("serviceType", (s) => s.select("id", "code", "name", "nameBn")).all();
    const activeBlocks = await db.orm.hub.HubAvailabilityBlock.where({ hubId }).where((b) => b.liftedAt.isNull()).where((b) => or(b.endsAt.isNull(), b.endsAt.gt(nowIso()))).all();
    return { ...hub, operatingHours: hours, catchments, serviceOfferings: offerings, activeBlocks };
  }

  @Patch(":id")
  async update(@Staff() p: StaffPrincipal, @Param("id") id: string, @Body() body: unknown) {
    const hubId = parse(zId, id);
    const hub = await this.hubs.loadHub(hubId);
    const input = parse(updateSchema, body);
    const fields = Object.keys(input);
    if (fields.length === 0) throw badRequest("NO_CHANGES", "No fields to update");
    const restricted = fields.some((f) => !MANAGER_FIELDS.has(f));
    await this.access.require(p, restricted ? REGIONAL : HUB_MANAGEMENT, { hubId }, "hub.update");
    if (input.regionId && input.regionId !== hub.regionId) {
      found(await db.orm.hub.Region.first({ id: input.regionId }), "Region");
      await this.access.require(p, REGIONAL, { regionId: input.regionId }, "hub.move_region");
    }
    if (hub.status === "permanently_closed") throw conflict("HUB_CLOSED", "A permanently closed hub cannot be edited");
    return db.transaction(async (tx) => {
      const updated = await tx.orm.hub.Hub.where({ id: hubId }).update({ ...input, updatedById: p.userId } as never);
      await this.audit.record(p, { action: "hub.update", targetType: "hub", targetId: hubId, hubId, regionId: hub.regionId, metadata: { fields } }, tx);
      await this.events.emit(tx, { eventType: "hub.updated", aggregateType: "hub", aggregateId: hubId, hubId, correlationId: p.correlationId, payload: { hubId, fields } });
      return updated;
    });
  }

  @Post(":id/status")
  async status(@Staff() p: StaffPrincipal, @Param("id") id: string, @Body() body: unknown) {
    const input = parse(z.object({ status: z.enum(HUB_STATUSES), reason: zReason, until: zInstant.nullable().optional() }), body);
    return this.hubs.changeStatus(p, parse(zId, id), input.status, input.reason, input.until ?? null);
  }

  @Put(":id/manager")
  async setManager(@Staff() p: StaffPrincipal, @Param("id") id: string, @Body() body: unknown) {
    const hubId = parse(zId, id);
    const hub = await this.hubs.loadHub(hubId);
    await this.access.require(p, REGIONAL, { hubId }, "hub.assign_manager");
    const { userId } = parse(z.object({ userId: zId.nullable() }), body);
    if (userId && !(await this.hubs.userHoldsRoleFor(userId, ["hub_manager"], hubId))) {
      throw unprocessable("ROLE_REQUIRED", "User must hold an active hub_manager assignment covering this hub");
    }
    return db.transaction(async (tx) => {
      const updated = await tx.orm.hub.Hub.where({ id: hubId }).update({ managerUserId: userId, updatedById: p.userId });
      await this.audit.record(p, { action: "hub.assign_manager", targetType: "hub", targetId: hubId, hubId, regionId: hub.regionId, metadata: { from: hub.managerUserId, to: userId } }, tx);
      await this.events.emit(tx, { eventType: "hub.updated", aggregateType: "hub", aggregateId: hubId, hubId, correlationId: p.correlationId, payload: { hubId, fields: ["managerUserId"] } });
      return updated;
    });
  }

  @Put(":id/regional-owner")
  async setRegionalOwner(@Staff() p: StaffPrincipal, @Param("id") id: string, @Body() body: unknown) {
    const hubId = parse(zId, id);
    const hub = await this.hubs.loadHub(hubId);
    await this.access.require(p, REGIONAL, { hubId }, "hub.assign_regional_owner");
    const { userId } = parse(z.object({ userId: zId.nullable() }), body);
    if (userId && !(await this.hubs.userHoldsRoleFor(userId, ["regional_ops_manager"], hubId))) {
      throw unprocessable("ROLE_REQUIRED", "User must hold an active regional_ops_manager assignment covering this hub's region");
    }
    return db.transaction(async (tx) => {
      const updated = await tx.orm.hub.Hub.where({ id: hubId }).update({ regionalOwnerUserId: userId, updatedById: p.userId });
      await this.audit.record(p, { action: "hub.assign_regional_owner", targetType: "hub", targetId: hubId, hubId, regionId: hub.regionId, metadata: { from: hub.regionalOwnerUserId, to: userId } }, tx);
      return updated;
    });
  }

  // ---- catchments -----------------------------------------------------------

  @Get(":id/catchments")
  async catchments(@Staff() p: StaffPrincipal, @Param("id") id: string) {
    const hubId = parse(zId, id);
    await this.hubs.loadHub(hubId);
    await this.access.require(p, HUB_READ, { hubId }, "hub.catchments.list");
    return { items: await db.orm.hub.HubCatchment.where({ hubId }).include("region", (r) => r.select("id", "code", "name", "level")).all() };
  }

  @Post(":id/catchments")
  async addCatchment(@Staff() p: StaffPrincipal, @Param("id") id: string, @Body() body: unknown) {
    const hubId = parse(zId, id);
    const hub = await this.hubs.loadHub(hubId);
    await this.access.require(p, REGIONAL, { hubId }, "hub.catchments.add");
    const input = parse(z.object({ regionId: zId, isPrimary: z.boolean().default(true) }), body);
    found(await db.orm.hub.Region.first({ id: input.regionId }), "Region");
    return db.transaction(async (tx) => {
      const row = await tx.orm.hub.HubCatchment.create({ hubId, ...input });
      await this.audit.record(p, { action: "hub.catchment.add", targetType: "hub", targetId: hubId, hubId, regionId: hub.regionId, metadata: { regionId: input.regionId, isPrimary: input.isPrimary } }, tx);
      await this.events.emit(tx, { eventType: "hub.updated", aggregateType: "hub", aggregateId: hubId, hubId, correlationId: p.correlationId, payload: { hubId, fields: ["catchments"] } });
      return row;
    });
  }

  @Delete(":id/catchments/:regionId")
  async removeCatchment(@Staff() p: StaffPrincipal, @Param("id") id: string, @Param("regionId") rid: string) {
    const hubId = parse(zId, id);
    const regionId = parse(zId, rid);
    const hub = await this.hubs.loadHub(hubId);
    await this.access.require(p, REGIONAL, { hubId }, "hub.catchments.remove");
    found(await db.orm.hub.HubCatchment.where({ hubId, regionId }).first(), "Catchment");
    return db.transaction(async (tx) => {
      await tx.orm.hub.HubCatchment.where({ hubId, regionId }).delete();
      await this.audit.record(p, { action: "hub.catchment.remove", targetType: "hub", targetId: hubId, hubId, regionId: hub.regionId, metadata: { regionId } }, tx);
      await this.events.emit(tx, { eventType: "hub.updated", aggregateType: "hub", aggregateId: hubId, hubId, correlationId: p.correlationId, payload: { hubId, fields: ["catchments"] } });
      return { removed: true };
    });
  }

  // ---- operating hours ------------------------------------------------------

  @Get(":id/operating-hours")
  async getHours(@Staff() p: StaffPrincipal, @Param("id") id: string) {
    const hubId = parse(zId, id);
    await this.hubs.loadHub(hubId);
    await this.access.require(p, HUB_READ, { hubId }, "hub.hours.get");
    return { items: await db.orm.hub.HubOperatingHours.where({ hubId }).orderBy([(h) => h.dayOfWeek.asc(), (h) => h.opensAt.asc()]).all() };
  }

  /** Replace the full weekly schedule. Multiple windows per day allowed; they must not overlap. */
  @Put(":id/operating-hours")
  async putHours(@Staff() p: StaffPrincipal, @Param("id") id: string, @Body() body: unknown) {
    const hubId = parse(zId, id);
    const hub = await this.hubs.loadHub(hubId);
    await this.access.require(p, HUB_MANAGEMENT, { hubId }, "hub.hours.put");
    const { hours } = parse(hoursSchema, body);
    const norm = (t: string) => (t.length === 5 ? `${t}:00` : t);
    const byDay = new Map<number, { opensAt: string; closesAt: string }[]>();
    for (const h of hours) {
      const o = norm(h.opensAt);
      const c = norm(h.closesAt);
      if (c <= o) throw badRequest("INVALID_HOURS", `Day ${h.dayOfWeek}: closing time must be after opening time`);
      const list = byDay.get(h.dayOfWeek) ?? [];
      if (list.some((x) => o < x.closesAt && x.opensAt < c)) throw badRequest("INVALID_HOURS", `Day ${h.dayOfWeek}: windows overlap`);
      list.push({ opensAt: o, closesAt: c });
      byDay.set(h.dayOfWeek, list);
    }
    return db.transaction(async (tx) => {
      await tx.orm.hub.HubOperatingHours.where({ hubId }).deleteAll();
      for (const [dayOfWeek, list] of byDay) for (const w of list) await tx.orm.hub.HubOperatingHours.create({ hubId, dayOfWeek, ...w });
      await this.audit.record(p, { action: "hub.hours.replace", targetType: "hub", targetId: hubId, hubId, regionId: hub.regionId, metadata: { windows: hours.length } }, tx);
      await this.events.emit(tx, { eventType: "hub.updated", aggregateType: "hub", aggregateId: hubId, hubId, correlationId: p.correlationId, payload: { hubId, fields: ["operatingHours"] } });
      return { items: await tx.orm.hub.HubOperatingHours.where({ hubId }).orderBy([(h) => h.dayOfWeek.asc(), (h) => h.opensAt.asc()]).all() };
    });
  }

  // ---- availability blocks (closure / pause / capacity block) ----------------

  @Get(":id/availability-blocks")
  async listBlocks(@Staff() p: StaffPrincipal, @Param("id") id: string, @Query() query: unknown) {
    const hubId = parse(zId, id);
    await this.hubs.loadHub(hubId);
    await this.access.require(p, HUB_READ, { hubId }, "hub.blocks.list");
    const { activeOnly } = parse(z.object({ activeOnly: z.coerce.boolean().default(false) }), query);
    let c = db.orm.hub.HubAvailabilityBlock.where({ hubId }).orderBy((b) => b.startsAt.desc());
    if (activeOnly) c = c.where((b) => b.liftedAt.isNull()).where((b) => or(b.endsAt.isNull(), b.endsAt.gt(nowIso())));
    return { items: await c.limit(200).all() };
  }

  @Post(":id/availability-blocks")
  async createBlock(@Staff() p: StaffPrincipal, @Param("id") id: string, @Body() body: unknown) {
    const hubId = parse(zId, id);
    const hub = await this.hubs.loadHub(hubId);
    await this.access.require(p, HUB_MANAGEMENT, { hubId }, "hub.blocks.create");
    const input = parse(blockSchema, body);
    if (input.endsAt && Date.parse(input.endsAt) <= Date.parse(input.startsAt)) throw badRequest("INVALID_WINDOW", "endsAt must be after startsAt");
    if (input.blockType === "capacity_block" && input.remainingCapacityPct === undefined) throw badRequest("PCT_REQUIRED", "remainingCapacityPct is required for a capacity block");
    if (input.blockType !== "capacity_block" && input.remainingCapacityPct !== undefined) throw badRequest("PCT_NOT_ALLOWED", "remainingCapacityPct applies only to capacity blocks");
    return db.transaction(async (tx) => {
      const block = await tx.orm.hub.HubAvailabilityBlock.create({ hubId, ...input, endsAt: input.endsAt ?? null, remainingCapacityPct: input.remainingCapacityPct ?? null, createdById: p.userId });
      await this.audit.record(p, { action: "hub.block.create", targetType: "hub", targetId: hubId, hubId, regionId: hub.regionId, reason: input.reason, metadata: { blockId: block.id, blockType: input.blockType } }, tx);
      await this.events.emit(tx, { eventType: "hub.updated", aggregateType: "hub", aggregateId: hubId, hubId, correlationId: p.correlationId, payload: { hubId, fields: ["availability"], blockId: block.id } });
      return block;
    });
  }

  @Post(":id/availability-blocks/:blockId/lift")
  async liftBlock(@Staff() p: StaffPrincipal, @Param("id") id: string, @Param("blockId") bid: string, @Body() body: unknown) {
    const hubId = parse(zId, id);
    const blockId = parse(zId, bid);
    const hub = await this.hubs.loadHub(hubId);
    await this.access.require(p, HUB_MANAGEMENT, { hubId }, "hub.blocks.lift");
    const { reason } = parse(z.object({ reason: zReason.optional() }), body);
    const block = found(await db.orm.hub.HubAvailabilityBlock.where({ id: blockId, hubId }).first(), "Availability block");
    if (block.liftedAt) throw conflict("ALREADY_LIFTED", "Block was already lifted");
    return db.transaction(async (tx) => {
      const updated = await tx.orm.hub.HubAvailabilityBlock.where({ id: blockId }).update({ liftedAt: nowIso(), liftedById: p.userId });
      await this.audit.record(p, { action: "hub.block.lift", targetType: "hub", targetId: hubId, hubId, regionId: hub.regionId, reason: reason ?? null, metadata: { blockId } }, tx);
      await this.events.emit(tx, { eventType: "hub.updated", aggregateType: "hub", aggregateId: hubId, hubId, correlationId: p.correlationId, payload: { hubId, fields: ["availability"], blockId } });
      return updated;
    });
  }

  // ---- service offerings ----------------------------------------------------

  @Get(":id/service-offerings")
  async listOfferings(@Staff() p: StaffPrincipal, @Param("id") id: string) {
    const hubId = parse(zId, id);
    await this.hubs.loadHub(hubId);
    await this.access.require(p, HUB_READ, { hubId }, "hub.offerings.list");
    return { items: await db.orm.hub.HubServiceOffering.where({ hubId }).include("serviceType", (s) => s.select("id", "code", "name", "nameBn", "status", "requiresDoctorReview")).all() };
  }

  @Post(":id/service-offerings")
  async proposeOffering(@Staff() p: StaffPrincipal, @Param("id") id: string, @Body() body: unknown) {
    const hubId = parse(zId, id);
    const hub = await this.hubs.loadHub(hubId);
    await this.access.require(p, HUB_MANAGEMENT, { hubId }, "hub.offerings.propose");
    const { serviceTypeId } = parse(z.object({ serviceTypeId: zId }), body);
    const st = found(await db.orm.hub.ServiceType.first({ id: serviceTypeId }), "Service type");
    if (st.status !== "active") throw unprocessable("SERVICE_INACTIVE", "Service type is not active");
    const existing = await db.orm.hub.HubServiceOffering.where({ hubId, serviceTypeId }).first();
    if (existing && existing.status !== "retired") throw conflict("ALREADY_OFFERED", `Offering already exists with status '${existing.status}'`);
    return db.transaction(async (tx) => {
      const row = existing
        ? await tx.orm.hub.HubServiceOffering.where({ id: existing.id }).update({ status: "proposed", approvedById: null, approvedAt: null })
        : await tx.orm.hub.HubServiceOffering.create({ hubId, serviceTypeId, status: "proposed" });
      await this.audit.record(p, { action: "hub.offering.propose", targetType: "hub", targetId: hubId, hubId, regionId: hub.regionId, metadata: { serviceTypeId } }, tx);
      return row;
    });
  }

  @Post(":id/service-offerings/:offeringId/:action")
  async decideOffering(@Staff() p: StaffPrincipal, @Param("id") id: string, @Param("offeringId") oid: string, @Param("action") action: string, @Body() body: unknown) {
    const hubId = parse(zId, id);
    const offeringId = parse(zId, oid);
    const to = parse(z.enum(["approve", "suspend", "retire"]), action);
    const hub = await this.hubs.loadHub(hubId);
    await this.access.require(p, CLINICAL_GOVERNANCE, { hubId }, `hub.offerings.${to}`);
    const { reason } = parse(z.object({ reason: zReason.optional() }), body);
    if (to !== "approve" && !reason) throw badRequest("REASON_REQUIRED", "A reason is required");
    const offering = found(await db.orm.hub.HubServiceOffering.where({ id: offeringId, hubId }).first(), "Service offering");
    const status = to === "approve" ? "approved" : to === "suspend" ? "suspended" : "retired";
    this.hubs.assertMutableOffering(offering.status, status);
    return db.transaction(async (tx) => {
      const updated = await tx.orm.hub.HubServiceOffering.where({ id: offeringId }).update(
        status === "approved" ? { status, approvedById: p.userId, approvedAt: nowIso() } : { status },
      );
      await this.audit.record(p, { action: `hub.offering.${to}`, targetType: "hub", targetId: hubId, hubId, regionId: hub.regionId, reason: reason ?? null, metadata: { offeringId, serviceTypeId: offering.serviceTypeId } }, tx);
      await this.events.emit(tx, { eventType: "hub.updated", aggregateType: "hub", aggregateId: hubId, hubId, correlationId: p.correlationId, payload: { hubId, fields: ["serviceOfferings"] } });
      return updated;
    });
  }

  // ---- staff on this hub (read-only for hub managers) -----------------------

  @Get(":id/staff")
  async staff(@Staff() p: StaffPrincipal, @Param("id") id: string) {
    const hubId = parse(zId, id);
    const hub = await this.hubs.loadHub(hubId);
    await this.access.require(p, HUB_MANAGEMENT, { hubId }, "hub.staff.list");
    const regions = await this.access.regionAncestors(hub.regionId);
    const rows = await db.orm.identity.RoleAssignment.where({ status: "active" })
      .where((r) => or(r.hubId.eq(hubId), r.regionId.in(regions)))
      .include("user", (u) => u.select("id", "name", "nameBn", "phone", "status"))
      .orderBy((r) => r.role.asc())
      .all();
    return {
      items: rows.map((r) => ({ assignmentId: r.id, role: r.role, scopeType: r.scopeType, validFrom: r.validFrom, validTo: r.validTo, user: r.user })),
    };
  }
}
