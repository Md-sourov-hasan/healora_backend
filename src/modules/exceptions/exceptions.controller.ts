import { Body, Controller, Get, Inject, Param, Post, Query } from "@nestjs/common";

import { AccessService } from "../../common/access.service.ts";
import { AuditService } from "../../common/audit.service.ts";
import { Staff } from "../../common/auth/decorators.ts";
import type { StaffPrincipal } from "../../common/auth/principal.ts";
import { db, nowIso } from "../../common/db.ts";
import { conflict, found } from "../../common/errors.ts";
import { HUB_FLOOR, HUB_MANAGEMENT, OPS_READ, REGIONAL } from "../../common/roles.ts";
import { parse, z, zId, zPage, zReason } from "../../common/validation.ts";
import { ExceptionScanner } from "./exception-scanner.service.ts";

const WORKERS = [...HUB_FLOOR, "equipment_officer"] as const;
const OPEN = ["open", "acknowledged", "escalated"];

const zFilter = zPage.extend({
  hubId: zId.optional(),
  sessionId: zId.optional(),
  type: z.string().max(60).optional(),
  status: z.enum(["open", "acknowledged", "escalated", "resolved", "dismissed", "active"]).default("active"),
  severity: z.enum(["low", "medium", "high", "critical"]).optional(),
});

/** Operational exception queue (PRD §8.10). */
@Controller("exceptions")
export class ExceptionsController {
  constructor(
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ExceptionScanner) private readonly scanner: ExceptionScanner,
  ) {}

  @Get()
  async list(@Staff() p: StaffPrincipal, @Query() q: unknown) {
    const f = parse(zFilter, q);
    const scope = await this.access.hubScope(p, OPS_READ);
    if (scope !== "all" && scope.length === 0) return { items: [], limit: f.limit, offset: f.offset };
    if (f.hubId) this.access.assertInScope(scope, f.hubId);
    let query = db.orm.hub.OperationalException.where((e) => (scope === "all" ? e.id.isNotNull() : e.hubId.in(scope)));
    if (f.hubId) query = query.where({ hubId: f.hubId });
    if (f.sessionId) query = query.where({ sessionId: f.sessionId });
    if (f.type) query = query.where((e) => e.type.eq(f.type as never));
    if (f.severity) query = query.where({ severity: f.severity });
    query = f.status === "active" ? query.where((e) => e.status.in(["open", "acknowledged", "escalated"])) : query.where({ status: f.status });
    const items = await query
      .include("hub", (h) => h.select("id", "code", "name"))
      .include("assignedTo", (u) => u.select("id", "name"))
      .orderBy([(e) => e.raisedAt.desc()])
      .limit(f.limit)
      .offset(f.offset)
      .all();
    return { items, limit: f.limit, offset: f.offset };
  }

  /** Re-run detection now (also runs on a timer). */
  @Post("scan")
  async scan(@Staff() p: StaffPrincipal) {
    await this.access.require(p, REGIONAL, undefined, "exceptions.scan");
    return this.scanner.scan();
  }

  @Get(":id")
  async get(@Staff() p: StaffPrincipal, @Param("id") id: string) {
    const ex = await this.load(id);
    await this.access.require(p, OPS_READ, { hubId: ex.hubId }, "exception.read");
    return ex;
  }

  @Post(":id/acknowledge")
  async acknowledge(@Staff() p: StaffPrincipal, @Param("id") id: string) {
    const ex = await this.load(id);
    await this.access.require(p, WORKERS, { hubId: ex.hubId }, "exception.acknowledge");
    return this.change(p, id, ["open"], { status: "acknowledged" }, "exception.acknowledged");
  }

  @Post(":id/assign")
  async assign(@Staff() p: StaffPrincipal, @Param("id") id: string, @Body() body: unknown) {
    const ex = await this.load(id);
    await this.access.require(p, WORKERS, { hubId: ex.hubId }, "exception.assign");
    const { userId } = parse(z.object({ userId: zId }), body);
    const user = found(await db.orm.identity.User.select("id", "status").first({ id: userId }), "User");
    if (user.status !== "active") throw conflict("USER_NOT_ACTIVE", "User is not active");
    return this.change(p, id, OPEN, { assignedToId: userId }, "exception.assigned", null, { assigneeUserId: userId });
  }

  @Post(":id/escalate")
  async escalate(@Staff() p: StaffPrincipal, @Param("id") id: string, @Body() body: unknown) {
    const ex = await this.load(id);
    await this.access.require(p, WORKERS, { hubId: ex.hubId }, "exception.escalate");
    const { to, note } = parse(z.object({ to: z.enum(["regional_operations", "clinical_operations"]), note: zReason }), body);
    return this.change(p, id, ["open", "acknowledged"], { status: "escalated", escalatedAt: nowIso(), escalatedTo: `${to}: ${note}`.slice(0, 500) }, "exception.escalated", note, { to });
  }

  @Post(":id/resolve")
  async resolve(@Staff() p: StaffPrincipal, @Param("id") id: string, @Body() body: unknown) {
    const ex = await this.load(id);
    await this.access.require(p, WORKERS, { hubId: ex.hubId }, "exception.resolve");
    const { note } = parse(z.object({ note: zReason }), body);
    return this.change(p, id, OPEN, { status: "resolved", resolvedAt: nowIso(), resolvedById: p.userId, resolutionNote: note }, "exception.resolved", note);
  }

  @Post(":id/dismiss")
  async dismiss(@Staff() p: StaffPrincipal, @Param("id") id: string, @Body() body: unknown) {
    const ex = await this.load(id);
    await this.access.require(p, HUB_MANAGEMENT, { hubId: ex.hubId }, "exception.dismiss");
    const { reason } = parse(z.object({ reason: zReason }), body);
    return this.change(p, id, OPEN, { status: "dismissed", resolvedAt: nowIso(), resolvedById: p.userId, resolutionNote: reason }, "exception.dismissed", reason);
  }

  private async load(id: string) {
    parse(zId, id);
    return found(await db.orm.hub.OperationalException.first({ id }), "Exception");
  }

  private change(p: StaffPrincipal, id: string, from: readonly string[], patch: Record<string, unknown>, action: string, reason: string | null = null, metadata?: Record<string, unknown>) {
    return db.transaction(async (tx) => {
      const ex = found(await tx.orm.hub.OperationalException.where({ id }).forNoKeyUpdate().first(), "Exception");
      if (!from.includes(ex.status)) throw conflict("INVALID_TRANSITION", `Exception is ${ex.status}`);
      const updated = await tx.orm.hub.OperationalException.where({ id }).update(patch as never);
      await this.audit.record(p, { action, targetType: "operational_exception", targetId: id, hubId: ex.hubId, reason, metadata: { type: ex.type, from: ex.status, ...metadata } }, tx);
      return updated;
    });
  }
}
