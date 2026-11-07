import { Inject, Injectable } from "@nestjs/common";

import type { StaffPrincipal } from "../../common/auth/principal.ts";
import { type DbLike, nowIso, type Tx } from "../../common/db.ts";
import { EventsService } from "../../common/events.service.ts";
import { CREDENTIALED, type StaffRole } from "../../common/roles.ts";
import { z, zDecimal, zId, zInstant } from "../../common/validation.ts";
import { ClinicalContextService } from "./clinical-context.service.ts";

/** One measurement as submitted by the team app (PRD §9.6). */
export const zObservationValue = z.object({
  observationCode: z.string().min(1).max(64),
  valueNumeric: zDecimal.optional(),
  valueCode: z.string().min(1).max(64).optional(),
  valueText: z.string().min(1).max(2000).optional(),
  unit: z.string().max(32).optional(),
  method: z.string().max(64).optional(),
  bodySite: z.string().max(64).optional(),
  posture: z.string().max(32).optional(),
  context: z.string().max(64).optional(),
  measuredAt: zInstant,
  clientRecordedAt: zInstant.optional(),
  equipmentId: zId.optional(),
  deviceAttributionMissingReason: z.string().min(3).max(500).optional(),
  readingGroupId: zId.optional(),
  repeatOfId: zId.optional(),
  repeatReason: z.string().min(3).max(500).optional(),
  factualNote: z.string().max(2000).optional(),
});

export const zSyncItem = zObservationValue.extend({
  id: zId,
  idempotencyKey: z.string().min(8).max(200),
  encounterId: zId,
});
export type SyncItem = z.infer<typeof zSyncItem>;
export type ObservationValue = z.infer<typeof zObservationValue>;

export class ObservationRejection extends Error {
  constructor(
    readonly category: "validation" | "permission" | "identity_mismatch" | "conflict",
    message: string,
  ) {
    super(message);
  }
}

export interface AlertOut {
  id: string;
  action: string;
  severity: string;
  messageEn: string;
  messageBn: string | null;
}

type Condition = { op?: string; value?: number | string; unit?: string; context?: string };

export const REVIEW_ALERT_ACTIONS = ["contact_doctor", "urgent_review", "referral"];

type EncounterRow = {
  id: string;
  patientId: string;
  hubId: string | null;
  sessionId: string | null;
  protocolId: string | null;
  status: string;
  requiresDoctorReview: boolean;
};

/**
 * Validation, append-only insert and alert evaluation for observations.
 * Values are never altered: implausible numbers are stored as measured and
 * flagged `implausible` for human review.
 */
@Injectable()
export class ObservationService {
  constructor(
    @Inject(ClinicalContextService) private readonly ctx: ClinicalContextService,
    @Inject(EventsService) private readonly events: EventsService,
  ) {}

