import { Body, Controller, Get, Inject, Param, Post, Query } from "@nestjs/common";
import { or } from "@prisma/orm-postgres/orm-client";

import { AccessService } from "../../common/access.service.ts";
import { AuditService } from "../../common/audit.service.ts";
import { Staff } from "../../common/auth/decorators.ts";
import type { StaffPrincipal } from "../../common/auth/principal.ts";
import { db, nowIso } from "../../common/db.ts";
import { conflict, found } from "../../common/errors.ts";
import { RateLimit } from "../../common/rate-limit.ts";
import { ADMIN, HUB_FLOOR, RECEPTION, REGIONAL } from "../../common/roles.ts";
import { parse, z, zDate, zId, zPage, zPhone, zReason } from "../../common/validation.ts";
import { MIN_PATIENT_FIELDS, hashIdentifier, minimalPatient } from "./patient-view.ts";
import { PatientsService } from "./patients.service.ts";

const zIdentType = z.enum(["national_id", "birth_registration", "passport", "healora_card", "other"]);
const zHubCtx = z.object({ hubId: zId });

const zLookup = z.discriminatedUnion("by", [
  z.object({ by: z.literal("healora_code"), value: z.string().trim().min(4).max(20), hubId: zId }),
  z.object({ by: z.literal("appointment_code"), value: z.string().trim().min(4).max(20), hubId: zId }),
  z.object({ by: z.literal("phone"), value: zPhone, hubId: zId }),
  z.object({ by: z.literal("identifier"), identifierType: zIdentType, value: z.string().trim().min(3).max(40), hubId: zId }),
]);

const zRegister = z
  .object({
    hubId: zId,
    fullName: z.string().trim().min(2).max(200),
    fullNameBn: z.string().trim().max(200).optional(),
    dateOfBirth: zDate.optional(),
    birthYearEstimated: z.number().int().min(1900).max(2100).optional(),
    sex: z.enum(["female", "male", "other", "unknown"]).default("unknown"),
    phone: zPhone.optional(),
    preferredLanguage: z.enum(["bn", "en"]).default("bn"),
    addressLine: z.string().trim().max(500).optional(),
    regionId: zId.optional(),
    identifiers: z.array(z.object({ type: zIdentType, value: z.string().trim().min(3).max(40) })).max(5).default([]),
  })
  .refine((v) => !(v.dateOfBirth && v.birthYearEstimated), "Give dateOfBirth or birthYearEstimated, not both");

const zRepresentative = z.object({
  hubId: zId,
  fullName: z.string().trim().min(2).max(200),
  phone: zPhone.optional(),
  relationship: z.enum(["parent", "legal_guardian", "spouse", "child", "sibling", "other_relative", "authorised_carer"]),
  legalBasis: z.string().trim().min(3).max(500),
  identityEvidence: z.string().trim().max(500).optional(),
  representativePatientId: zId.optional(),
  validTo: z.string().optional(),
});

/**
 * Minimum-necessary patient operations for the hub website (PRD §8.8).
 * There is deliberately no name search and no clinical data here.
 */
@Controller("patients")
export class PatientsController {
  constructor(
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(PatientsService) private readonly patients: PatientsService,
  ) {}

  /** Lookup by a permitted identifier only. POST keeps identifiers out of URLs/logs. */
  @RateLimit({ name: "patient-lookup", limit: 60, windowSec: 300, by: "principal" })
  @Post("lookup")
  async lookup(@Staff() p: StaffPrincipal, @Body() body: unknown) {
    const input = parse(zLookup, body);
    await this.access.require(p, HUB_FLOOR, { hubId: input.hubId }, "patient.lookup");

    let ids: string[] = [];
    let appointment: { id: string; code: string; status: string; sessionId: string; hubId: string } | null = null;
    switch (input.by) {
      case "healora_code": {
        const row = await db.orm.clinical.Patient.select("id").where({ healoraCode: input.value.toUpperCase() }).first();
        ids = row ? [row.id] : [];
        break;
      }
      case "appointment_code": {
        const a = await db.orm.hub.Appointment.select("id", "code", "status", "sessionId", "hubId", "patientId").where({ code: input.value.toUpperCase() }).first();
        if (a) {
          ids = [a.patientId];
          appointment = { id: a.id, code: a.code, status: a.status, sessionId: a.sessionId, hubId: a.hubId };
        }
        break;
      }
      case "phone": {
        const rows = await db.orm.clinical.Patient.select("id").where({ phone: input.value }).where((x) => x.phoneVerifiedAt.isNotNull()).limit(10).all();
        ids = rows.map((r) => r.id);
        break;
      }
      case "identifier": {
        const row = await db.orm.clinical.PatientIdentifier.select("patientId").where({ type: input.identifierType, valueHash: hashIdentifier(input.identifierType, input.value) }).first();
        ids = row ? [row.patientId] : [];
        break;
      }
    }

    const results = [];
    for (const id of ids) {
      const survivor = await this.patients.resolveSurvivor(id);
      const openDuplicate = await this.patients.openDuplicateFor(survivor.id);
      results.push({ ...minimalPatient(survivor), mergedFrom: survivor.id !== id ? id : null, identityUnresolved: openDuplicate !== null });
    }
    await this.audit.record(p, {
      action: "patient.lookup",
      targetType: "patient",
      targetId: results.length === 1 ? results[0]!.id : null,
      hubId: input.hubId,
      patientId: results.length === 1 ? results[0]!.id : null,
      metadata: { by: input.by, matches: results.length },
    });
    // A miss never creates a patient (PRD §8.8).
    return { matches: results, appointment: appointment && results.length ? appointment : null };
  }

