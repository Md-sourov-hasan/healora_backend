import { Inject, Injectable } from "@nestjs/common";
import { or } from "@prisma/orm-postgres/orm-client";

import { AuditService } from "./audit.service.ts";
import type { ActiveAssignment, Principal, StaffPrincipal } from "./auth/principal.ts";
import { db, nowIso } from "./db.ts";
import { forbidden, notFound } from "./errors.ts";
import { DOCTORS, PRIVILEGED, type StaffRole } from "./roles.ts";

export interface Scope {
  hubId?: string | null;
  regionId?: string | null;
  sessionId?: string | null;
}

interface ResolvedScope {
  hubId: string | null;
  sessionId: string | null;
  /** The target region and all of its ancestors. */
  regionChain: string[];
}

/**
 * Deny-by-default, backend-enforced authorisation (PRD §6.4).
 *
 * Every check evaluates the caller's *active* role assignments against the
 * target's hub / region / session. A hub-scoped manager can never reach another
 * hub by changing an id — the target's real hub is always loaded from the DB.
 */
@Injectable()
export class AccessService {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  staff(p: Principal): StaffPrincipal {
    if (p.kind !== "staff") throw forbidden("Staff account required");
    return p;
  }

  hasRole(p: Principal, roles: readonly StaffRole[]): boolean {
    return p.kind === "staff" && p.assignments.some((a) => roles.includes(a.role));
  }

  /** Require one of `roles`, valid for `scope`. Logs and throws on denial. */
  async require(p: Principal, roles: readonly StaffRole[], scope?: Scope, action = "access"): Promise<StaffPrincipal> {
    const staff = this.staff(p);
    const matching = await this.matchingAssignments(staff, roles, scope);
    if (matching.length === 0) {
      await this.audit.record(staff, {
        action: `denied:${action}`,
        targetType: scope?.sessionId ? "session" : scope?.hubId ? "hub" : scope?.regionId ? "region" : "platform",
        targetId: scope?.sessionId ?? scope?.hubId ?? scope?.regionId ?? null,
        hubId: scope?.hubId ?? null,
        outcome: "denied",
        priority: "high",
        metadata: { requiredRoles: roles },
      });
      throw forbidden();
    }
    if (process.env.REQUIRE_MFA_FOR_PRIVILEGED === "true" && !staff.strongAuth) {
      const onlyPrivileged = matching.every((a) => PRIVILEGED.includes(a.role));
      if (onlyPrivileged) throw forbidden("Multi-factor authentication required for this action", "MFA_REQUIRED");
    }
    return staff;
  }

  async can(p: Principal, roles: readonly StaffRole[], scope?: Scope): Promise<boolean> {
    if (p.kind !== "staff") return false;
    return (await this.matchingAssignments(p, roles, scope)).length > 0;
  }

  /**
   * Hubs on which the caller holds one of `roles`. "all" for platform scope.
   * Use it to filter list endpoints so results never cross scope.
   */
  async hubScope(p: Principal, roles: readonly StaffRole[], action = "list"): Promise<"all" | string[]> {
    // Deny by default: holding none of the roles is a 403 (audited), never an empty 200.
    const staff = this.staff(p);
    const relevant = staff.assignments.filter((a) => roles.includes(a.role));
    if (relevant.length === 0) {
      await this.audit.record(staff, { action: `denied:${action}`, targetType: "scope", outcome: "denied", priority: "high", metadata: { requiredRoles: roles } });
      throw forbidden();
    }
    if (relevant.some((a) => a.scopeType === "platform")) return "all";
    const hubIds = new Set<string>();
    for (const a of relevant) if (a.scopeType === "hub" && a.hubId) hubIds.add(a.hubId);
    const regionIds = relevant.filter((a) => a.scopeType === "region" && a.regionId).map((a) => a.regionId!);
    if (regionIds.length) {
      const descendants = await this.regionDescendants(regionIds);
      const hubs = await db.orm.hub.Hub.select("id").where((h) => h.regionId.in(descendants)).all();
      for (const h of hubs) hubIds.add(h.id);
    }
    const sessionIds = relevant.filter((a) => a.scopeType === "session" && a.sessionId).map((a) => a.sessionId!);
    if (sessionIds.length) {
      const sessions = await db.orm.hub.HubSession.select("hubId").where((s) => s.id.in(sessionIds)).all();
      for (const s of sessions) hubIds.add(s.hubId);
    }
    return [...hubIds];
  }

  /** Throws unless `hubId` is inside `hubScope`. Convenience for list filters. */
  assertInScope(scope: "all" | string[], hubId: string) {
    if (scope !== "all" && !scope.includes(hubId)) throw forbidden();
  }

  async regionAncestors(regionId: string): Promise<string[]> {
    const chain: string[] = [];
    let current: string | null = regionId;
    for (let depth = 0; current && depth < 12; depth++) {
      chain.push(current);
      const row: { parentId: string | null } | null = await db.orm.hub.Region.select("parentId").first({ id: current });
      current = row?.parentId ?? null;
    }
    return chain;
  }