  /** Validate a value against catalogue, protocol, credential and device rules. */
  async validate(tx: DbLike, p: StaffPrincipal, enc: EncounterRow, performerRole: StaffRole, v: ObservationValue) {
    const def = await tx.orm.clinical.ObservationDefinition.where({ code: v.observationCode }).first();
    if (!def || def.status !== "active") throw new ObservationRejection("validation", `Unknown or inactive observation code '${v.observationCode}'`);
    if (def.isDerived) throw new ObservationRejection("validation", "Derived values are calculated by the server and cannot be submitted");
    if (!enc.protocolId) throw new ObservationRejection("validation", "Encounter has no approved protocol");
    const protocolItem = await tx.orm.clinical.ProtocolObservation.where({ protocolId: enc.protocolId, observationCode: v.observationCode }).first();
    if (!protocolItem) throw new ObservationRejection("validation", `'${v.observationCode}' is not part of this encounter's protocol`);
    if (protocolItem.permittedRoles.length && !protocolItem.permittedRoles.includes(performerRole)) {
      throw new ObservationRejection("permission", `Role ${performerRole} may not collect '${v.observationCode}' under this protocol`);
    }

    const given = [v.valueNumeric, v.valueCode, v.valueText].filter((x) => x !== undefined).length;
    if (given !== 1) throw new ObservationRejection("validation", "Provide exactly one of valueNumeric, valueCode or valueText");
    const wantsNumeric = def.valueType === "quantity" || def.valueType === "scale";
    if (wantsNumeric && v.valueNumeric === undefined) throw new ObservationRejection("validation", `'${def.code}' requires valueNumeric`);
    if (def.valueType === "coded" && v.valueCode === undefined) throw new ObservationRejection("validation", `'${def.code}' requires valueCode`);
    if (def.valueType === "text" && v.valueText === undefined) throw new ObservationRejection("validation", `'${def.code}' requires valueText`);

    if (v.valueNumeric !== undefined) {
      if (!v.unit) throw new ObservationRejection("validation", "unit is required for a numeric value");
      if (def.allowedUnits.length && !def.allowedUnits.includes(v.unit)) {
        throw new ObservationRejection("validation", `Unit '${v.unit}' is not allowed for '${def.code}' (allowed: ${def.allowedUnits.join(", ")})`);
      }
    }
    if (def.code === "blood_glucose" && !v.context) throw new ObservationRejection("validation", "context (fasting/random/post_meal) is required for blood glucose");
    if (v.context && def.allowedContexts.length && !def.allowedContexts.includes(v.context)) throw new ObservationRejection("validation", `Context '${v.context}' is not allowed for '${def.code}'`);
    if (v.method && def.allowedMethods.length && !def.allowedMethods.includes(v.method)) throw new ObservationRejection("validation", `Method '${v.method}' is not allowed for '${def.code}'`);
    if (v.bodySite && def.allowedSites.length && !def.allowedSites.includes(v.bodySite)) throw new ObservationRejection("validation", `Site '${v.bodySite}' is not allowed for '${def.code}'`);

    const measured = Date.parse(v.measuredAt);
    if (measured > Date.now() + 5 * 60_000) throw new ObservationRejection("validation", "measuredAt is in the future");

    // Credential scope (PRD §6.2, §13.1).
    const cred = await this.ctx.activeCredential(tx, p.userId);
    if (CREDENTIALED.includes(performerRole) && !cred) throw new ObservationRejection("permission", "An active verified credential is required to record measurements");
    if (cred && cred.permittedObservationCodes.length && !cred.permittedObservationCodes.includes(v.observationCode)) {
      throw new ObservationRejection("permission", `Your credential does not permit '${v.observationCode}'`);
    }

    // Device attribution (PRD §8.9).
    if (v.equipmentId) {
      const eq = await tx.orm.hub.Equipment.select("id", "hubId", "status", "supportedObservationCodes").first({ id: v.equipmentId });
      if (!eq || eq.hubId !== enc.hubId) throw new ObservationRejection("validation", "Equipment does not belong to this hub");
      if (["out_of_service", "retired", "maintenance"].includes(eq.status)) throw new ObservationRejection("validation", `Equipment is ${eq.status} and cannot be used`);
      if (eq.supportedObservationCodes.length && !eq.supportedObservationCodes.includes(v.observationCode)) {
        throw new ObservationRejection("validation", "Equipment does not support this measurement");
      }
    } else if (enc.hubId && !v.deviceAttributionMissingReason) {
      throw new ObservationRejection("validation", "Select the device used, or give deviceAttributionMissingReason");
    }

    if (v.repeatOfId) {
      if (!v.repeatReason) throw new ObservationRejection("validation", "repeatReason is required for a repeat measurement");
      const prior = await tx.orm.clinical.Observation.select("encounterId", "observationCode").first({ id: v.repeatOfId });
      if (!prior || prior.encounterId !== enc.id || prior.observationCode !== v.observationCode) {
        throw new ObservationRejection("validation", "repeatOfId must reference the same measurement in this encounter");
      }
    }

    let validationStatus: "valid" | "implausible" = "valid";
    if (v.valueNumeric !== undefined) {
      const n = Number(v.valueNumeric);
      if ((def.plausibleMin !== null && n < Number(def.plausibleMin)) || (def.plausibleMax !== null && n > Number(def.plausibleMax))) validationStatus = "implausible";
    }
    return { def, cred, validationStatus };
  }

