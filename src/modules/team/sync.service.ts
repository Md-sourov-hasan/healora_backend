import { Inject, Injectable } from "@nestjs/common";

import { AuditService } from "../../common/audit.service.ts";
import type { StaffPrincipal } from "../../common/auth/principal.ts";
import { db, nowIso } from "../../common/db.ts";
import { badRequest, conflict, forbidden, found } from "../../common/errors.ts";
import { EventsService } from "../../common/events.service.ts";
import { NotificationService } from "../../common/notification.service.ts";
import type { StaffRole } from "../../common/roles.ts";
import { ClinicalContextService } from "../clinical-core/clinical-context.service.ts";
import { type AlertOut, ObservationRejection, ObservationService, type SyncItem, zSyncItem } from "../clinical-core/observation.service.ts";

export interface SyncResult {
  id: string;
  idempotencyKey: string;
  submissionId: string | null;
  status: "accepted" | "duplicate" | "rejected" | "quarantined";
  errorCategory?: string;
  message?: string;
  serverReceivedAt: string;
  validationStatus?: string;
  alerts?: Omit<AlertOut, "id">[];
}

/** Encounter states in which new measurements may be attached. */
export const CAPTURABLE = ["assigned", "in_progress", "awaiting_sync", "sync_failed", "awaiting_remeasurement"];
const CLOSED = ["completed", "unable_to_complete", "referred"];

/**
 * Offline-safe, idempotent observation sync (PRD §9.9, §10.6).
 * Each item commits independently; one bad item never blocks the rest.
 */
@Injectable()
export class SyncService {
  constructor(
    @Inject(ObservationService) private readonly observations: ObservationService,
    @Inject(ClinicalContextService) private readonly ctx: ClinicalContextService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(EventsService) private readonly events: EventsService,
    @Inject(NotificationService) private readonly notifications: NotificationService,
  ) {}

  /** The X-Device-Id installation must exist, be the caller's and not revoked. */
  async requireDevice(p: StaffPrincipal) {
    if (!p.deviceInstallationId) throw badRequest("DEVICE_REQUIRED", "X-Device-Id header with a registered installation id is required");
    const device = await db.orm.ops.DeviceInstallation.first({ id: p.deviceInstallationId }).catch(() => null);
    if (!device || device.userId !== p.userId) throw forbidden("Device is not registered to you", "DEVICE_NOT_REGISTERED");
    if (device.revokedAt) throw forbidden("Device has been revoked", "DEVICE_REVOKED");
    return device;
  }

