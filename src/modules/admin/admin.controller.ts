import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from "@nestjs/common";
import { or } from "@prisma/orm-postgres/orm-client";

import { AccessService } from "../../common/access.service.ts";
import { AuditService } from "../../common/audit.service.ts";
import { Staff } from "../../common/auth/decorators.ts";
import type { StaffPrincipal } from "../../common/auth/principal.ts";
import { db, dhakaDate, nowIso, toDate } from "../../common/db.ts";
import { badRequest, conflict, forbidden, found, unprocessable } from "../../common/errors.ts";
import {
  ADMIN,
  AUDIT_READ,
  CLINICAL_GOVERNANCE,
  CREDENTIALED,
  DOCTORS,
  HUB_MANAGEMENT,
  PRIVILEGED,
  REGIONAL,
  type StaffRole,
  TEAM,
} from "../../common/roles.ts";
import { parse, z, zDate, zId, zInstant, zLang, zPage, zPhone, zReason } from "../../common/validation.ts";
import { AdminService } from "./admin.service.ts";

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

const USER_PUBLIC = ["id", "email", "username", "name", "nameBn", "phone", "status", "preferredLanguage", "mfaEnabled", "lastLoginAt", "disabledAt", "disabledReason", "createdAt", "updatedAt"] as const;

const userFields = {
  username: z.string().trim().min(3).max(60).regex(/^[a-z0-9._-]+$/i).nullable(),
  name: z.string().trim().min(1).max(200),
  nameBn: z.string().trim().max(200).nullable(),
  phone: zPhone.nullable(),
  preferredLanguage: zLang,
  mfaEnabled: z.boolean(),
  emergencyContactName: z.string().trim().max(200).nullable(),
  emergencyContactPhone: zPhone.nullable(),
};

const credentialSchema = z.object({
  professionalDesignation: z.string().trim().min(2).max(200),
  qualification: z.string().trim().min(2).max(300),
  registrationBody: z.string().trim().max(200).nullable().optional(),
  registrationNumber: z.string().trim().max(100).nullable().optional(),
  issuedAt: zDate.nullable().optional(),
  expiresAt: zDate.nullable().optional(),
  permittedObservationCodes: z.array(z.string().min(1).max(60)).max(50).default([]),
  qualifiesForRoles: z.array(z.enum(ROLES)).min(1).max(5),
  trainingCompletedAt: zDate.nullable().optional(),
  evidenceRef: z.string().max(500).nullable().optional(),
  displayOnPatientRecord: z.boolean().default(true),
});

const BREAK_GLASS_ROLES: StaffRole[] = [...new Set([...DOCTORS, ...TEAM])];