  /** Insert (append-only), update task / remeasurement, evaluate alerts, emit. */
  async insert(
    tx: Tx,
    p: StaffPrincipal,
    enc: EncounterRow,
    performerRole: StaffRole,
    v: ObservationValue & { id?: string; idempotencyKey: string },
    extra: { supersedesId?: string; correctionReason?: string; status?: "final" | "amended" } = {},
  ) {
    const { cred, validationStatus } = await this.validate(tx, p, enc, performerRole, v);
    const now = nowIso();
    const obs = await tx.orm.clinical.Observation.create({
      ...(v.id ? { id: v.id } : {}),
      encounterId: enc.id,
      patientId: enc.patientId,
      observationCode: v.observationCode,
      readingGroupId: v.readingGroupId ?? null,
      valueNumeric: v.valueNumeric ?? null,
      valueCode: v.valueCode ?? null,
      valueText: v.valueText ?? null,
      unit: v.unit ?? null,
      method: v.method ?? null,
      bodySite: v.bodySite ?? null,
      posture: v.posture ?? null,
      context: v.context ?? null,
      measuredAt: v.measuredAt,
      clientRecordedAt: v.clientRecordedAt ?? v.measuredAt,
      serverReceivedAt: now,
      performerUserId: p.userId,
      performerRole,
      performerCredentialId: cred?.id ?? null,
      sourceType: enc.hubId ? "hub_visit" : "home_visit",
      hubId: enc.hubId,
      sessionId: enc.sessionId,
      equipmentId: v.equipmentId ?? null,
      deviceAttributionMissingReason: v.equipmentId ? null : (v.deviceAttributionMissingReason ?? null),
      repeatOfId: v.repeatOfId ?? null,
      repeatReason: v.repeatReason ?? null,
      supersedesId: extra.supersedesId ?? null,
      correctionReason: extra.correctionReason ?? null,
      status: extra.status ?? "final",
      validationStatus,
      reviewStatus: "not_required",
      protocolId: enc.protocolId,
      idempotencyKey: v.idempotencyKey,
      factualNote: v.factualNote ?? null,
    });

    await tx.orm.clinical.EncounterTask.where({ encounterId: enc.id, observationCode: v.observationCode }).updateAll({
      status: "captured",
      missingReason: null,
      missingNote: null,
      completedById: p.userId,
      completedAt: now,
    });
    await tx.orm.clinical.RemeasurementRequest.where({ encounterId: enc.id, observationCode: v.observationCode, status: "open" }).updateAll({
      status: "fulfilled",
      fulfilledByObservationId: obs.id,
      fulfilledAt: now,
    });

    const alerts = await this.evaluateAlerts(tx, enc, obs.id, v);
    const needsReview = enc.requiresDoctorReview || alerts.length > 0 || validationStatus === "implausible";
    if (needsReview) await tx.orm.clinical.Observation.where({ id: obs.id }).update({ reviewStatus: "pending" });

    await this.deriveBmi(tx, p, enc, performerRole);

    await this.events.emit(tx, {
      eventType: extra.supersedesId ? "observation.corrected" : "observation.submitted",
      aggregateType: "observation",
      aggregateId: obs.id,
      hubId: enc.hubId,
      sessionId: enc.sessionId,
      correlationId: p.correlationId,
      payload: { observationId: obs.id, encounterId: enc.id, observationCode: v.observationCode, supersedesId: extra.supersedesId ?? null, alertCount: alerts.length, validationStatus },
    });
    return { observation: obs, alerts, validationStatus };
  }

