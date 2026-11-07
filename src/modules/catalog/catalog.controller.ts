import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Put, Query } from "@nestjs/common";

import { AccessService } from "../../common/access.service.ts";
import { AuditService } from "../../common/audit.service.ts";
import { Staff } from "../../common/auth/decorators.ts";
import type { StaffPrincipal } from "../../common/auth/principal.ts";
import { db, nowIso, type Tx } from "../../common/db.ts";
import { badRequest, conflict, found, unprocessable } from "../../common/errors.ts";
import { CLINICAL_GOVERNANCE, CLINICAL_ROLES, OPS_READ } from "../../common/roles.ts";
import { parse, z, zDecimal, zId, zInstant, zReason } from "../../common/validation.ts";

const ANY_STAFF = [...new Set([...OPS_READ, ...CLINICAL_ROLES, ...CLINICAL_GOVERNANCE])];
const ROLES = ["special_team_lead", "field_health_worker", "local_doctor", "registered_doctor"] as const;
const ALL_ROLES = [
  "platform_super_admin", "regional_ops_manager", "hub_manager", "reception_officer", "queue_coordinator", "equipment_officer",
  "operations_auditor", "clinical_ops_admin", "special_team_lead", "field_health_worker", "local_doctor", "registered_doctor",
] as const;
const STATION_TYPES = ["registration", "vitals", "doctor_review", "counselling", "waiting", "other"] as const;
const EQUIPMENT = ["bp_monitor", "glucometer", "weighing_scale", "stadiometer", "thermometer", "pulse_oximeter", "tablet", "printer", "other"] as const;
const PURPOSES = ["hub_service", "health_data_processing", "teleconsultation", "overseas_sharing", "caregiver_authority", "call_recording", "marketing"] as const;
const SEVERITIES = ["low", "medium", "high", "critical"] as const;
const ACTIONS = ["repeat_measurement", "contact_doctor", "urgent_review", "referral"] as const;

const zCode = z.string().trim().min(2).max(60).regex(/^[a-z0-9_.-]+$/i, "Letters, digits, _ . - only");

/** Structured alert rule condition (PRD §13.2). Evaluated by the team-app capture flow. */
export const alertConditionSchema = z.object({
  op: z.enum([">", ">=", "<", "<=", "==", "!="]),
  value: z.number().finite(),
  unit: z.string().max(20).optional(),
  context: z.string().max(40).optional(),
});

const alertRuleSchema = z.object({
  code: zCode,
  observationCode: zCode,
  condition: alertConditionSchema,
  action: z.enum(ACTIONS),
  severity: z.enum(SEVERITIES),
  messageEn: z.string().trim().min(3).max(500),
  messageBn: z.string().trim().max(500).optional(),
});

const requirementSchema = z
  .object({
    kind: z.enum(["staff_role", "station_type", "equipment_type"]),
    staffRole: z.enum(ALL_ROLES).optional(),
    stationType: z.enum(STATION_TYPES).optional(),
    equipmentCategory: z.enum(EQUIPMENT).optional(),
    minCount: z.number().int().min(1).max(50).default(1),
    mandatory: z.boolean().default(true),
  })
  .refine(
    (r) =>
      (r.kind === "staff_role" && r.staffRole && !r.stationType && !r.equipmentCategory) ||
      (r.kind === "station_type" && r.stationType && !r.staffRole && !r.equipmentCategory) ||
      (r.kind === "equipment_type" && r.equipmentCategory && !r.staffRole && !r.stationType),
    "Exactly the field matching `kind` must be set",
  );