  @Get(":id")
  async get(@Staff() p: StaffPrincipal, @Param("id") id: string, @Query() q: unknown) {
    parse(zId, id);
    const { hubId } = parse(zHubCtx, q);
    await this.access.require(p, HUB_FLOOR, { hubId }, "patient.read_minimal");
    const patient = await this.patients.minimal(id);
    const openDuplicate = await this.patients.openDuplicateFor(id);
    await this.audit.record(p, { action: "patient.view_minimal", targetType: "patient", targetId: id, hubId, patientId: id });
    return { ...minimalPatient(patient), mergedIntoId: patient.mergedIntoId, identityUnresolved: openDuplicate !== null };
  }

  /** Assisted registration for patients without an app account (PRD §9.4). */
  @Post()
  async register(@Staff() p: StaffPrincipal, @Body() body: unknown) {
    const input = parse(zRegister, body);
    await this.access.require(p, RECEPTION, { hubId: input.hubId }, "patient.register");
    return this.patients.register(p, input);
  }

  @Post(":id/identifiers")
  async addIdentifier(@Staff() p: StaffPrincipal, @Param("id") id: string, @Body() body: unknown) {
    parse(zId, id);
    const input = parse(z.object({ hubId: zId, type: zIdentType, value: z.string().trim().min(3).max(40) }), body);
    await this.access.require(p, RECEPTION, { hubId: input.hubId }, "patient.identifier_add");
    return this.patients.addIdentifier(p, id, input.hubId, input.type, input.value);
  }

  // ---- caregivers / representatives (PRD §6.3, §9.5) -------------------------

  @Get(":id/representatives")
  async listReps(@Staff() p: StaffPrincipal, @Param("id") id: string, @Query() q: unknown) {
    parse(zId, id);
    const { hubId } = parse(zHubCtx, q);
    await this.access.require(p, RECEPTION, { hubId }, "representative.read");
    const rows = await db.orm.clinical.PatientRepresentative.where({ patientId: id }).orderBy((r) => r.createdAt.desc()).all();
    return {
      items: rows.map((r) => ({
        id: r.id,
        fullName: r.fullName,
        maskedPhone: r.phone ? `***${r.phone.slice(-3)}` : null,
        relationship: r.relationship,
        legalBasis: r.legalBasis,
        validFrom: r.validFrom,
        validTo: r.validTo,
        verified: r.verifiedAt !== null,
        revoked: r.revokedAt !== null,
      })),
    };
  }

  @Post(":id/representatives")
  async addRep(@Staff() p: StaffPrincipal, @Param("id") id: string, @Body() body: unknown) {
    parse(zId, id);
    const input = parse(zRepresentative, body);
    await this.access.require(p, RECEPTION, { hubId: input.hubId }, "representative.add");
    found(await db.orm.clinical.Patient.select("id").first({ id }), "Patient");
    return db.transaction(async (tx) => {
      const rep = await tx.orm.clinical.PatientRepresentative.create({
        patientId: id,
        representativePatientId: input.representativePatientId ?? null,
        fullName: input.fullName,
        phone: input.phone ?? null,
        relationship: input.relationship,
        legalBasis: input.legalBasis,
        identityEvidence: input.identityEvidence ?? null,
        validFrom: nowIso(),
        validTo: input.validTo ?? null,
      });
      await this.audit.record(p, { action: "representative.added", targetType: "patient_representative", targetId: rep.id, hubId: input.hubId, patientId: id, metadata: { relationship: input.relationship } }, tx);
      return rep;
    });
  }

