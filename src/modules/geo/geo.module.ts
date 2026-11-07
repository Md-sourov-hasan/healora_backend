import { Body, Controller, Get, Inject, Module, Param, Patch, Post, Query } from "@nestjs/common";

import { AccessService } from "../../common/access.service.ts";
import { AuditService } from "../../common/audit.service.ts";
import { Staff } from "../../common/auth/decorators.ts";
import type { StaffPrincipal } from "../../common/auth/principal.ts";
import { db } from "../../common/db.ts";
import { badRequest, conflict, found } from "../../common/errors.ts";
import { ADMIN, TEAM, OPS_READ, CLINICAL_GOVERNANCE } from "../../common/roles.ts";
import { parse, z, zId, zReason } from "../../common/validation.ts";

const LEVELS = ["operational_region", "division", "district", "upazila", "union", "ward", "village"] as const;
const ANY_STAFF = [...new Set([...OPS_READ, ...TEAM, ...CLINICAL_GOVERNANCE])];

const createSchema = z.object({
  code: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(200),
  nameBn: z.string().trim().max(200).optional(),
  level: z.enum(LEVELS),
  parentId: zId.optional(),
});
const updateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  nameBn: z.string().trim().max(200).nullable().optional(),
  level: z.enum(LEVELS).optional(),
  parentId: zId.nullable().optional(),
});

@Controller("regions")
class RegionsController {
  constructor(
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Get()
  async list(@Staff() p: StaffPrincipal, @Query() q: unknown) {
    await this.access.require(p, ANY_STAFF, undefined, "region.list");
    const f = parse(
      z.object({ parentId: zId.optional(), level: z.enum(LEVELS).optional(), q: z.string().optional(), includeInactive: z.coerce.boolean().default(false) }),
      q,
    );
    let c = db.orm.hub.Region.orderBy((r) => r.name.asc());
    if (f.parentId) c = c.where({ parentId: f.parentId });
    if (f.level) c = c.where({ level: f.level });
    if (f.q) c = c.where((r) => r.name.ilike(`%${f.q}%`));
    if (!f.includeInactive) c = c.where({ status: "active" });
    return { items: await c.limit(1000).all() };
  }

  /** Whole region tree (active regions), nested by parentId. */
  @Get("tree")
  async tree(@Staff() p: StaffPrincipal) {
    await this.access.require(p, ANY_STAFF, undefined, "region.tree");
    const rows = await db.orm.hub.Region.where({ status: "active" }).orderBy((r) => r.name.asc()).all();
    type Node = (typeof rows)[number] & { children: Node[] };
    const byId = new Map<string, Node>(rows.map((r) => [r.id, { ...r, children: [] }]));
    const roots: Node[] = [];
    for (const n of byId.values()) {
      const parent = n.parentId ? byId.get(n.parentId) : undefined;
      if (parent) parent.children.push(n);
      else roots.push(n);
    }
    return { items: roots };
  }

  @Get(":id")
  async get(@Staff() p: StaffPrincipal, @Param("id") id: string) {
    await this.access.require(p, ANY_STAFF, undefined, "region.get");
    const region = found(await db.orm.hub.Region.first({ id: parse(zId, id) }), "Region");
    const children = await db.orm.hub.Region.select("id", "code", "name", "level", "status").where({ parentId: region.id }).all();
    return { ...region, ancestors: (await this.access.regionAncestors(region.id)).slice(1), children };
  }

  @Post()
  async create(@Staff() p: StaffPrincipal, @Body() body: unknown) {
    await this.access.require(p, ADMIN, undefined, "region.create");
    const input = parse(createSchema, body);
    if (input.parentId) found(await db.orm.hub.Region.first({ id: input.parentId }), "Parent region");
    return db.transaction(async (tx) => {
      const region = await tx.orm.hub.Region.create({ ...input, nameBn: input.nameBn ?? null, parentId: input.parentId ?? null });
      await this.audit.record(p, { action: "region.create", targetType: "region", targetId: region.id, regionId: region.id }, tx);
      return region;
    });
  }

  @Patch(":id")
  async update(@Staff() p: StaffPrincipal, @Param("id") id: string, @Body() body: unknown) {
    await this.access.require(p, ADMIN, undefined, "region.update");
    const regionId = parse(zId, id);
    const input = parse(updateSchema, body);
    found(await db.orm.hub.Region.first({ id: regionId }), "Region");
    if (input.parentId) {
      if (input.parentId === regionId) throw badRequest("REGION_CYCLE", "A region cannot be its own parent");
      const chain = await this.access.regionAncestors(input.parentId);
      if (chain.includes(regionId)) throw badRequest("REGION_CYCLE", "Parent would create a cycle");
    }
    return db.transaction(async (tx) => {
      const region = await tx.orm.hub.Region.where({ id: regionId }).update(input);
      await this.audit.record(p, { action: "region.update", targetType: "region", targetId: regionId, regionId, metadata: { fields: Object.keys(input) } }, tx);
      return region;
    });
  }

  @Post(":id/deactivate")
  async deactivate(@Staff() p: StaffPrincipal, @Param("id") id: string, @Body() body: unknown) {
    await this.access.require(p, ADMIN, undefined, "region.deactivate");
    const regionId = parse(zId, id);
    const { reason } = parse(z.object({ reason: zReason }), body);
    found(await db.orm.hub.Region.first({ id: regionId }), "Region");
    const activeHub = await db.orm.hub.Hub.select("id").where({ regionId }).where((h) => h.status.in(["active", "paused", "temporarily_closed"])).first();
    if (activeHub) throw conflict("REGION_IN_USE", "Region still has operating hubs");
    const activeChild = await db.orm.hub.Region.select("id").where({ parentId: regionId, status: "active" }).first();
    if (activeChild) throw conflict("REGION_IN_USE", "Region still has active child regions");
    return db.transaction(async (tx) => {
      const region = await tx.orm.hub.Region.where({ id: regionId }).update({ status: "inactive" });
      await this.audit.record(p, { action: "region.deactivate", targetType: "region", targetId: regionId, regionId, reason }, tx);
      return region;
    });
  }
}

@Module({ controllers: [RegionsController] })
export class GeoModule {}