@Controller("catalog")
export class CatalogController {
  constructor(
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  private gov(p: StaffPrincipal, action: string) {
    return this.access.require(p, CLINICAL_GOVERNANCE, undefined, action);
  }

  // =========================================================================
  // Service types
  // =========================================================================

  @Get("service-types")
  async listServiceTypes(@Staff() p: StaffPrincipal, @Query() query: unknown) {
    await this.access.require(p, ANY_STAFF, undefined, "service_type.list");
    const { includeInactive } = parse(z.object({ includeInactive: z.coerce.boolean().default(false) }), query);
    let c = db.orm.hub.ServiceType.orderBy((s) => s.name.asc());
    if (!includeInactive) c = c.where({ status: "active" });
    const items = await c.all();
    const reqs = await db.orm.hub.ServiceTypeRequirement.where((r) => r.serviceTypeId.in(items.map((i) => i.id).concat("00000000-0000-0000-0000-000000000000"))).all();
    return { items: items.map((s) => ({ ...s, requirements: reqs.filter((r) => r.serviceTypeId === s.id) })) };
  }

  @Get("service-types/:id")
  async getServiceType(@Staff() p: StaffPrincipal, @Param("id") id: string) {
    await this.access.require(p, ANY_STAFF, undefined, "service_type.get");
    const st = found(await db.orm.hub.ServiceType.first({ id: parse(zId, id) }), "Service type");
    const requirements = await db.orm.hub.ServiceTypeRequirement.where({ serviceTypeId: st.id }).all();
    const protocol = st.protocolId ? await db.orm.clinical.ClinicalProtocol.select("id", "code", "version", "name", "status").first({ id: st.protocolId }) : null;
    return { ...st, requirements, protocol };
  }

  @Post("service-types")
  async createServiceType(@Staff() p: StaffPrincipal, @Body() body: unknown) {
    await this.gov(p, "service_type.create");
    const input = parse(
      z.object({
        code: zCode,
        name: z.string().trim().min(2).max(200),
        nameBn: z.string().trim().max(200).optional(),
        description: z.string().max(2000).optional(),
        protocolId: zId.optional(),
        defaultSlotMinutes: z.number().int().min(1).max(480).default(15),
        requiresDoctorReview: z.boolean().default(false),
        requirements: z.array(requirementSchema).max(30).default([]),
      }),
      body,
    );
    if (input.protocolId) await this.requireApprovedProtocol(input.protocolId);
    return db.transaction(async (tx) => {
      const { requirements, ...fields } = input;
      const st = await tx.orm.hub.ServiceType.create({ ...fields, nameBn: fields.nameBn ?? null, description: fields.description ?? null, protocolId: fields.protocolId ?? null });
      for (const r of requirements) await tx.orm.hub.ServiceTypeRequirement.create(this.reqRow(st.id, r));
      await this.audit.record(p, { action: "service_type.create", targetType: "service_type", targetId: st.id, metadata: { code: st.code } }, tx);
      return { ...st, requirements: await tx.orm.hub.ServiceTypeRequirement.where({ serviceTypeId: st.id }).all() };
    });
  }

  @Patch("service-types/:id")
  async updateServiceType(@Staff() p: StaffPrincipal, @Param("id") id: string, @Body() body: unknown) {
    await this.gov(p, "service_type.update");
    const stId = parse(zId, id);
    found(await db.orm.hub.ServiceType.first({ id: stId }), "Service type");
    const input = parse(
      z
        .object({
          name: z.string().trim().min(2).max(200),
          nameBn: z.string().trim().max(200).nullable(),
          description: z.string().max(2000).nullable(),
          protocolId: zId.nullable(),
          defaultSlotMinutes: z.number().int().min(1).max(480),
          requiresDoctorReview: z.boolean(),
          status: z.enum(["active", "inactive"]),
        })
        .partial(),
      body,
    );
    if (input.protocolId) await this.requireApprovedProtocol(input.protocolId);
    return db.transaction(async (tx) => {
      const st = await tx.orm.hub.ServiceType.where({ id: stId }).update(input);
      await this.audit.record(p, { action: "service_type.update", targetType: "service_type", targetId: stId, metadata: { fields: Object.keys(input) } }, tx);
      return st;
    });
  }

  @Post("service-types/:id/requirements")
  async addRequirement(@Staff() p: StaffPrincipal, @Param("id") id: string, @Body() body: unknown) {
    await this.gov(p, "service_type.requirement.add");
    const stId = parse(zId, id);
    found(await db.orm.hub.ServiceType.first({ id: stId }), "Service type");
    const r = parse(requirementSchema, body);
    return db.transaction(async (tx) => {
      const row = await tx.orm.hub.ServiceTypeRequirement.create(this.reqRow(stId, r));
      await this.audit.record(p, { action: "service_type.requirement.add", targetType: "service_type", targetId: stId, metadata: { requirementId: row.id, kind: r.kind } }, tx);
      return row;
    });
  }

  @Delete("service-types/:id/requirements/:reqId")
  async removeRequirement(@Staff() p: StaffPrincipal, @Param("id") id: string, @Param("reqId") reqId: string) {
    await this.gov(p, "service_type.requirement.remove");
    const stId = parse(zId, id);
    const rid = parse(zId, reqId);
    found(await db.orm.hub.ServiceTypeRequirement.where({ id: rid, serviceTypeId: stId }).first(), "Requirement");
    return db.transaction(async (tx) => {
      await tx.orm.hub.ServiceTypeRequirement.where({ id: rid }).delete();
      await this.audit.record(p, { action: "service_type.requirement.remove", targetType: "service_type", targetId: stId, metadata: { requirementId: rid } }, tx);
      return { removed: true };
    });
  }

  private reqRow(serviceTypeId: string, r: z.infer<typeof requirementSchema>) {
    return {
      serviceTypeId,
      kind: r.kind,
      staffRole: r.staffRole ?? null,
      stationType: r.stationType ?? null,
      equipmentCategory: r.equipmentCategory ?? null,
      minCount: r.minCount,
      mandatory: r.mandatory,
    };
  }

  private async requireApprovedProtocol(protocolId: string) {
    const pr = found(await db.orm.clinical.ClinicalProtocol.first({ id: protocolId }), "Protocol");
    if (pr.status !== "approved") throw unprocessable("PROTOCOL_NOT_APPROVED", "Only an approved protocol can be linked to a service");
  }

  // =========================================================================
  // Observation definitions
  // =========================================================================

  @Get("observation-definitions")
  async listObservationDefs(@Staff() p: StaffPrincipal) {
    await this.access.require(p, ANY_STAFF, undefined, "observation_definition.list");
    return { items: await db.orm.clinical.ObservationDefinition.orderBy((d) => d.code.asc()).all() };
  }

  @Post("observation-definitions")
  async createObservationDef(@Staff() p: StaffPrincipal, @Body() body: unknown) {
    await this.gov(p, "observation_definition.create");
    const input = parse(obsDefSchema, body);
    return db.transaction(async (tx) => {
      const row = await tx.orm.clinical.ObservationDefinition.create(obsDefRow(input));
      await this.audit.record(p, { action: "observation_definition.create", targetType: "observation_definition", targetId: row.id, metadata: { code: row.code } }, tx);
      return row;
    });
  }

  @Patch("observation-definitions/:code")
  async updateObservationDef(@Staff() p: StaffPrincipal, @Param("code") code: string, @Body() body: unknown) {
    await this.gov(p, "observation_definition.update");
    const def = found(await db.orm.clinical.ObservationDefinition.where({ code: parse(zCode, code) }).first(), "Observation definition");
    const input = parse(obsDefSchema.omit({ code: true }).partial().extend({ status: z.enum(["active", "inactive"]).optional() }), body);
    if (input.valueType && input.valueType !== def.valueType) {
      const used = await db.orm.clinical.Observation.select("id").where({ observationCode: def.code }).first();
      if (used) throw conflict("DEFINITION_IN_USE", "valueType cannot change once observations exist");
    }
    return db.transaction(async (tx) => {
      const row = await tx.orm.clinical.ObservationDefinition.where({ id: def.id }).update(input as never);
      await this.audit.record(p, { action: "observation_definition.update", targetType: "observation_definition", targetId: def.id, metadata: { code: def.code, fields: Object.keys(input) } }, tx);
      return row;
    });
  }

  // =========================================================================
  // Clinical protocols (versioned; approved versions are immutable)
  // =========================================================================

  @Get("protocols")
  async listProtocols(@Staff() p: StaffPrincipal, @Query() query: unknown) {
    await this.access.require(p, ANY_STAFF, undefined, "protocol.list");
    const f = parse(z.object({ code: z.string().optional(), status: z.enum(["draft", "approved", "retired"]).optional() }), query);
    let c = db.orm.clinical.ClinicalProtocol.orderBy([(x) => x.code.asc(), (x) => x.version.desc()]);
    if (f.code) c = c.where({ code: f.code });
    if (f.status) c = c.where({ status: f.status });
    return { items: await c.include("clinicalOwner", (u) => u.select("id", "name")).limit(500).all() };
  }

  @Get("protocols/:id")
  async getProtocol(@Staff() p: StaffPrincipal, @Param("id") id: string) {
    await this.access.require(p, ANY_STAFF, undefined, "protocol.get");
    const pr = found(
      await db.orm.clinical.ClinicalProtocol.where({ id: parse(zId, id) })
        .include("clinicalOwner", (u) => u.select("id", "name"))
        .include("approvedBy", (u) => u.select("id", "name"))
        .first(),
      "Protocol",
    );
    const observations = await db.orm.clinical.ProtocolObservation.where({ protocolId: pr.id }).orderBy((o) => o.sortOrder.asc()).all();
    const alertRules = await db.orm.clinical.ProtocolAlertRule.where({ protocolId: pr.id }).orderBy((r) => r.code.asc()).all();
    return { ...pr, observations, alertRules };
  }

  /** New draft version. `copyFromId` clones observations and alert rules from an existing version. */
  @Post("protocols")
  async createProtocol(@Staff() p: StaffPrincipal, @Body() body: unknown) {
    await this.gov(p, "protocol.create");
    const input = parse(
      z.object({
        code: zCode,
        name: z.string().trim().min(2).max(200),
        description: z.string().max(4000).optional(),
        clinicalOwnerId: zId,
        documentRef: z.string().max(500).optional(),
        guidelineReference: z.string().max(500).optional(),
        copyFromId: zId.optional(),
      }),
      body,
    );
    found(await db.orm.identity.User.first({ id: input.clinicalOwnerId }), "Clinical owner");
    if (await db.orm.clinical.ClinicalProtocol.where({ code: input.code, status: "draft" }).first()) {
      throw conflict("DRAFT_EXISTS", "A draft version of this protocol already exists; edit it instead");
    }
    const source = input.copyFromId ? found(await db.orm.clinical.ClinicalProtocol.first({ id: input.copyFromId }), "Source protocol") : null;
    if (source && source.code !== input.code) throw badRequest("CODE_MISMATCH", "copyFromId must be a version of the same protocol code");
    return db.transaction(async (tx) => {
      const latest = await tx.orm.clinical.ClinicalProtocol.where({ code: input.code }).orderBy((x) => x.version.desc()).first();
      const { copyFromId: _c, ...fields } = input;
      const pr = await tx.orm.clinical.ClinicalProtocol.create({
        ...fields,
        description: fields.description ?? null,
        documentRef: fields.documentRef ?? null,
        guidelineReference: fields.guidelineReference ?? null,
        version: (latest?.version ?? 0) + 1,
        status: "draft",
      });
      if (source) {
        for (const o of await tx.orm.clinical.ProtocolObservation.where({ protocolId: source.id }).all()) {
          await tx.orm.clinical.ProtocolObservation.create({ protocolId: pr.id, observationCode: o.observationCode, required: o.required, permittedRoles: o.permittedRoles, repeatRule: o.repeatRule as never, sortOrder: o.sortOrder });
        }
        for (const r of await tx.orm.clinical.ProtocolAlertRule.where({ protocolId: source.id }).all()) {
          await tx.orm.clinical.ProtocolAlertRule.create({ protocolId: pr.id, code: r.code, observationCode: r.observationCode, condition: r.condition as never, action: r.action, severity: r.severity, messageEn: r.messageEn, messageBn: r.messageBn });
        }
      }
      await this.audit.record(p, { action: "protocol.create", targetType: "clinical_protocol", targetId: pr.id, metadata: { code: pr.code, version: pr.version, copiedFrom: source?.id ?? null } }, tx);
      return pr;
    });
  }

  @Patch("protocols/:id")
  async updateProtocol(@Staff() p: StaffPrincipal, @Param("id") id: string, @Body() body: unknown) {
    await this.gov(p, "protocol.update");
    const pr = await this.draftProtocol(parse(zId, id));
    const input = parse(
      z
        .object({
          name: z.string().trim().min(2).max(200),
          description: z.string().max(4000).nullable(),
          clinicalOwnerId: zId,
          documentRef: z.string().max(500).nullable(),
          guidelineReference: z.string().max(500).nullable(),
        })
        .partial(),
      body,
    );
    if (input.clinicalOwnerId) found(await db.orm.identity.User.first({ id: input.clinicalOwnerId }), "Clinical owner");
    return db.transaction(async (tx) => {
      const row = await tx.orm.clinical.ClinicalProtocol.where({ id: pr.id }).update(input);
      await this.audit.record(p, { action: "protocol.update", targetType: "clinical_protocol", targetId: pr.id, metadata: { fields: Object.keys(input) } }, tx);
      return row;
    });
  }

  /** Add or replace one required/optional observation on a draft protocol. */
  @Put("protocols/:id/observations/:code")
  async upsertProtocolObservation(@Staff() p: StaffPrincipal, @Param("id") id: string, @Param("code") code: string, @Body() body: unknown) {
    await this.gov(p, "protocol.observation.put");
    const pr = await this.draftProtocol(parse(zId, id));
    const observationCode = parse(zCode, code);
    const def = found(await db.orm.clinical.ObservationDefinition.where({ code: observationCode }).first(), "Observation definition");
    if (def.status !== "active") throw unprocessable("DEFINITION_INACTIVE", "Observation definition is inactive");
    const input = parse(
      z.object({
        required: z.boolean().default(true),
        permittedRoles: z.array(z.enum(ROLES)).min(1),
        repeatRule: z.object({ count: z.number().int().min(1).max(5), intervalMinutes: z.number().int().min(0).max(120).optional(), trigger: z.enum(["always", "on_alert"]).default("on_alert") }).nullable().optional(),
        sortOrder: z.number().int().min(0).max(1000).default(0),
      }),
      body,
    );
    return db.transaction(async (tx) => {
      const existing = await tx.orm.clinical.ProtocolObservation.where({ protocolId: pr.id, observationCode }).first();
      const data = { required: input.required, permittedRoles: input.permittedRoles, repeatRule: (input.repeatRule ?? null) as never, sortOrder: input.sortOrder };
      const row = existing
        ? await tx.orm.clinical.ProtocolObservation.where({ id: existing.id }).update(data)
        : await tx.orm.clinical.ProtocolObservation.create({ protocolId: pr.id, observationCode, ...data });
      await this.audit.record(p, { action: "protocol.observation.put", targetType: "clinical_protocol", targetId: pr.id, metadata: { observationCode } }, tx);
      return row;
    });
  }

  @Delete("protocols/:id/observations/:code")
  async removeProtocolObservation(@Staff() p: StaffPrincipal, @Param("id") id: string, @Param("code") code: string) {
    await this.gov(p, "protocol.observation.remove");
    const pr = await this.draftProtocol(parse(zId, id));
    const observationCode = parse(zCode, code);
    found(await db.orm.clinical.ProtocolObservation.where({ protocolId: pr.id, observationCode }).first(), "Protocol observation");
    return db.transaction(async (tx) => {
      await tx.orm.clinical.ProtocolObservation.where({ protocolId: pr.id, observationCode }).delete();
      await this.audit.record(p, { action: "protocol.observation.remove", targetType: "clinical_protocol", targetId: pr.id, metadata: { observationCode } }, tx);
      return { removed: true };
    });
  }

  @Post("protocols/:id/alert-rules")
  async addAlertRule(@Staff() p: StaffPrincipal, @Param("id") id: string, @Body() body: unknown) {
    await this.gov(p, "protocol.alert_rule.add");
    const pr = await this.draftProtocol(parse(zId, id));
    const input = parse(alertRuleSchema, body);
    await this.checkRuleObservation(pr.id, input.observationCode);
    return db.transaction(async (tx) => {
      const row = await tx.orm.clinical.ProtocolAlertRule.create({ protocolId: pr.id, ...input, condition: input.condition as never, messageBn: input.messageBn ?? null });
      await this.audit.record(p, { action: "protocol.alert_rule.add", targetType: "clinical_protocol", targetId: pr.id, metadata: { ruleId: row.id, code: row.code } }, tx);
      return row;
    });
  }

  @Patch("protocols/:id/alert-rules/:ruleId")
  async updateAlertRule(@Staff() p: StaffPrincipal, @Param("id") id: string, @Param("ruleId") ruleId: string, @Body() body: unknown) {
    await this.gov(p, "protocol.alert_rule.update");
    const pr = await this.draftProtocol(parse(zId, id));
    const rid = parse(zId, ruleId);
    found(await db.orm.clinical.ProtocolAlertRule.where({ id: rid, protocolId: pr.id }).first(), "Alert rule");
    const input = parse(alertRuleSchema.partial(), body);
    if (input.observationCode) await this.checkRuleObservation(pr.id, input.observationCode);
    return db.transaction(async (tx) => {
      const row = await tx.orm.clinical.ProtocolAlertRule.where({ id: rid }).update({ ...input, condition: input.condition as never });
      await this.audit.record(p, { action: "protocol.alert_rule.update", targetType: "clinical_protocol", targetId: pr.id, metadata: { ruleId: rid, fields: Object.keys(input) } }, tx);
      return row;
    });
  }

  @Delete("protocols/:id/alert-rules/:ruleId")
  async removeAlertRule(@Staff() p: StaffPrincipal, @Param("id") id: string, @Param("ruleId") ruleId: string) {
    await this.gov(p, "protocol.alert_rule.remove");
    const pr = await this.draftProtocol(parse(zId, id));
    const rid = parse(zId, ruleId);
    found(await db.orm.clinical.ProtocolAlertRule.where({ id: rid, protocolId: pr.id }).first(), "Alert rule");
    return db.transaction(async (tx) => {
      await tx.orm.clinical.ProtocolAlertRule.where({ id: rid }).delete();
      await this.audit.record(p, { action: "protocol.alert_rule.remove", targetType: "clinical_protocol", targetId: pr.id, metadata: { ruleId: rid } }, tx);
      return { removed: true };
    });
  }

  /** Approve a draft: it becomes immutable; the previous approved version of the code is retired. */
  @Post("protocols/:id/approve")
  async approveProtocol(@Staff() p: StaffPrincipal, @Param("id") id: string, @Body() body: unknown) {
    await this.gov(p, "protocol.approve");
    const pr = await this.draftProtocol(parse(zId, id));
    const { effectiveFrom } = parse(z.object({ effectiveFrom: zInstant.optional() }), body);
    const obs = await db.orm.clinical.ProtocolObservation.select("id").where({ protocolId: pr.id }).first();
    if (!obs) throw unprocessable("PROTOCOL_EMPTY", "A protocol needs at least one observation before approval");
    return db.transaction(async (tx) => {
      const now = nowIso();
      const from = effectiveFrom ?? now;
      const previous = await tx.orm.clinical.ClinicalProtocol.where({ code: pr.code, status: "approved" }).all();
      for (const prev of previous) {
        await tx.orm.clinical.ClinicalProtocol.where({ id: prev.id }).update({ status: "retired", effectiveTo: from });
        await this.repointServiceTypes(tx, prev.id, pr.id);
      }
      const row = await tx.orm.clinical.ClinicalProtocol.where({ id: pr.id }).update({ status: "approved", approvedById: p.userId, approvedAt: now, effectiveFrom: from });
      await this.audit.record(p, { action: "protocol.approve", targetType: "clinical_protocol", targetId: pr.id, priority: "high", metadata: { code: pr.code, version: pr.version, retired: previous.map((x) => x.id) } }, tx);
      return row;
    });
  }

  @Post("protocols/:id/retire")
  async retireProtocol(@Staff() p: StaffPrincipal, @Param("id") id: string, @Body() body: unknown) {
    await this.gov(p, "protocol.retire");
    const prId = parse(zId, id);
    const { reason } = parse(z.object({ reason: zReason }), body);
    const pr = found(await db.orm.clinical.ClinicalProtocol.first({ id: prId }), "Protocol");
    if (pr.status === "retired") throw conflict("ALREADY_RETIRED", "Protocol is already retired");
    const linked = await db.orm.hub.ServiceType.select("id", "code").where({ protocolId: prId, status: "active" }).all();
    if (linked.length) throw conflict("PROTOCOL_IN_USE", "Active service types still use this protocol", { serviceTypes: linked.map((s) => s.code) });
    return db.transaction(async (tx) => {
      const row = await tx.orm.clinical.ClinicalProtocol.where({ id: prId }).update({ status: "retired", effectiveTo: nowIso() });
      await this.audit.record(p, { action: "protocol.retire", targetType: "clinical_protocol", targetId: prId, reason, priority: "high" }, tx);
      return row;
    });
  }

  private async draftProtocol(id: string) {
    const pr = found(await db.orm.clinical.ClinicalProtocol.first({ id }), "Protocol");
    if (pr.status !== "draft") throw conflict("PROTOCOL_IMMUTABLE", "Approved or retired protocols cannot be changed; create a new version");
    return pr;
  }

  private async checkRuleObservation(protocolId: string, observationCode: string) {
    const po = await db.orm.clinical.ProtocolObservation.where({ protocolId, observationCode }).first();
    if (!po) throw unprocessable("OBSERVATION_NOT_IN_PROTOCOL", "Alert rules must reference an observation in the protocol");
  }

  /** Service types follow the newly approved version of their protocol code. */
  private async repointServiceTypes(tx: Tx, fromId: string, toId: string) {
    await tx.orm.hub.ServiceType.where({ protocolId: fromId }).updateAll({ protocolId: toId });
  }

  // =========================================================================
  // Consent templates (versioned per code + language)
  // =========================================================================

  @Get("consent-templates")
  async listConsentTemplates(@Staff() p: StaffPrincipal, @Query() query: unknown) {
    await this.access.require(p, ANY_STAFF, undefined, "consent_template.list");
    const f = parse(z.object({ purpose: z.enum(PURPOSES).optional(), language: z.string().optional(), status: z.enum(["draft", "approved", "retired"]).optional(), code: z.string().optional() }), query);
    let c = db.orm.clinical.ConsentTemplate.orderBy([(t) => t.code.asc(), (t) => t.version.desc()]);
    if (f.purpose) c = c.where({ purpose: f.purpose });
    if (f.language) c = c.where({ language: f.language });
    if (f.status) c = c.where({ status: f.status });
    if (f.code) c = c.where({ code: f.code });
    return { items: await c.limit(500).all() };
  }

  @Get("consent-templates/:id")
  async getConsentTemplate(@Staff() p: StaffPrincipal, @Param("id") id: string) {
    await this.access.require(p, ANY_STAFF, undefined, "consent_template.get");
    return found(await db.orm.clinical.ConsentTemplate.first({ id: parse(zId, id) }), "Consent template");
  }

  @Post("consent-templates")
  async createConsentTemplate(@Staff() p: StaffPrincipal, @Body() body: unknown) {
    await this.gov(p, "consent_template.create");
    const input = parse(
      z.object({
        code: zCode,
        purpose: z.enum(PURPOSES),
        language: z.enum(["bn", "en"]),
        title: z.string().trim().min(3).max(300),
        body: z.string().trim().min(20).max(20000),
        verbalScript: z.string().max(20000).optional(),
        dataCategories: z.array(z.string().min(1).max(60)).min(1).max(30),
        recipients: z.array(z.string().min(1).max(100)).min(1).max(30),
      }),
      body,
    );
    return db.transaction(async (tx) => {
      const draft = await tx.orm.clinical.ConsentTemplate.where({ code: input.code, language: input.language, status: "draft" }).first();
      if (draft) throw conflict("DRAFT_EXISTS", "A draft for this code and language already exists; edit it instead", { id: draft.id });
      const latest = await tx.orm.clinical.ConsentTemplate.where({ code: input.code, language: input.language }).orderBy((t) => t.version.desc()).first();
      if (latest && latest.purpose !== input.purpose) throw badRequest("PURPOSE_MISMATCH", "A consent code cannot change purpose");
      const row = await tx.orm.clinical.ConsentTemplate.create({ ...input, verbalScript: input.verbalScript ?? null, version: (latest?.version ?? 0) + 1, status: "draft" });
      await this.audit.record(p, { action: "consent_template.create", targetType: "consent_template", targetId: row.id, metadata: { code: row.code, version: row.version, language: row.language } }, tx);
      return row;
    });
  }

  @Patch("consent-templates/:id")
  async updateConsentTemplate(@Staff() p: StaffPrincipal, @Param("id") id: string, @Body() body: unknown) {
    await this.gov(p, "consent_template.update");
    const tid = parse(zId, id);
    const t = found(await db.orm.clinical.ConsentTemplate.first({ id: tid }), "Consent template");
    if (t.status !== "draft") throw conflict("TEMPLATE_IMMUTABLE", "Approved or retired consent wording cannot change; create a new version");
    const input = parse(
      z
        .object({
          title: z.string().trim().min(3).max(300),
          body: z.string().trim().min(20).max(20000),
          verbalScript: z.string().max(20000).nullable(),
          dataCategories: z.array(z.string().min(1).max(60)).min(1).max(30),
          recipients: z.array(z.string().min(1).max(100)).min(1).max(30),
        })
        .partial(),
      body,
    );
    return db.transaction(async (tx) => {
      const row = await tx.orm.clinical.ConsentTemplate.where({ id: tid }).update(input);
      await this.audit.record(p, { action: "consent_template.update", targetType: "consent_template", targetId: tid, metadata: { fields: Object.keys(input) } }, tx);
      return row;
    });
  }

  @Post("consent-templates/:id/approve")
  async approveConsentTemplate(@Staff() p: StaffPrincipal, @Param("id") id: string, @Body() body: unknown) {
    await this.gov(p, "consent_template.approve");
    const tid = parse(zId, id);
    const { effectiveFrom } = parse(z.object({ effectiveFrom: zInstant.optional() }), body);
    const t = found(await db.orm.clinical.ConsentTemplate.first({ id: tid }), "Consent template");
    if (t.status !== "draft") throw conflict("INVALID_TRANSITION", `Cannot approve a '${t.status}' template`);
    return db.transaction(async (tx) => {
      const from = effectiveFrom ?? nowIso();
      const prev = await tx.orm.clinical.ConsentTemplate.where({ code: t.code, language: t.language, status: "approved" }).all();
      for (const x of prev) await tx.orm.clinical.ConsentTemplate.where({ id: x.id }).update({ status: "retired", effectiveTo: from });
      const row = await tx.orm.clinical.ConsentTemplate.where({ id: tid }).update({ status: "approved", approvedById: p.userId, effectiveFrom: from });
      await this.audit.record(p, { action: "consent_template.approve", targetType: "consent_template", targetId: tid, priority: "high", metadata: { code: t.code, version: t.version, retired: prev.map((x) => x.id) } }, tx);
      return row;
    });
  }

  @Post("consent-templates/:id/retire")
  async retireConsentTemplate(@Staff() p: StaffPrincipal, @Param("id") id: string, @Body() body: unknown) {
    await this.gov(p, "consent_template.retire");
    const tid = parse(zId, id);
    const { reason } = parse(z.object({ reason: zReason }), body);
    const t = found(await db.orm.clinical.ConsentTemplate.first({ id: tid }), "Consent template");
    if (t.status === "retired") throw conflict("ALREADY_RETIRED", "Template is already retired");
    return db.transaction(async (tx) => {
      const row = await tx.orm.clinical.ConsentTemplate.where({ id: tid }).update({ status: "retired", effectiveTo: nowIso() });
      await this.audit.record(p, { action: "consent_template.retire", targetType: "consent_template", targetId: tid, reason }, tx);
      return row;
    });
  }

  // =========================================================================
  // Queue priority policies (approved by clinical governance, PRD rule 14)
  // =========================================================================

  @Get("queue-priority-policies")
  async listPolicies(@Staff() p: StaffPrincipal, @Query() query: unknown) {
    await this.access.require(p, ANY_STAFF, undefined, "queue_policy.list");
    const { includeInactive } = parse(z.object({ includeInactive: z.coerce.boolean().default(false) }), query);
    let c = db.orm.hub.QueuePriorityPolicy.orderBy([(x) => x.priorityLevel.desc(), (x) => x.code.asc()]);
    if (!includeInactive) c = c.where({ status: "active" });
    return { items: await c.all() };
  }

  @Post("queue-priority-policies")
  async createPolicy(@Staff() p: StaffPrincipal, @Body() body: unknown) {
    await this.gov(p, "queue_policy.create");
    const input = parse(z.object({ code: zCode, description: z.string().trim().min(5).max(1000), priorityLevel: z.number().int().min(1).max(100) }), body);
    return db.transaction(async (tx) => {
      const prev = await tx.orm.hub.QueuePriorityPolicy.where({ code: input.code }).orderBy((x) => x.version.desc()).first();
      await tx.orm.hub.QueuePriorityPolicy.where({ code: input.code, status: "active" }).updateAll({ status: "inactive" });
      const row = await tx.orm.hub.QueuePriorityPolicy.create({ ...input, version: (prev?.version ?? 0) + 1, approvedById: p.userId, approvedAt: nowIso(), status: "active" });
      await this.audit.record(p, { action: "queue_policy.create", targetType: "queue_priority_policy", targetId: row.id, metadata: { code: row.code, version: row.version, priorityLevel: row.priorityLevel } }, tx);
      return row;
    });
  }

  @Post("queue-priority-policies/:id/retire")
  async retirePolicy(@Staff() p: StaffPrincipal, @Param("id") id: string, @Body() body: unknown) {
    await this.gov(p, "queue_policy.retire");
    const pid = parse(zId, id);
    const { reason } = parse(z.object({ reason: zReason }), body);
    const pol = found(await db.orm.hub.QueuePriorityPolicy.first({ id: pid }), "Queue priority policy");
    if (pol.status !== "active") throw conflict("NOT_ACTIVE", "Policy is not active");
    return db.transaction(async (tx) => {
      const row = await tx.orm.hub.QueuePriorityPolicy.where({ id: pid }).update({ status: "inactive" });
      await this.audit.record(p, { action: "queue_policy.retire", targetType: "queue_priority_policy", targetId: pid, reason }, tx);
      return row;
    });
  }
}

const obsDefSchema = z.object({
  code: zCode,
  externalSystem: z.string().max(60).nullable().optional(),
  externalCode: z.string().max(60).nullable().optional(),
  name: z.string().trim().min(2).max(200),
  nameBn: z.string().trim().max(200).nullable().optional(),
  valueType: z.enum(["quantity", "coded", "text", "scale"]),
  canonicalUnit: z.string().max(30).nullable().optional(),
  allowedUnits: z.array(z.string().min(1).max(30)).max(10).default([]),
  plausibleMin: zDecimal.nullable().optional(),
  plausibleMax: zDecimal.nullable().optional(),
  allowedContexts: z.array(z.string().min(1).max(40)).max(20).default([]),
  allowedMethods: z.array(z.string().min(1).max(40)).max(20).default([]),
  allowedSites: z.array(z.string().min(1).max(40)).max(20).default([]),
  isDerived: z.boolean().default(false),
});

function obsDefRow(i: z.infer<typeof obsDefSchema>) {
  if (i.plausibleMin && i.plausibleMax && Number(i.plausibleMin) >= Number(i.plausibleMax)) throw badRequest("INVALID_RANGE", "plausibleMin must be below plausibleMax");
  if (i.valueType === "quantity" && i.allowedUnits.length === 0) throw badRequest("UNITS_REQUIRED", "Quantity observations need at least one allowed unit");
  return {
    ...i,
    externalSystem: i.externalSystem ?? null,
    externalCode: i.externalCode ?? null,
    nameBn: i.nameBn ?? null,
    canonicalUnit: i.canonicalUnit ?? null,
    plausibleMin: i.plausibleMin ?? null,
    plausibleMax: i.plausibleMax ?? null,
  };
}