@Controller("admin")
export class AdminController {
  constructor(
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AdminService) private readonly admin: AdminService,
  ) {}

  // =========================================================================
  // Staff users
  // =========================================================================

  @Post("users")
  async createUser(@Staff() p: StaffPrincipal, @Body() body: unknown) {
    await this.access.require(p, REGIONAL, undefined, "user.create");
    const input = parse(
      z.object({
        email: z.string().trim().toLowerCase().email(),
        ...userFields,
        username: userFields.username.optional(),
        nameBn: userFields.nameBn.optional(),
        phone: userFields.phone.optional(),
        preferredLanguage: zLang.default("bn"),
        mfaEnabled: z.boolean().default(false),
        emergencyContactName: userFields.emergencyContactName.optional(),
        emergencyContactPhone: userFields.emergencyContactPhone.optional(),
      }),
      body,
    );
    return db.transaction(async (tx) => {
      const user = await tx.orm.identity.User.select(...USER_PUBLIC).create({ ...input, status: "invited" });
      await this.audit.record(p, { action: "user.create", targetType: "user", targetId: user.id }, tx);
      return user;
    });
  }

  @Get("users")
  async listUsers(@Staff() p: StaffPrincipal, @Query() query: unknown) {
    await this.access.require(p, REGIONAL, undefined, "user.list");
    const f = parse(
      zPage.extend({ q: z.string().max(100).optional(), status: z.enum(["invited", "active", "suspended", "disabled"]).optional(), role: z.enum(ROLES).optional(), hubId: zId.optional() }),
      query,
    );
    let c = db.orm.identity.User.orderBy((u) => u.name.asc());

    // Restrict regional managers to users inside their scope, plus unassigned users.
    const scope = await this.access.hubScope(p, REGIONAL);
    if (scope !== "all") {
      const regionIds = await this.access.regionDescendants(
        p.assignments.filter((a) => REGIONAL.includes(a.role) && a.scopeType === "region" && a.regionId).map((a) => a.regionId!),
      );
      const inScope = await db.orm.identity.RoleAssignment.select("userId")
        .where({ status: "active" })
        .where((r) => or(r.hubId.in(scope.length ? scope : ["00000000-0000-0000-0000-000000000000"]), r.regionId.in(regionIds.length ? regionIds : ["00000000-0000-0000-0000-000000000000"])))
        .all();
      const withAny = await db.orm.identity.RoleAssignment.select("userId").where({ status: "active" }).all();
      const assigned = new Set(withAny.map((r) => r.userId));
      const allowed = new Set(inScope.map((r) => r.userId));
      const all = await db.orm.identity.User.select("id").all();
      const ids = all.filter((u) => allowed.has(u.id) || !assigned.has(u.id)).map((u) => u.id);
      c = c.where((u) => u.id.in(ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]));
    }
    if (f.q) c = c.where((u) => or(u.name.ilike(`%${f.q}%`), u.email.ilike(`%${f.q}%`), u.phone.ilike(`%${f.q}%`)));
    if (f.status) c = c.where({ status: f.status });
    if (f.role || f.hubId) {
      let rc = db.orm.identity.RoleAssignment.select("userId").where({ status: "active" });
      if (f.role) rc = rc.where({ role: f.role });
      if (f.hubId) rc = rc.where({ hubId: f.hubId });
      const ids = (await rc.all()).map((r) => r.userId);
      c = c.where((u) => u.id.in(ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]));
    }
    const total = (await c.aggregate((a) => ({ n: a.count() }))).n;
    const items = await c.select(...USER_PUBLIC).limit(f.limit).offset(f.offset).all();
    return { items, total, limit: f.limit, offset: f.offset };
  }

  @Get("users/:id")
  async getUser(@Staff() p: StaffPrincipal, @Param("id") id: string) {
    const userId = parse(zId, id);
    await this.admin.loadUser(userId);
    await this.admin.requireUserAdmin(p, userId, "user.get");
    const user = found(await db.orm.identity.User.select(...USER_PUBLIC, "emergencyContactName", "emergencyContactPhone").first({ id: userId }), "User");
    const assignments = await db.orm.identity.RoleAssignment.where({ userId }).orderBy((r) => r.createdAt.desc()).limit(100).all();
    const credentials = await db.orm.identity.StaffCredential.select("id", "professionalDesignation", "qualification", "registrationBody", "registrationNumber", "expiresAt", "status", "qualifiesForRoles", "verifiedAt")
      .where({ userId })
      .all();
    return { ...user, assignments, credentials };
  }

  @Patch("users/:id")
  async updateUser(@Staff() p: StaffPrincipal, @Param("id") id: string, @Body() body: unknown) {
    const userId = parse(zId, id);
    await this.admin.loadUser(userId);
    await this.admin.requireUserAdmin(p, userId, "user.update");
    const input = parse(z.object(userFields).partial(), body);
    if (Object.keys(input).length === 0) throw badRequest("NO_CHANGES", "No fields to update");
    return db.transaction(async (tx) => {
      const user = await tx.orm.identity.User.select(...USER_PUBLIC).where({ id: userId }).update(input);
      await this.audit.record(p, { action: "user.update", targetType: "user", targetId: userId, metadata: { fields: Object.keys(input) } }, tx);
      return user;
    });
  }

  /** active (activate/reactivate) | suspended | disabled. Disabling revokes all active roles. */
  @Post("users/:id/status")
  async setUserStatus(@Staff() p: StaffPrincipal, @Param("id") id: string, @Body() body: unknown) {
    const userId = parse(zId, id);
    const user = await this.admin.loadUser(userId);
    await this.admin.requireUserAdmin(p, userId, "user.status");
    const { status, reason } = parse(z.object({ status: z.enum(["active", "suspended", "disabled"]), reason: zReason }), body);
    if (userId === p.userId) throw forbidden("You cannot change your own account status");
    const allowed: Record<string, string[]> = { invited: ["active", "disabled"], active: ["suspended", "disabled"], suspended: ["active", "disabled"], disabled: ["active"] };
    if (!allowed[user.status]?.includes(status)) throw conflict("INVALID_TRANSITION", `Cannot move user from '${user.status}' to '${status}'`);
    return db.transaction(async (tx) => {
      let revoked = 0;
      if (status === "disabled") {
        const active = await this.admin.activeAssignments(userId, tx);
        if (active.some((a) => a.role === "platform_super_admin") && (await this.admin.countActivePlatformAdmins(tx)) <= 1) {
          throw conflict("LAST_ADMIN", "Cannot disable the last platform admin");
        }
        for (const a of active) {
          await tx.orm.identity.RoleAssignment.where({ id: a.id }).update({ status: "revoked", revokedAt: nowIso(), revokedById: p.userId, revokeReason: `User disabled: ${reason}` });
        }
        revoked = active.length;
      }
      const updated = await tx.orm.identity.User.select(...USER_PUBLIC)
        .where({ id: userId })
        .update(status === "active" ? { status, disabledAt: null, disabledReason: null } : { status, disabledAt: nowIso(), disabledReason: reason });
      await this.audit.record(p, { action: `user.status.${status}`, targetType: "user", targetId: userId, reason, priority: status === "active" ? "normal" : "high", metadata: { from: user.status, revokedAssignments: revoked } }, tx);
      return { user: updated, revokedAssignments: revoked };
    });
  }

  // =========================================================================
  // Role assignments
  // =========================================================================

  @Post("users/:id/role-assignments")
  async grantRole(@Staff() p: StaffPrincipal, @Param("id") id: string, @Body() body: unknown) {
    const userId = parse(zId, id);
    const user = await this.admin.loadUser(userId);
    const input = parse(
      z.object({
        role: z.enum(ROLES),
        scopeType: z.enum(["platform", "region", "hub", "session"]),
        regionId: zId.optional(),
        hubId: zId.optional(),
        sessionId: zId.optional(),
        validFrom: zInstant.optional(),
        validTo: zInstant.optional(),
        supervisorUserId: zId.optional(),
        employmentType: z.string().max(60).optional(),
      }),
      body,
    );
    const ids = { region: input.regionId, hub: input.hubId, session: input.sessionId };
    const given = Object.entries(ids).filter(([, v]) => v).map(([k]) => k);
    if (input.scopeType === "platform" ? given.length !== 0 : given.length !== 1 || given[0] !== input.scopeType) {
      throw badRequest("INVALID_SCOPE", `scopeType '${input.scopeType}' requires exactly ${input.scopeType === "platform" ? "no scope id" : `${input.scopeType}Id`}`);
    }
    if (input.scopeType === "region") found(await db.orm.hub.Region.first({ id: input.regionId! }), "Region");
    if (input.scopeType === "hub") found(await db.orm.hub.Hub.first({ id: input.hubId! }), "Hub");
    if (input.scopeType === "session") found(await db.orm.hub.HubSession.first({ id: input.sessionId! }), "Session");

    // Only platform admins grant platform scope or privileged roles.
    if (input.scopeType === "platform" || PRIVILEGED.includes(input.role)) {
      await this.access.require(p, ADMIN, undefined, "role.grant.privileged");
    } else {
      await this.access.require(p, REGIONAL, { regionId: input.regionId, hubId: input.hubId, sessionId: input.sessionId }, "role.grant");
    }
    if (user.status === "disabled") throw unprocessable("USER_DISABLED", "Cannot grant roles to a disabled user");
    if (input.validTo && Date.parse(input.validTo) <= Date.parse(input.validFrom ?? nowIso())) throw badRequest("INVALID_WINDOW", "validTo must be after validFrom");
    if (CREDENTIALED.includes(input.role) && !(await this.admin.qualifyingCredential(userId, input.role))) {
      throw unprocessable("CREDENTIAL_REQUIRED", `Role '${input.role}' requires an active verified credential that qualifies for it`);
    }
    if (input.supervisorUserId) found(await db.orm.identity.User.first({ id: input.supervisorUserId }), "Supervisor");

    return db.transaction(async (tx) => {
      const dup = await tx.orm.identity.RoleAssignment.where({ userId, role: input.role, scopeType: input.scopeType, status: "active" })
        .where((r) => (input.regionId ? r.regionId.eq(input.regionId) : input.hubId ? r.hubId.eq(input.hubId) : input.sessionId ? r.sessionId.eq(input.sessionId) : r.regionId.isNull()))
        .first();
      if (dup) throw conflict("DUPLICATE_ASSIGNMENT", "User already holds this role in this scope", { assignmentId: dup.id });
      const row = await tx.orm.identity.RoleAssignment.create({
        userId,
        role: input.role,
        scopeType: input.scopeType,
        regionId: input.regionId ?? null,
        hubId: input.hubId ?? null,
        sessionId: input.sessionId ?? null,
        validFrom: input.validFrom ?? nowIso(),
        validTo: input.validTo ?? null,
        supervisorUserId: input.supervisorUserId ?? null,
        employmentType: input.employmentType ?? null,
        grantedById: p.userId,
      });
      await this.audit.record(p, { action: "role.grant", targetType: "role_assignment", targetId: row.id, hubId: row.hubId, regionId: row.regionId, priority: PRIVILEGED.includes(input.role) ? "high" : "normal", metadata: { userId, role: row.role, scopeType: row.scopeType } }, tx);
      return row;
    });
  }

  @Get("users/:id/role-assignments")
  async userRoles(@Staff() p: StaffPrincipal, @Param("id") id: string, @Query() query: unknown) {
    const userId = parse(zId, id);
    await this.admin.loadUser(userId);
    await this.admin.requireUserAdmin(p, userId, "role.list.user");
    const { includeRevoked } = parse(z.object({ includeRevoked: z.coerce.boolean().default(false) }), query);
    let c = db.orm.identity.RoleAssignment.where({ userId }).orderBy((r) => r.createdAt.desc());
    if (!includeRevoked) c = c.where({ status: "active" });
    return { items: await c.limit(200).all() };
  }

  /** Assignments on a hub (hub managers may view; administered by regional+). */
  @Get("role-assignments")
  async listRoles(@Staff() p: StaffPrincipal, @Query() query: unknown) {
    const f = parse(zPage.extend({ hubId: zId.optional(), regionId: zId.optional(), role: z.enum(ROLES).optional(), includeRevoked: z.coerce.boolean().default(false) }), query);
    if (!f.hubId && !f.regionId) await this.access.require(p, ADMIN, undefined, "role.list");
    else await this.access.require(p, f.hubId ? HUB_MANAGEMENT : REGIONAL, { hubId: f.hubId, regionId: f.regionId }, "role.list");
    let c = db.orm.identity.RoleAssignment.orderBy((r) => r.createdAt.desc());
    if (f.hubId) c = c.where({ hubId: f.hubId });
    if (f.regionId) c = c.where({ regionId: f.regionId });
    if (f.role) c = c.where({ role: f.role });
    if (!f.includeRevoked) c = c.where({ status: "active" });
    const items = await c.include("user", (u) => u.select("id", "name", "nameBn", "status")).limit(f.limit).offset(f.offset).all();
    return { items, limit: f.limit, offset: f.offset };
  }

  @Post("role-assignments/:id/revoke")
  async revokeRole(@Staff() p: StaffPrincipal, @Param("id") id: string, @Body() body: unknown) {
    const assignmentId = parse(zId, id);
    const { reason } = parse(z.object({ reason: zReason }), body);
    const a = found(await db.orm.identity.RoleAssignment.first({ id: assignmentId }), "Role assignment");
    if (a.scopeType === "platform" || PRIVILEGED.includes(a.role as StaffRole)) await this.access.require(p, ADMIN, undefined, "role.revoke.privileged");
    else await this.access.require(p, REGIONAL, { regionId: a.regionId, hubId: a.hubId, sessionId: a.sessionId }, "role.revoke");
    if (a.status !== "active") throw conflict("NOT_ACTIVE", "Assignment is not active");
    return db.transaction(async (tx) => {
      if (a.role === "platform_super_admin" && (await this.admin.countActivePlatformAdmins(tx)) <= 1) {
        throw conflict("LAST_ADMIN", "Cannot revoke the last platform admin");
      }
      const row = await tx.orm.identity.RoleAssignment.where({ id: assignmentId }).update({ status: "revoked", revokedAt: nowIso(), revokedById: p.userId, revokeReason: reason });
      await this.audit.record(p, { action: "role.revoke", targetType: "role_assignment", targetId: assignmentId, hubId: a.hubId, regionId: a.regionId, reason, priority: "high", metadata: { userId: a.userId, role: a.role } }, tx);
      return row;
    });
  }

  // =========================================================================
  // Staff credentials (clinical operations)
  // =========================================================================

  @Post("users/:id/credentials")
  async addCredential(@Staff() p: StaffPrincipal, @Param("id") id: string, @Body() body: unknown) {
    await this.access.require(p, CLINICAL_GOVERNANCE, undefined, "credential.create");
    const userId = parse(zId, id);
    await this.admin.loadUser(userId);
    const input = parse(credentialSchema, body);
    if (input.issuedAt && input.expiresAt && input.expiresAt <= input.issuedAt) throw badRequest("INVALID_DATES", "expiresAt must be after issuedAt");
    if (!!input.registrationBody !== !!input.registrationNumber) throw badRequest("REGISTRATION_INCOMPLETE", "registrationBody and registrationNumber go together");
    if (input.permittedObservationCodes.length) {
      const defs = await db.orm.clinical.ObservationDefinition.select("code").where((d) => d.code.in(input.permittedObservationCodes)).all();
      const known = new Set(defs.map((d) => d.code));
      const unknown = input.permittedObservationCodes.filter((c) => !known.has(c));
      if (unknown.length) throw badRequest("UNKNOWN_OBSERVATION", "Unknown observation codes", { unknown });
    }
    return db.transaction(async (tx) => {
      const row = await tx.orm.identity.StaffCredential.create({
        userId,
        ...input,
        registrationBody: input.registrationBody ?? null,
        registrationNumber: input.registrationNumber ?? null,
        issuedAt: input.issuedAt ?? null,
        expiresAt: input.expiresAt ?? null,
        trainingCompletedAt: input.trainingCompletedAt ?? null,
        evidenceRef: input.evidenceRef ?? null,
        status: "pending",
      });
      await this.audit.record(p, { action: "credential.create", targetType: "staff_credential", targetId: row.id, metadata: { userId } }, tx);
      return row;
    });
  }

  @Get("users/:id/credentials")
  async userCredentials(@Staff() p: StaffPrincipal, @Param("id") id: string) {
    const userId = parse(zId, id);
    await this.admin.loadUser(userId);
    if (!(await this.access.can(p, CLINICAL_GOVERNANCE))) await this.admin.requireUserAdmin(p, userId, "credential.list.user");
    return { items: await db.orm.identity.StaffCredential.where({ userId }).orderBy((c) => c.createdAt.desc()).all() };
  }

  @Get("credentials")
  async listCredentials(@Staff() p: StaffPrincipal, @Query() query: unknown) {
    await this.access.require(p, CLINICAL_GOVERNANCE, undefined, "credential.list");
    const f = parse(zPage.extend({ status: z.enum(["pending", "verified", "rejected", "expired", "suspended"]).optional(), expiringBefore: zDate.optional() }), query);
    let c = db.orm.identity.StaffCredential.orderBy((x) => x.createdAt.desc());
    if (f.status) c = c.where({ status: f.status });
    if (f.expiringBefore) c = c.where((x) => x.expiresAt.lte(f.expiringBefore!));
    const items = await c.include("user", (u) => u.select("id", "name", "status")).limit(f.limit).offset(f.offset).all();
    return { items, limit: f.limit, offset: f.offset };
  }

  @Post("credentials/:id/:action")
  async decideCredential(@Staff() p: StaffPrincipal, @Param("id") id: string, @Param("action") action: string, @Body() body: unknown) {
    await this.access.require(p, CLINICAL_GOVERNANCE, undefined, "credential.decide");
    const credentialId = parse(zId, id);
    const act = parse(z.enum(["verify", "reject", "suspend", "expire"]), action);
    const { reason } = parse(z.object({ reason: zReason.optional() }), body);
    if (act !== "verify" && !reason) throw badRequest("REASON_REQUIRED", "A reason is required");
    const cred = found(await db.orm.identity.StaffCredential.first({ id: credentialId }), "Credential");
    if (cred.userId === p.userId) throw forbidden("You cannot decide on your own credential");
    const to = ({ verify: "verified", reject: "rejected", suspend: "suspended", expire: "expired" } as const)[act];
    const allowed: Record<string, string[]> = { pending: ["verified", "rejected"], verified: ["suspended", "expired"], suspended: ["verified", "expired"], rejected: [], expired: [] };
    if (!allowed[cred.status]?.includes(to)) throw conflict("INVALID_TRANSITION", `Cannot move credential from '${cred.status}' to '${to}'`);
    if (to === "verified" && cred.expiresAt && cred.expiresAt < dhakaDate()) throw unprocessable("CREDENTIAL_EXPIRED", "Cannot verify an expired credential");
    return db.transaction(async (tx) => {
      const row = await tx.orm.identity.StaffCredential.where({ id: credentialId }).update(
        to === "verified" ? { status: to, verifiedById: p.userId, verifiedAt: nowIso() } : { status: to },
      );
      const revoked = to === "verified" ? [] : await this.admin.revokeUnqualifiedRoles(tx, p, cred.userId, credentialId, `Credential ${to}: ${reason}`);
      await this.audit.record(p, { action: `credential.${act}`, targetType: "staff_credential", targetId: credentialId, reason: reason ?? null, priority: to === "verified" ? "normal" : "high", metadata: { userId: cred.userId, revokedAssignments: revoked.length } }, tx);
      return { credential: row, revokedAssignments: revoked };
    });
  }

  // =========================================================================
  // Break-glass access (PRD §6.4)
  // =========================================================================

  @Post("break-glass")
  async requestBreakGlass(@Staff() p: StaffPrincipal, @Body() body: unknown) {
    await this.access.require(p, BREAK_GLASS_ROLES, undefined, "break_glass.request");
    const input = parse(z.object({ patientId: zId, reason: z.string().trim().min(20).max(2000), durationMinutes: z.number().int().min(5).max(240).default(60) }), body);
    found(await db.orm.clinical.Patient.select("id").first({ id: input.patientId }), "Patient");
    const now = new Date();
    return db.transaction(async (tx) => {
      const existing = await tx.orm.identity.BreakGlassAccess.where({ userId: p.userId, patientId: input.patientId })
        .where((b) => b.endedAt.isNull())
        .where((b) => b.expiresAt.gt(now.toISOString()))
        .first();
      if (existing) throw conflict("ALREADY_ACTIVE", "You already have active break-glass access to this patient", { id: existing.id });
      const row = await tx.orm.identity.BreakGlassAccess.create({
        userId: p.userId,
        patientId: input.patientId,
        reason: input.reason,
        startsAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + input.durationMinutes * 60_000).toISOString(),
      });
      await this.audit.record(p, { action: "break_glass.start", targetType: "break_glass_access", targetId: row.id, patientId: input.patientId, reason: input.reason, priority: "high", metadata: { durationMinutes: input.durationMinutes } }, tx);
      return row;
    });
  }

  @Post("break-glass/:id/end")
  async endBreakGlass(@Staff() p: StaffPrincipal, @Param("id") id: string) {
    const grantId = parse(zId, id);
    const g = found(await db.orm.identity.BreakGlassAccess.first({ id: grantId }), "Break-glass grant");
    if (g.userId !== p.userId) await this.access.require(p, ADMIN, undefined, "break_glass.end.other");
    if (g.endedAt || (toDate(g.expiresAt)?.getTime() ?? 0) <= Date.now()) throw conflict("NOT_ACTIVE", "Grant is no longer active");
    return db.transaction(async (tx) => {
      const row = await tx.orm.identity.BreakGlassAccess.where({ id: grantId }).update({ endedAt: nowIso() });
      await this.audit.record(p, { action: "break_glass.end", targetType: "break_glass_access", targetId: grantId, patientId: g.patientId, priority: "high" }, tx);
      return row;
    });
  }

  @Get("break-glass/mine")
  async myBreakGlass(@Staff() p: StaffPrincipal) {
    return { items: await db.orm.identity.BreakGlassAccess.where({ userId: p.userId }).orderBy((b) => b.startsAt.desc()).limit(50).all() };
  }

  @Get("break-glass")
  async listBreakGlass(@Staff() p: StaffPrincipal, @Query() query: unknown) {
    await this.access.require(p, AUDIT_READ, undefined, "break_glass.list");
    const f = parse(zPage.extend({ reviewOutcome: z.enum(["pending", "justified", "not_justified"]).optional() }), query);
    let c = db.orm.identity.BreakGlassAccess.orderBy((b) => b.startsAt.desc());
    if (f.reviewOutcome) c = c.where({ reviewOutcome: f.reviewOutcome });
    const items = await c
      .include("user", (u) => u.select("id", "name"))
      .include("patient", (pt) => pt.select("id", "healoraCode"))
      .limit(f.limit)
      .offset(f.offset)
      .all();
    return { items, limit: f.limit, offset: f.offset };
  }

  @Post("break-glass/:id/review")
  async reviewBreakGlass(@Staff() p: StaffPrincipal, @Param("id") id: string, @Body() body: unknown) {
    await this.access.require(p, AUDIT_READ, undefined, "break_glass.review");
    const grantId = parse(zId, id);
    const input = parse(z.object({ outcome: z.enum(["justified", "not_justified"]), notes: z.string().trim().max(2000).optional() }), body);
    const g = found(await db.orm.identity.BreakGlassAccess.first({ id: grantId }), "Break-glass grant");
    if (g.userId === p.userId) throw forbidden("You cannot review your own break-glass access");
    if (g.reviewOutcome !== "pending") throw conflict("ALREADY_REVIEWED", "Grant was already reviewed");
    if (input.outcome === "not_justified" && !input.notes) throw badRequest("NOTES_REQUIRED", "Notes are required when access was not justified");
    return db.transaction(async (tx) => {
      const row = await tx.orm.identity.BreakGlassAccess.where({ id: grantId }).update({
        reviewOutcome: input.outcome,
        reviewedById: p.userId,
        reviewedAt: nowIso(),
        reviewNotes: input.notes ?? null,
        ...(g.endedAt ? {} : { endedAt: nowIso() }),
      });
      await this.audit.record(p, { action: "break_glass.review", targetType: "break_glass_access", targetId: grantId, patientId: g.patientId, priority: input.outcome === "not_justified" ? "high" : "normal", metadata: { outcome: input.outcome, userId: g.userId } }, tx);
      return row;
    });
  }
}
