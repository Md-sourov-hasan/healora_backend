import { Injectable } from "@nestjs/common";
import { or } from "@prisma/orm-postgres/orm-client";

import type { StaffPrincipal } from "../../common/auth/principal.ts";
import { db, type DbLike, dhakaDate, nowIso } from "../../common/db.ts";
import { badRequest, forbidden } from "../../common/errors.ts";
import { DOCTORS, type StaffRole } from "../../common/roles.ts";

/** Consent purposes required before any hub measurement is captured (PRD §9.5, §20.4). */
export const REQUIRED_CONSENT_PURPOSES = ["hub_service", "health_data_processing"] as const;

export interface ConsentStatus {
  satisfied: boolean;
  purposes: Record<string, { granted: boolean; consentId: string | null; representativeId: string | null; expiresAt: string | null }>;
  missing: string[];
}

/** Shared lookups for the clinical write path (team app + doctor). */
@Injectable()
export class ClinicalContextService {


  /** Active, verified, unexpired credential for a user (null if none). */
  async activeCredential(tx: DbLike, userId: string) {
    const today = dhakaDate();
    return tx.orm.identity.StaffCredential.where({ userId, status: "verified" })
      .where((c) => or(c.expiresAt.isNull(), c.expiresAt.gte(today)))
      .orderBy((c) => c.createdAt.desc())
      .first();
  }

  async requireCredential(tx: DbLike, userId: string) {
    const cred = await this.activeCredential(tx, userId);
    if (!cred) throw forbidden("An active verified credential is required for this action", "CREDENTIAL_REQUIRED");
    return cred;
  }

  /** The caller's doctor role, if any (registered_doctor preferred). */
  doctorRole(p: StaffPrincipal): StaffRole | null {
    const roles = new Set(p.assignments.map((a) => a.role));
    if (roles.has("registered_doctor")) return "registered_doctor";
    if (roles.has("local_doctor")) return "local_doctor";
    return null;
  }

  isDoctor(p: StaffPrincipal): boolean {
    return p.assignments.some((a) => DOCTORS.includes(a.role));
  }

  /** Active consents for the hub measurement workflow, honouring representative validity. */
  async consentStatus(tx: DbLike, patientId: string): Promise<ConsentStatus> {
    const now = nowIso();
    const rows = await tx.orm.clinical.Consent.where({ patientId, status: "granted" })
      .where((c) => c.purpose.in([...REQUIRED_CONSENT_PURPOSES]))
      .where((c) => or(c.expiresAt.isNull(), c.expiresAt.gt(now)))
      .orderBy((c) => c.capturedAt.desc())
      .all();
    const repIds = [...new Set(rows.map((r) => r.representativeId).filter((x): x is string => !!x))];
    const validReps = new Set<string>();
    if (repIds.length) {
      const reps = await tx.orm.clinical.PatientRepresentative.where((r) => r.id.in(repIds))
        .where((r) => r.revokedAt.isNull())
        .where((r) => r.validFrom.lte(now))
        .where((r) => or(r.validTo.isNull(), r.validTo.gt(now)))
        .all();
      for (const r of reps) validReps.add(r.id);
    }
    const purposes: ConsentStatus["purposes"] = {};
    for (const purpose of REQUIRED_CONSENT_PURPOSES) {
      const hit = rows.find((r) => r.purpose === purpose && (!r.representativeId || validReps.has(r.representativeId)));
      purposes[purpose] = {
        granted: !!hit,
        consentId: hit?.id ?? null,
        representativeId: hit?.representativeId ?? null,
        expiresAt: hit?.expiresAt ?? null,
      };
    }
    const missing = REQUIRED_CONSENT_PURPOSES.filter((p) => !purposes[p]!.granted);
    return { satisfied: missing.length === 0, purposes, missing };
  }

  /** Protocol checklist with definitions (units, contexts, methods) for an encounter's protocol. */
  async checklist(tx: DbLike, protocolId: string | null) {
    if (!protocolId) return [];
    const items = await tx.orm.clinical.ProtocolObservation.where({ protocolId })
      .include("definition", (d) =>
        d.select("code", "name", "nameBn", "valueType", "canonicalUnit", "allowedUnits", "allowedContexts", "allowedMethods", "allowedSites", "plausibleMin", "plausibleMax", "isDerived"),
      )
      .orderBy((x) => x.sortOrder.asc())
      .all();
    return items.map((i) => ({
      observationCode: i.observationCode,
      required: i.required,
      permittedRoles: i.permittedRoles,
      repeatRule: i.repeatRule,
      definition: i.definition,
    }));
  }

  /** Minimum-necessary patient identity for a care task. */
  async minimalPatient(tx: DbLike, patientId: string) {
    const pt = await tx.orm.clinical.Patient.select("id", "healoraCode", "fullName", "fullNameBn", "dateOfBirth", "birthYearEstimated", "sex", "preferredLanguage").first({ id: patientId });
    if (!pt) return null;
    const year = pt.dateOfBirth ? Number(pt.dateOfBirth.slice(0, 4)) : pt.birthYearEstimated;
    const age = year ? new Date().getUTCFullYear() - year : null;
    return {
      id: pt.id,
      healoraCode: pt.healoraCode,
      fullName: pt.fullName,
      fullNameBn: pt.fullNameBn,
      sex: pt.sex,
      ageYears: age,
      ageIsEstimated: !pt.dateOfBirth && !!pt.birthYearEstimated,
      preferredLanguage: pt.preferredLanguage,
    };
  }

  /** Staff ids of doctors whose scope covers a hub (for review notifications). */
  async doctorsForHub(tx: DbLike, hubId: string | null): Promise<string[]> {
    if (!hubId) return [];
    const hub = await tx.orm.hub.Hub.select("regionId").first({ id: hubId });
    // Walk the region tree on `tx` itself: inside a transaction, a second pool
    // connection (AccessService uses the root client) can deadlock a small pool.
    const regions: string[] = [];
    for (let current: string | null = hub?.regionId ?? null, depth = 0; current && depth < 12; depth++) {
      regions.push(current);
      const row: { parentId: string | null } | null = await tx.orm.hub.Region.select("parentId").first({ id: current });
      current = row?.parentId ?? null;
    }
    const now = nowIso();
    const rows = await tx.orm.identity.RoleAssignment.select("userId", "scopeType", "hubId", "regionId")
      .where({ status: "active" })
      .where((r) => r.role.in([...DOCTORS]))
      .where((r) => r.validFrom.lte(now))
      .where((r) => or(r.validTo.isNull(), r.validTo.gt(now)))
      .all();
    const ids = rows
      .filter((r) => r.scopeType === "platform" || (r.scopeType === "hub" && r.hubId === hubId) || (r.scopeType === "region" && r.regionId !== null && regions.includes(r.regionId)))
      .map((r) => r.userId);
    return [...new Set(ids)];
  }

  /** True when the caller is the team lead of the encounter's session. */
  async isSessionLead(tx: DbLike, userId: string, sessionId: string | null): Promise<boolean> {
    if (!sessionId) return false;
    const session = await tx.orm.hub.HubSession.select("teamLeadUserId").first({ id: sessionId });
    if (session?.teamLeadUserId === userId) return true;
    const shift = await tx.orm.hub.StaffShift.where({ userId, sessionId, role: "special_team_lead" })
      .where((s) => s.status.in(["approved", "checked_in"]))
      .first();
    return shift !== null;
  }

  requireReason(value: string | undefined | null, field: string) {
    if (!value || value.trim().length < 3) throw badRequest("REASON_REQUIRED", `${field} is required`);
  }
}