  async regionDescendants(regionIds: string[]): Promise<string[]> {
    const all = new Set(regionIds);
    let frontier = [...regionIds];
    for (let depth = 0; frontier.length && depth < 12; depth++) {
      const children = await db.orm.hub.Region.select("id").where((r) => r.parentId.in(frontier)).all();
      frontier = children.map((c) => c.id).filter((id) => !all.has(id));
      for (const id of frontier) all.add(id);
    }
    return [...all];
  }

  private async resolve(scope?: Scope): Promise<ResolvedScope | null> {
    if (!scope || (!scope.hubId && !scope.regionId && !scope.sessionId)) return null;
    let hubId = scope.hubId ?? null;
    const sessionId = scope.sessionId ?? null;
    if (sessionId) {
      const s = await db.orm.hub.HubSession.select("hubId").first({ id: sessionId });
      if (!s) throw notFound("Session");
      if (hubId && hubId !== s.hubId) throw forbidden();
      hubId = s.hubId;
    }
    let regionId = scope.regionId ?? null;
    if (hubId) {
      const h = await db.orm.hub.Hub.select("regionId").first({ id: hubId });
      if (!h) throw notFound("Hub");
      regionId = h.regionId;
    }
    return { hubId, sessionId, regionChain: regionId ? await this.regionAncestors(regionId) : [] };
  }

  private async matchingAssignments(p: StaffPrincipal, roles: readonly StaffRole[], scope?: Scope): Promise<ActiveAssignment[]> {
    const candidates = p.assignments.filter((a) => roles.includes(a.role));
    if (candidates.length === 0) return [];
    const target = await this.resolve(scope);
    if (!target) return candidates;
    return candidates.filter((a) => {
      switch (a.scopeType) {
        case "platform":
          return true;
        case "region":
          return a.regionId !== null && target.regionChain.includes(a.regionId);
        case "hub":
          return a.hubId !== null && a.hubId === target.hubId;
        case "session":
          return a.sessionId !== null && a.sessionId === target.sessionId;
      }
    });
  }

  // ---- clinical access ------------------------------------------------------

  /**
   * Clinical access to one encounter (PRD §6.4 "scope clinical access by
   * assigned encounter, care-team relationship, consent and verified role").
   *
   *  - "capture": an active team assignment on the encounter.
   *  - "review":  a doctor role covering the encounter's hub, or an assignment.
   *  - either:    an active, unexpired break-glass grant for the patient.
   */
  async requireEncounterAccess(p: Principal, encounterId: string, purpose: "capture" | "review" | "read") {
    const staff = this.staff(p);
    const enc = await db.orm.clinical.Encounter.first({ id: encounterId });
    if (!enc) throw notFound("Encounter");

    const assignment = await db.orm.clinical.EncounterAssignment.where({ encounterId, userId: staff.userId })
      .where((a) => a.status.in(["assigned", "accepted", "started"]))
      .first();

    let allowed = false;
    if (purpose === "capture") allowed = assignment !== null;
    else {
      allowed =
        assignment !== null ||
        (DOCTORS.some((r) => staff.assignments.some((a) => a.role === r)) &&
          (await this.can(staff, DOCTORS, { hubId: enc.hubId ?? undefined })));
    }
    if (!allowed && (await this.activeBreakGlass(staff.userId, enc.patientId))) allowed = true;

    if (!allowed) {
      await this.audit.record(staff, {
        action: `denied:encounter.${purpose}`,
        targetType: "encounter",
        targetId: encounterId,
        hubId: enc.hubId,
        patientId: enc.patientId,
        outcome: "denied",
        priority: "high",
      });
      throw forbidden("No clinical access to this encounter");
    }
    return { staff, encounter: enc, assignment };
  }

  async activeBreakGlass(userId: string, patientId: string): Promise<boolean> {
    const now = nowIso();
    const grant = await db.orm.identity.BreakGlassAccess.where({ userId, patientId })
      .where((b) => b.startsAt.lte(now))
      .where((b) => b.expiresAt.gt(now))
      .where((b) => b.endedAt.isNull())
      .first();
    return grant !== null;
  }

  /** Patients this doctor may see: any patient with an encounter at a hub in scope. */
  async requirePatientClinicalAccess(p: Principal, patientId: string) {
    const staff = this.staff(p);
    if (await this.activeBreakGlass(staff.userId, patientId)) return staff;
    const assigned = await db.orm.clinical.EncounterAssignment.where({ userId: staff.userId })
      .where((a) => a.status.in(["assigned", "accepted", "started"]))
      .where((a) => a.encounter.some((e) => e.patientId.eq(patientId)))
      .first();
    if (assigned) return staff;
    const hubs = this.hasRole(staff, DOCTORS) ? await this.hubScope(staff, DOCTORS) : [];
    if (hubs === "all" || hubs.length) {
      const enc = await db.orm.clinical.Encounter.select("id")
        .where({ patientId })
        .where((e) => (hubs === "all" ? e.hubId.isNotNull() : or(...hubs.map((h) => e.hubId.eq(h)))))
        .first();
      if (enc) return staff;
    }
    await this.audit.record(staff, {
      action: "denied:patient.clinical_read",
      targetType: "patient",
      targetId: patientId,
      patientId,
      outcome: "denied",
      priority: "high",
    });
    throw forbidden("No clinical access to this patient");
  }
}