  /** Items are validated one by one so a malformed item never blocks the rest of an offline batch. */
  async syncBatch(p: StaffPrincipal, rawItems: unknown[]): Promise<{ results: SyncResult[]; serverTime: string }> {
    const device = await this.requireDevice(p);
    const results: SyncResult[] = [];
    for (const raw of rawItems) {
      const parsed = zSyncItem.safeParse(raw);
      if (!parsed.success) {
        const r = (raw ?? {}) as { id?: unknown; idempotencyKey?: unknown };
        results.push({
          id: typeof r.id === "string" ? r.id : "",
          idempotencyKey: typeof r.idempotencyKey === "string" ? r.idempotencyKey : "",
          submissionId: null,
          status: "rejected",
          errorCategory: "validation",
          message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 300),
          serverReceivedAt: nowIso(),
        });
        continue;
      }
      results.push(await this.syncOne(p, device.id, parsed.data));
    }
    await db.orm.ops.DeviceInstallation.where({ id: device.id }).update({ lastSyncAt: nowIso(), lastSeenAt: nowIso() });
    return { results, serverTime: nowIso() };
  }

  private async existing(item: SyncItem): Promise<SyncResult | null> {
    const prev = await db.orm.ops.SyncSubmission.where({ idempotencyKey: item.idempotencyKey }).first();
    if (!prev) return null;
    return {
      id: prev.entityId,
      idempotencyKey: item.idempotencyKey,
      submissionId: prev.id,
      status: "duplicate",
      errorCategory: prev.status === "accepted" || prev.status === "resolved" ? undefined : (prev.errorCategory ?? undefined),
      message: `Already processed as '${prev.status}'`,
      serverReceivedAt: prev.serverReceivedAt,
    };
  }

  async syncOne(p: StaffPrincipal, deviceId: string, item: SyncItem): Promise<SyncResult> {
    const dup = await this.existing(item);
    if (dup) return dup;

    const receivedAt = nowIso();
    const enc = await db.orm.clinical.Encounter.first({ id: item.encounterId }).catch(() => null);
    const base = {
      idempotencyKey: item.idempotencyKey,
      deviceInstallationId: deviceId,
      userId: p.userId,
      hubId: enc?.hubId ?? null,
      sessionId: enc?.sessionId ?? null,
      encounterId: enc?.id ?? null,
      entityType: "observation",
      entityId: item.id,
      operation: "create",
      clientCreatedAt: item.clientRecordedAt ?? item.measuredAt,
      serverReceivedAt: receivedAt,
    };

    const reject = async (category: "validation" | "permission" | "identity_mismatch" | "conflict" | "server_error", message: string): Promise<SyncResult> => {
      try {
        const sub = await db.orm.ops.SyncSubmission.create({ ...base, status: "rejected", errorCategory: category, errorMessage: message.slice(0, 300) });
        return { id: item.id, idempotencyKey: item.idempotencyKey, submissionId: sub.id, status: "rejected", errorCategory: category, message, serverReceivedAt: receivedAt };
      } catch (e) {
        if ((e as { sqlState?: string }).sqlState === "23505") return (await this.existing(item))!;
        throw e;
      }
    };

    if (!enc) return reject("validation", "Encounter not found");

    const assignment = await db.orm.clinical.EncounterAssignment.where({ encounterId: enc.id, userId: p.userId })
      .orderBy((a) => a.assignedAt.desc())
      .first();
    const active = assignment && ["assigned", "accepted", "started"].includes(assignment.status) ? assignment : null;

    // Late sync after closure or reassignment → quarantine, never attach (PRD §10.6).
    const quarantineCategory = CLOSED.includes(enc.status) ? "encounter_closed" : assignment && !active ? "encounter_reassigned" : null;
    if (quarantineCategory) return this.quarantine(p, base, item, enc, quarantineCategory);
    if (!active) return reject("permission", "You are not assigned to this encounter");

    if (enc.identityMatchStatus !== "confirmed") return reject("identity_mismatch", "Patient identity is not confirmed for this encounter");
    if (!CAPTURABLE.includes(enc.status)) return reject("conflict", `Encounter is '${enc.status}' and cannot accept measurements`);
    const consent = await this.ctx.consentStatus(db, enc.patientId);
    if (!consent.satisfied) return reject("permission", `Required consent missing: ${consent.missing.join(", ")}`);

    const clash = await db.orm.clinical.Observation.select("id").first({ id: item.id });
    if (clash) return reject("conflict", "An observation with this id already exists");

    try {
      return await db.transaction(async (tx) => {
        const locked = await tx.orm.clinical.Encounter.where({ id: enc.id }).forNoKeyUpdate().first();
        if (!locked || !CAPTURABLE.includes(locked.status)) throw new ObservationRejection("conflict", "Encounter changed state; retry");
        const sub = await tx.orm.ops.SyncSubmission.create({ ...base, status: "accepted" });
        const { observation, alerts, validationStatus } = await this.observations.insert(tx, p, locked, active.role as StaffRole, item);

        if (locked.status === "awaiting_sync" || locked.status === "sync_failed" || locked.status === "assigned") {
          await tx.orm.clinical.Encounter.where({ id: locked.id }).update({ status: "in_progress", version: locked.version + 1 });
        }
        await this.recoverSyncFailures(tx, p, locked.id, locked.hubId, locked.sessionId);
        await this.audit.record(
          p,
          { action: "observation.create", targetType: "observation", targetId: observation.id, hubId: locked.hubId, patientId: locked.patientId, actorRole: active.role as StaffRole, metadata: { encounterId: locked.id, code: item.observationCode, submissionId: sub.id, validationStatus } },
          tx,
        );
        return {
          id: observation.id,
          idempotencyKey: item.idempotencyKey,
          submissionId: sub.id,
          status: "accepted" as const,
          serverReceivedAt: observation.serverReceivedAt,
          validationStatus,
          alerts: alerts.map(({ id: _id, ...a }) => a),
        };
      });
    } catch (e) {
      if (e instanceof ObservationRejection) return reject(e.category, e.message);
      if ((e as { sqlState?: string }).sqlState === "23505") {
        const again = await this.existing(item);
        if (again) return again;
        return reject("conflict", "Duplicate observation id or idempotency key");
      }
      if ((e as { sqlState?: string }).sqlState === "23514") return reject("validation", "The measurement violates a data rule");
      throw e;
    }
  }

  private async quarantine(
    p: StaffPrincipal,
    base: Record<string, unknown> & { hubId: string | null; sessionId: string | null },
    item: SyncItem,
    enc: { id: string; hubId: string | null; sessionId: string | null; patientId: string },
    category: "encounter_closed" | "encounter_reassigned",
  ): Promise<SyncResult> {
    const receivedAt = String(base.serverReceivedAt);
    try {
      return await db.transaction(async (tx) => {
        const sub = await tx.orm.ops.SyncSubmission.create({
          ...base,
          status: "quarantined",
          errorCategory: category,
          errorMessage: category === "encounter_closed" ? "Encounter was closed before this measurement synced" : "Encounter was reassigned before this measurement synced",
          quarantinedPayload: item,
        } as never);
        if (enc.hubId) {
          await tx.orm.hub.OperationalException.create({
            hubId: enc.hubId,
            sessionId: enc.sessionId,
            encounterId: enc.id,
            syncSubmissionId: sub.id,
            type: "late_sync_quarantined",
            severity: "high",
            status: "open",
            summary: "A late measurement sync was quarantined for clinical review",
            dedupeKey: `late_sync:${sub.id}`,
            raisedAt: receivedAt,
          });
        }
        await this.events.emit(tx, {
          eventType: "sync.failed",
          aggregateType: "sync_submission",
          aggregateId: sub.id,
          hubId: enc.hubId,
          sessionId: enc.sessionId,
          correlationId: p.correlationId,
          payload: { submissionId: sub.id, encounterId: enc.id, status: "quarantined", errorCategory: category },
        });
        await this.audit.record(p, { action: "sync.quarantine", targetType: "sync_submission", targetId: sub.id, hubId: enc.hubId, patientId: enc.patientId, priority: "high", metadata: { category, encounterId: enc.id } }, tx);
        return { id: item.id, idempotencyKey: item.idempotencyKey, submissionId: sub.id, status: "quarantined" as const, errorCategory: category, message: "Held for review; not added to the record", serverReceivedAt: receivedAt };
      });
    } catch (e) {
      if ((e as { sqlState?: string }).sqlState === "23505") return (await this.existing(item))!;
      throw e;
    }
  }

  /** A successful sync clears this encounter's open sync exceptions. */
  private async recoverSyncFailures(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], p: StaffPrincipal, encounterId: string, hubId: string | null, sessionId: string | null) {
    const open = await tx.orm.hub.OperationalException.where({ encounterId })
      .where((e) => e.type.in(["unsynced_device_data", "sync_rejected"]))
      .where((e) => e.status.in(["open", "acknowledged"]))
      .all();
    if (!open.length) return;
    await tx.orm.hub.OperationalException.where((e) => e.id.in(open.map((o) => o.id))).updateAll({ status: "resolved", resolvedAt: nowIso(), resolvedById: p.userId, resolutionNote: "Recovered by successful sync" });
    await this.events.emit(tx, { eventType: "sync.recovered", aggregateType: "encounter", aggregateId: encounterId, hubId, sessionId, payload: { encounterId } });
  }

  async status(p: StaffPrincipal) {
    const byStatus = await db.orm.ops.SyncSubmission.where({ userId: p.userId }).groupBy("status").aggregate((a) => ({ count: a.count() }));
    const devices = await db.orm.ops.DeviceInstallation.select("id", "platform", "appVersion", "pendingCount", "oldestPendingAt", "lastSyncAt", "revokedAt").where({ userId: p.userId }).all();
    const attention = await db.orm.ops.SyncSubmission.select("id", "idempotencyKey", "encounterId", "entityId", "status", "errorCategory", "errorMessage", "serverReceivedAt", "resolvedAt")
      .where({ userId: p.userId })
      .where((s) => s.status.in(["rejected", "quarantined"]))
      .where((s) => s.resolvedAt.isNull())
      .orderBy((s) => s.serverReceivedAt.desc())
      .limit(50)
      .all();
    const pending = devices.filter((d) => !d.revokedAt).reduce((n, d) => n + d.pendingCount, 0);
    const oldest = devices.map((d) => d.oldestPendingAt).filter((x): x is string => !!x).sort()[0] ?? null;
    return { counts: Object.fromEntries(byStatus.map((r) => [r.status, r.count])), devicePending: pending, oldestPendingAt: oldest, devices, needsAttention: attention, serverTime: nowIso() };
  }

  /** Re-send a rejected item (corrected on device) under a new idempotency key. */
  async resubmit(p: StaffPrincipal, submissionId: string, item: SyncItem) {
    const sub = found(await db.orm.ops.SyncSubmission.first({ id: submissionId }), "Sync submission");
    if (sub.userId !== p.userId) throw forbidden();
    if (sub.status !== "rejected" || sub.resolvedAt) throw conflict("NOT_RESUBMITTABLE", "Only unresolved rejected submissions can be resubmitted");
    if (item.idempotencyKey === sub.idempotencyKey) throw badRequest("NEW_IDEMPOTENCY_KEY_REQUIRED", "Use a new idempotency key for a resubmission");
    const device = await this.requireDevice(p);
    const result = await this.syncOne(p, device.id, item);
    if (result.status === "accepted") {
      await db.orm.ops.SyncSubmission.where({ id: sub.id }).update({ status: "resolved", resolvedAt: nowIso(), resolvedById: p.userId, resolutionNote: `Resubmitted as ${result.submissionId}`, retryCount: sub.retryCount + 1 });
    } else {
      await db.orm.ops.SyncSubmission.where({ id: sub.id }).update({ retryCount: sub.retryCount + 1 });
    }
    return { original: sub.id, result };
  }
}