  @Post(":id/representatives/:repId/verify")
  async verifyRep(@Staff() p: StaffPrincipal, @Param("id") id: string, @Param("repId") repId: string, @Body() body: unknown) {
    const { hubId } = parse(zHubCtx, body);
    await this.access.require(p, RECEPTION, { hubId }, "representative.verify");
    return this.updateRep(p, id, repId, hubId, "representative.verified", { verifiedById: p.userId, verifiedAt: nowIso() });
  }

  @Post(":id/representatives/:repId/revoke")
  async revokeRep(@Staff() p: StaffPrincipal, @Param("id") id: string, @Param("repId") repId: string, @Body() body: unknown) {
    const { hubId, reason } = parse(zHubCtx.extend({ reason: zReason }), body);
    await this.access.require(p, RECEPTION, { hubId }, "representative.revoke");
    return this.updateRep(p, id, repId, hubId, "representative.revoked", { revokedAt: nowIso(), validTo: nowIso() }, reason);
  }

  private async updateRep(p: StaffPrincipal, patientId: string, repId: string, hubId: string, action: string, patch: Record<string, unknown>, reason?: string) {
    parse(zId, repId);
    return db.transaction(async (tx) => {
      const rep = found(await tx.orm.clinical.PatientRepresentative.where({ id: repId, patientId }).forNoKeyUpdate().first(), "Representative");
      if (rep.revokedAt) throw conflict("REVOKED", "Representative authority was revoked");
      const updated = await tx.orm.clinical.PatientRepresentative.where({ id: repId }).update(patch as never);
      await this.audit.record(p, { action, targetType: "patient_representative", targetId: repId, hubId, patientId, reason: reason ?? null }, tx);
      return updated;
    });
  }
}

/** Duplicate resolution and merge (PRD §8.8 — audited platform operations). */
@Controller("patient-duplicates")
export class DuplicatesController {
  constructor(
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(PatientsService) private readonly patients: PatientsService,
  ) {}

  @Get()
  async list(@Staff() p: StaffPrincipal, @Query() q: unknown) {
    const input = parse(zPage.extend({ status: z.enum(["open", "confirmed_duplicate", "not_duplicate"]).default("open") }), q);
    await this.access.require(p, REGIONAL, undefined, "patient.duplicates_list");
    const scope = await this.access.hubScope(p, REGIONAL);
    let query = db.orm.clinical.PatientDuplicateCandidate.where({ status: input.status });
    if (scope !== "all") {
      if (scope.length === 0) return { items: [] };
      query = query.where((c) =>
        or(
          c.patientA.some((pa) => pa.registeredAtHubId.in(scope)),
          c.patientB.some((pb) => pb.registeredAtHubId.in(scope)),
        ),
      );
    }
    const rows = await query
      .include("patientA", (x) => x.select(...MIN_PATIENT_FIELDS))
      .include("patientB", (x) => x.select(...MIN_PATIENT_FIELDS))
      .orderBy((c) => c.createdAt.desc())
      .limit(input.limit)
      .offset(input.offset)
      .all();
    return {
      items: rows.map((c) => ({
        id: c.id,
        status: c.status,
        matchReason: c.matchReason,
        createdAt: c.createdAt,
        patientA: c.patientA ? minimalPatient(c.patientA) : null,
        patientB: c.patientB ? minimalPatient(c.patientB) : null,
      })),
    };
  }

  @Post(":id/resolve")
  async resolve(@Staff() p: StaffPrincipal, @Param("id") id: string, @Body() body: unknown) {
    parse(zId, id);
    const input = parse(z.object({ resolution: z.enum(["not_duplicate", "confirmed_duplicate"]), note: zReason }), body);
    const c = found(await db.orm.clinical.PatientDuplicateCandidate.first({ id }), "Duplicate candidate");
    const a = await db.orm.clinical.Patient.select("registeredAtHubId").first({ id: c.patientAId });
    await this.access.require(p, REGIONAL, a?.registeredAtHubId ? { hubId: a.registeredAtHubId } : undefined, "patient.duplicate_resolve");
    return this.patients.resolveDuplicate(p, id, input.resolution, input.note);
  }

  /** Merge `mergedPatientId` into `survivorPatientId`. Platform admin only. */
  @Post("merge")
  async merge(@Staff() p: StaffPrincipal, @Body() body: unknown) {
    const input = parse(z.object({ survivorPatientId: zId, mergedPatientId: zId, reason: zReason, duplicateCandidateId: zId.optional() }), body);
    await this.access.require(p, ADMIN, undefined, "patient.merge");
    return this.patients.merge(p, input.survivorPatientId, input.mergedPatientId, input.reason, input.duplicateCandidateId ?? null);
  }
}
