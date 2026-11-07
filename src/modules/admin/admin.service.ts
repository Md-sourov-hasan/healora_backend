import { Inject, Injectable } from "@nestjs/common";
import { or } from "@prisma/orm-postgres/orm-client";

import { AccessService } from "../../common/access.service.ts";
import { AuditService } from "../../common/audit.service.ts";
import type { StaffPrincipal } from "../../common/auth/principal.ts";
import { db, dhakaDate, nowIso, type DbLike, type Tx } from "../../common/db.ts";
import { forbidden, found } from "../../common/errors.ts";
import { ADMIN, CREDENTIALED, PRIVILEGED, REGIONAL, type StaffRole } from "../../common/roles.ts";

@Injectable()
export class AdminService {
  constructor(
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async loadUser(id: string) {
    return found(await db.orm.identity.User.first({ id }), "User");
  }

  /**
   * A regional manager may administer a user only when every one of the
   * user's active assignments lies inside the manager's own scope (users with
   * no assignments yet are administrable so they can be onboarded).
   * Platform admins are administered only by platform admins.
   */
  async requireUserAdmin(p: StaffPrincipal, userId: string, action: string) {
    const staff = await this.access.require(p, REGIONAL, undefined, action);
    if (this.access.hasRole(staff, ADMIN) && (await this.access.can(staff, ADMIN))) return staff;
    const assignments = await this.activeAssignments(userId);
    if (assignments.some((a) => a.scopeType === "platform" || PRIVILEGED.includes(a.role as StaffRole) && a.role !== "regional_ops_manager")) {
      throw forbidden("Only a platform admin can administer this user");
    }
    for (const a of assignments) {
      const scope = a.scopeType === "region" ? { regionId: a.regionId } : a.scopeType === "hub" ? { hubId: a.hubId } : { sessionId: a.sessionId };
      await this.access.require(staff, REGIONAL, scope, action);
    }
    return staff;
  }

  activeAssignments(userId: string, tx: DbLike = db) {
    const now = nowIso();
    return tx.orm.identity.RoleAssignment.where({ userId, status: "active" })
      .where((r) => or(r.validTo.isNull(), r.validTo.gt(now)))
      .all();
  }

  /** Verified, unexpired credential that qualifies the user for `role`. */
  async qualifyingCredential(userId: string, role: StaffRole, tx: DbLike = db, excludeId?: string) {
    const today = dhakaDate();
    const creds = await tx.orm.identity.StaffCredential.where({ userId, status: "verified" })
      .where((c) => or(c.expiresAt.isNull(), c.expiresAt.gte(today)))
      .all();
    return creds.find((c) => c.id !== excludeId && (c.qualifiesForRoles as string[]).includes(role)) ?? null;
  }

  /** After a credential stops being valid, revoke credentialed roles that no longer qualify. */
  async revokeUnqualifiedRoles(tx: Tx, p: StaffPrincipal, userId: string, credentialId: string, reason: string): Promise<string[]> {
    const revoked: string[] = [];
    for (const a of await this.activeAssignments(userId, tx)) {
      if (!CREDENTIALED.includes(a.role as StaffRole)) continue;
      if (await this.qualifyingCredential(userId, a.role as StaffRole, tx, credentialId)) continue;
      await tx.orm.identity.RoleAssignment.where({ id: a.id }).update({ status: "revoked", revokedAt: nowIso(), revokedById: p.userId, revokeReason: reason });
      await this.audit.record(p, { action: "role.revoke.auto", targetType: "role_assignment", targetId: a.id, hubId: a.hubId, regionId: a.regionId, reason, metadata: { userId, role: a.role, credentialId } }, tx);
      revoked.push(a.id);
    }
    return revoked;
  }

  async countActivePlatformAdmins(tx: DbLike = db) {
    return (await tx.orm.identity.RoleAssignment.where({ role: "platform_super_admin", status: "active", scopeType: "platform" }).aggregate((a) => ({ n: a.count() }))).n;
  }
}
