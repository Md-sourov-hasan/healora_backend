import { Body, Controller, Get, Inject, Injectable, Module, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import { and, or } from "@prisma/orm-postgres/orm-client";

import { AccessService } from "../../common/access.service.ts";
import { AuditService } from "../../common/audit.service.ts";
import { Staff } from "../../common/auth/decorators.ts";
import type { ActiveAssignment, StaffPrincipal } from "../../common/auth/principal.ts";
import { db, dhakaDate, nowIso, toDate, type Tx } from "../../common/db.ts";
import { EventsService } from "../../common/events.service.ts";
import { badRequest, conflict, found, unprocessable } from "../../common/errors.ts";
import { NotificationService } from "../../common/notification.service.ts";
import { CREDENTIALED, HUB_MANAGEMENT, OPS_READ, REGIONAL, type StaffRole } from "../../common/roles.ts";
import { parse, z, zDate, zId, zInstant, zPage, zReason } from "../../common/validation.ts";
import { hasValidCredential } from "../sessions/session-readiness.ts";

type Cond = Parameters<typeof and>[number];

const ROLES = [
  "platform_super_admin",
  "regional_ops_manager",
  "hub_manager",
  "reception_officer",
  "queue_coordinator",
  "equipment_officer",
  "operations_auditor",
  "clinical_ops_admin",
  "special_team_lead",
  "field_health_worker",
  "local_doctor",
  "registered_doctor",
] as const;
const LIVE = ["proposed", "approved", "checked_in"] as const;
const SHIFT_EDGES: Record<string, string[]> = {
  proposed: ["approved", "cancelled"],
  approved: ["checked_in", "absent", "cancelled"],
  checked_in: ["checked_out"],
  checked_out: [],
  absent: [],
  cancelled: [],
};
/** Approving credentialed (clinical) roles needs a regional or clinical-ops role (PRD §8.7). */
const CLINICAL_APPROVERS: StaffRole[] = ["platform_super_admin", "regional_ops_manager", "clinical_ops_admin"];

const createShiftSchema = z.object({
  userId: zId,
  hubId: zId,
  sessionId: zId.optional(),
  stationId: zId.optional(),
  role: z.enum(ROLES),
  startsAt: zInstant,
  endsAt: zInstant,
  overlapOverrideReason: zReason.optional(),
});
const listSchema = z.object({ hubId: zId.optional(), sessionId: zId.optional(), userId: zId.optional(), date: zDate.optional(), status: z.enum(["proposed", "approved", "checked_in", "checked_out", "absent", "cancelled"]).optional() });
const mineSchema = z.object({ from: zDate.optional(), to: zDate.optional() });
const reasonSchema = z.object({ reason: zReason });

function assertShiftTransition(from: string, to: string) {
  if (!SHIFT_EDGES[from]?.includes(to)) throw conflict("INVALID_TRANSITION", `Cannot move shift from '${from}' to '${to}'`, { from, to });
}

/** Day bounds of a Bangladesh calendar date as UTC instants. */
const dayBounds = (date: string) => ({ from: new Date(`${date}T00:00:00+06:00`).toISOString(), to: new Date(`${date}T24:00:00+06:00`).toISOString() });

@Injectable()
class RosterService {
  constructor(
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(EventsService) private readonly events: EventsService,
    @Inject(NotificationService) private readonly notifications: NotificationService,
  ) {}

  /** Target user's active assignments, evaluated with the same scope logic as the caller's. */
  private async userCovers(userId: string, role: StaffRole, hubId: string): Promise<boolean> {
    const user = await db.orm.identity.User.select("id", "status").first({ id: userId });
    if (!user || user.status !== "active") return false;
    const now = nowIso();
    const rows = await db.orm.identity.RoleAssignment.select("id", "role", "scopeType", "regionId", "hubId", "sessionId")
      .where({ userId, status: "active" })
      .where((r) => r.validFrom.lte(now))
      .where((r) => or(r.validTo.isNull(), r.validTo.gt(now)))
      .all();
    const pseudo: StaffPrincipal = {
      kind: "staff",
      userId,
      name: null,
      assignments: rows as ActiveAssignment[],
      ip: null,
      userAgent: null,
      correlationId: "roster-check",
      authSessionId: null,
      deviceInstallationId: null,
      strongAuth: true,
    };
    return this.access.can(pseudo, [role], { hubId });
  }

  async create(p: StaffPrincipal, body: unknown) {
    const input = parse(createShiftSchema, body);
    const hub = found(await db.orm.hub.Hub.first({ id: input.hubId }), "Hub");
    await this.access.require(p, HUB_MANAGEMENT, { hubId: hub.id }, "roster.propose");
    const start = toDate(input.startsAt);
    const end = toDate(input.endsAt);
    if (!start || !end || end <= start) throw badRequest("INVALID_WINDOW", "endsAt must be after startsAt");
    if (input.sessionId) {
      const s = found(await db.orm.hub.HubSession.first({ id: input.sessionId }), "Session");
      if (s.hubId !== hub.id) throw badRequest("SESSION_HUB_MISMATCH", "Session belongs to another hub");
      if (s.status === "cancelled" || s.status === "completed") throw conflict("SESSION_CLOSED", `Session is ${s.status}`);
    }
    if (input.stationId) {
      const st = found(await db.orm.hub.HubStation.first({ id: input.stationId }), "Station");
      if (st.hubId !== hub.id) throw badRequest("STATION_HUB_MISMATCH", "Station belongs to another hub");
    }
    if (!(await this.userCovers(input.userId, input.role, hub.id))) {
      throw unprocessable("ROLE_NOT_ASSIGNED", "The staff member is not active or has no active assignment for this role covering the hub");
    }
    if (CREDENTIALED.includes(input.role) && !(await hasValidCredential(db, input.userId, input.role, dhakaDate(start)))) {
      throw unprocessable("CREDENTIAL_INVALID", "The staff member has no verified, unexpired credential for this role");
    }
    const overlaps = await this.overlapping(input.userId, input.startsAt, input.endsAt);
    if (overlaps.length) {
      if (!input.overlapOverrideReason) throw conflict("SHIFT_OVERLAP", "The staff member already has an overlapping shift", { shiftIds: overlaps.map((o) => o.id) });
      await this.access.require(p, REGIONAL, { hubId: hub.id }, "roster.overlap_override");
    }

    return db.transaction(async (tx) => {
      const shift = await tx.orm.hub.StaffShift.create({
        userId: input.userId,
        hubId: hub.id,
        sessionId: input.sessionId ?? null,
        stationId: input.stationId ?? null,
        role: input.role,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        status: "proposed",
        proposedById: p.userId,
        overlapOverrideReason: overlaps.length ? input.overlapOverrideReason! : null,
      });
      await this.audit.record(p, { action: overlaps.length ? "roster.propose_overlap_override" : "roster.propose", targetType: "staff_shift", targetId: shift.id, hubId: hub.id, reason: input.overlapOverrideReason ?? null, metadata: { userId: input.userId, role: input.role, sessionId: input.sessionId ?? null } }, tx);
      await this.changed(tx, p, shift);
      return shift;
    });
  }

  private overlapping(userId: string, startsAt: string, endsAt: string, excludeId?: string) {
    return db.orm.hub.StaffShift.select("id", "hubId", "startsAt", "endsAt")
      .where({ userId })
      .where((s) => s.status.in([...LIVE]))
      .where((s) => and(s.startsAt.lt(endsAt), s.endsAt.gt(startsAt)))
      .where((s) => (excludeId ? s.id.neq(excludeId) : s.id.isNotNull()))
      .all();
  }

  private async changed(tx: Tx, p: StaffPrincipal, shift: { id: string; userId: string; hubId: string; sessionId: string | null; status: string }) {
    await this.notifications.enqueue(tx, { template: "staff.roster_changed", userId: shift.userId, relatedType: "staff_shift", relatedId: shift.id, deepLink: "healora-team://shifts" });
    await this.events.emit(tx, { eventType: "roster.changed", aggregateType: "staff_shift", aggregateId: shift.id, hubId: shift.hubId, sessionId: shift.sessionId, correlationId: p.correlationId, payload: { shiftId: shift.id, userId: shift.userId, status: shift.status } });
  }

  private async load(id: string) {
    return found(await db.orm.hub.StaffShift.first({ id }), "Shift");
  }

  async approve(p: StaffPrincipal, id: string) {
    const shift = await this.load(id);
    const credentialed = CREDENTIALED.includes(shift.role as StaffRole);
    await this.access.require(p, credentialed ? CLINICAL_APPROVERS : HUB_MANAGEMENT, { hubId: shift.hubId }, "roster.approve");
    if (credentialed && !(await hasValidCredential(db, shift.userId, shift.role, dhakaDate(toDate(shift.startsAt)!)))) {
      throw unprocessable("CREDENTIAL_INVALID", "Credential is no longer valid for this role");
    }
    const overlaps = await this.overlapping(shift.userId, shift.startsAt, shift.endsAt, shift.id);
    if (overlaps.length && !shift.overlapOverrideReason) throw conflict("SHIFT_OVERLAP", "The staff member has an overlapping shift", { shiftIds: overlaps.map((o) => o.id) });
    return this.move(p, shift, "approved", { approvedById: p.userId, approvedAt: nowIso() });
  }

  async cancel(p: StaffPrincipal, id: string, reason: string) {
    const shift = await this.load(id);
    await this.access.require(p, HUB_MANAGEMENT, { hubId: shift.hubId }, "roster.cancel");
    return this.move(p, shift, "cancelled", {}, reason);
  }

  async markAbsent(p: StaffPrincipal, id: string, reason: string) {
    const shift = await this.load(id);
    await this.access.require(p, HUB_MANAGEMENT, { hubId: shift.hubId }, "roster.absent");
    return this.move(p, shift, "absent", {}, reason);
  }

  /** The staff member themself, or a hub manager on their behalf. */
  async checkIn(p: StaffPrincipal, id: string) {
    const shift = await this.load(id);
    if (shift.userId !== p.userId) await this.access.require(p, HUB_MANAGEMENT, { hubId: shift.hubId }, "roster.check_in_for");
    return this.move(p, shift, "checked_in", { checkedInAt: nowIso() });
  }

  async checkOut(p: StaffPrincipal, id: string) {
    const shift = await this.load(id);
    if (shift.userId !== p.userId) await this.access.require(p, HUB_MANAGEMENT, { hubId: shift.hubId }, "roster.check_out_for");
    return this.move(p, shift, "checked_out", { checkedOutAt: nowIso() });
  }

  private async move(p: StaffPrincipal, shift: { id: string; status: string }, to: string, extra: Record<string, unknown>, reason?: string) {
    return db.transaction(async (tx) => {
      const locked = found(await tx.orm.hub.StaffShift.where({ id: shift.id }).forUpdate().first(), "Shift");
      assertShiftTransition(locked.status, to);
      const updated = await tx.orm.hub.StaffShift.where({ id: shift.id }).update({ status: to, ...extra } as never);
      await this.audit.record(p, { action: `roster.${to}`, targetType: "staff_shift", targetId: shift.id, hubId: locked.hubId, reason: reason ?? null, metadata: { userId: locked.userId, from: locked.status } }, tx);
      if (updated) await this.changed(tx, p, updated);
      return updated;
    });
  }

  async list(p: StaffPrincipal, query: unknown) {
    const q = parse(listSchema, query);
    const page = parse(zPage, query);
    const scope = await this.access.hubScope(p, OPS_READ);
    if (q.hubId) this.access.assertInScope(scope, q.hubId);
    if (scope !== "all" && scope.length === 0) return { items: [], limit: page.limit, offset: page.offset };
    const day = q.date ? dayBounds(q.date) : null;
    const items = await db.orm.hub.StaffShift.where((s) => {
      const c: Cond[] = [];
      if (scope !== "all") c.push(s.hubId.in(scope));
      if (q.hubId) c.push(s.hubId.eq(q.hubId));
      if (q.sessionId) c.push(s.sessionId.eq(q.sessionId));
      if (q.userId) c.push(s.userId.eq(q.userId));
      if (q.status) c.push(s.status.eq(q.status));
      if (day) c.push(and(s.startsAt.lt(day.to), s.endsAt.gt(day.from)));
      return c.length ? and(...c) : s.id.isNotNull();
    })
      .include("user", (u) => u.select("id", "name", "nameBn"))
      .include("station", (st) => st.select("id", "code", "name"))
      .orderBy([(s) => s.startsAt.asc(), (s) => s.id.asc()])
      .limit(page.limit)
      .offset(page.offset)
      .all();
    return { items, limit: page.limit, offset: page.offset };
  }

  async mine(p: StaffPrincipal, query: unknown) {
    const q = parse(mineSchema, query);
    const from = q.from ? dayBounds(q.from).from : new Date(Date.now() - 86400000).toISOString();
    const to = q.to ? dayBounds(q.to).to : new Date(Date.now() + 30 * 86400000).toISOString();
    return db.orm.hub.StaffShift.where({ userId: p.userId })
      .where((s) => and(s.startsAt.lt(to), s.endsAt.gt(from)))
      .include("hub", (h) => h.select("id", "code", "name", "addressLine", "contactPhone"))
      .include("session", (s) => s.select("id", "title", "status", "startsAt", "endsAt"))
      .include("station", (st) => st.select("id", "code", "name"))
      .orderBy((s) => s.startsAt.asc())
      .limit(200)
      .all();
  }

  async get(p: StaffPrincipal, id: string) {
    const shift = await this.load(id);
    if (shift.userId !== p.userId) await this.access.require(p, OPS_READ, { hubId: shift.hubId }, "roster.read");
    return shift;
  }
}

const Id = () => Param("id", new ParseUUIDPipe());

/** Staff roster and shift attendance (PRD §8.7). Attendance timestamps only — no surveillance. */
@Controller("shifts")
class RosterController {
  constructor(@Inject(RosterService) private readonly roster: RosterService) {}

  @Post()
  create(@Staff() p: StaffPrincipal, @Body() body: unknown) {
    return this.roster.create(p, body);
  }

  @Get()
  list(@Staff() p: StaffPrincipal, @Query() query: unknown) {
    return this.roster.list(p, query);
  }

  @Get("mine")
  mine(@Staff() p: StaffPrincipal, @Query() query: unknown) {
    return this.roster.mine(p, query);
  }

  @Get(":id")
  get(@Staff() p: StaffPrincipal, @Id() id: string) {
    return this.roster.get(p, id);
  }

  @Post(":id/approve")
  approve(@Staff() p: StaffPrincipal, @Id() id: string) {
    return this.roster.approve(p, id);
  }

  @Post(":id/cancel")
  cancel(@Staff() p: StaffPrincipal, @Id() id: string, @Body() body: unknown) {
    return this.roster.cancel(p, id, parse(reasonSchema, body).reason);
  }

  @Post(":id/absent")
  absent(@Staff() p: StaffPrincipal, @Id() id: string, @Body() body: unknown) {
    return this.roster.markAbsent(p, id, parse(reasonSchema, body).reason);
  }

  @Post(":id/check-in")
  checkIn(@Staff() p: StaffPrincipal, @Id() id: string) {
    return this.roster.checkIn(p, id);
  }

  @Post(":id/check-out")
  checkOut(@Staff() p: StaffPrincipal, @Id() id: string) {
    return this.roster.checkOut(p, id);
  }
}

@Module({ controllers: [RosterController], providers: [RosterService] })
export class RosterModule {}