  /** Approved, versioned protocol rules → ObservationAlert rows (prompts for human review). */
  async evaluateAlerts(tx: DbLike, enc: EncounterRow, observationId: string, v: ObservationValue): Promise<AlertOut[]> {
    if (!enc.protocolId || v.valueNumeric === undefined) return [];
    const protocol = await tx.orm.clinical.ClinicalProtocol.select("status").first({ id: enc.protocolId });
    if (protocol?.status !== "approved") return [];
    const rules = await tx.orm.clinical.ProtocolAlertRule.where({ protocolId: enc.protocolId, observationCode: v.observationCode }).all();
    const value = Number(v.valueNumeric);
    const out: AlertOut[] = [];
    for (const rule of rules) {
      const c = (rule.condition ?? {}) as Condition;
      if (c.unit && c.unit !== v.unit) continue;
      if (c.context && c.context !== v.context) continue;
      const threshold = Number(c.value);
      if (!Number.isFinite(threshold)) continue;
      const hit =
        (c.op === ">" && value > threshold) ||
        (c.op === ">=" && value >= threshold) ||
        (c.op === "<" && value < threshold) ||
        (c.op === "<=" && value <= threshold) ||
        (c.op === "==" && value === threshold);
      if (!hit) continue;
      const alert = await tx.orm.clinical.ObservationAlert.create({
        observationId,
        encounterId: enc.id,
        alertRuleId: rule.id,
        action: rule.action,
        severity: rule.severity,
        status: "open",
      });
      out.push({ id: alert.id, action: rule.action, severity: rule.severity, messageEn: rule.messageEn, messageBn: rule.messageBn });
    }
    return out;
  }

  /**
   * BMI is derived, never entered (PRD §9.6): recalculated from the latest
   * current height (cm) and weight (kg) in the encounter when the protocol has it.
   */
  private async deriveBmi(tx: Tx, p: StaffPrincipal, enc: EncounterRow, performerRole: StaffRole) {
    if (!enc.protocolId) return;
    const inProtocol = await tx.orm.clinical.ProtocolObservation.where({ protocolId: enc.protocolId, observationCode: "bmi" }).first();
    if (!inProtocol) return;
    const current = await tx.orm.clinical.Observation.where({ encounterId: enc.id })
      .where((o) => o.observationCode.in(["body_height", "body_weight", "bmi"]))
      .where((o) => o.status.in(["final", "amended"]))
      .orderBy((o) => o.serverReceivedAt.desc())
      .all();
    const height = current.find((o) => o.observationCode === "body_height" && o.unit === "cm");
    const weight = current.find((o) => o.observationCode === "body_weight" && o.unit === "kg");
    if (!height || !weight || !height.valueNumeric || !weight.valueNumeric) return;
    const prior = current.find((o) => o.observationCode === "bmi");
    if (prior) {
      const sources = await tx.orm.clinical.ObservationDerivation.where({ derivedId: prior.id }).all();
      const ids = new Set(sources.map((s) => s.sourceId));
      if (ids.has(height.id) && ids.has(weight.id)) return;
      await tx.orm.clinical.Observation.where({ id: prior.id }).update({ status: "superseded" });
    }
    const m = Number(height.valueNumeric) / 100;
    const bmi = (Number(weight.valueNumeric) / (m * m)).toFixed(1);
    const now = nowIso();
    const derived = await tx.orm.clinical.Observation.create({
      encounterId: enc.id,
      patientId: enc.patientId,
      observationCode: "bmi",
      valueNumeric: bmi,
      unit: "kg/m2",
      method: "calculated",
      measuredAt: now,
      clientRecordedAt: now,
      serverReceivedAt: now,
      performerUserId: p.userId,
      performerRole,
      sourceType: enc.hubId ? "hub_visit" : "home_visit",
      hubId: enc.hubId,
      sessionId: enc.sessionId,
      deviceAttributionMissingReason: "derived value",
      supersedesId: prior?.id ?? null,
      correctionReason: prior ? "recalculated from updated source measurements" : null,
      isDerived: true,
      derivationRule: "bmi = weight_kg / (height_cm/100)^2",
      derivationRuleVersion: 1,
      status: prior ? "amended" : "final",
      protocolId: enc.protocolId,
      idempotencyKey: `derived:bmi:${height.id}:${weight.id}`,
    });
    await tx.orm.clinical.ObservationDerivation.create({ derivedId: derived.id, sourceId: height.id });
    await tx.orm.clinical.ObservationDerivation.create({ derivedId: derived.id, sourceId: weight.id });
    await tx.orm.clinical.EncounterTask.where({ encounterId: enc.id, observationCode: "bmi" }).updateAll({ status: "captured", completedAt: now, completedById: p.userId });
  }
}
