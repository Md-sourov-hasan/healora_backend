import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";

import { db, dhakaDate, nowIso } from "../../common/db.ts";
import { EventsService } from "../../common/events.service.ts";
import { NotificationService } from "../../common/notification.service.ts";

type ExceptionType =
  | "unassigned_encounter"
  | "not_called_within_threshold"
  | "task_not_submitted"
  | "sync_rejected"
  | "late_sync_quarantined"
  | "awaiting_doctor_review"
  | "completed_with_unresolved_steps"
  | "insufficient_staffing"
  | "unsynced_device_data";

interface Detected {
  hubId: string;
  sessionId?: string | null;
  encounterId?: string | null;
  syncSubmissionId?: string | null;
  type: ExceptionType;
  severity: "low" | "medium" | "high" | "critical";
  /** Non-sensitive. */
  summary: string;
  dedupeKey: string;
}

/** Exception types whose lifecycle this scanner owns (raised and auto-resolved). */
export const SCANNED_TYPES: ExceptionType[] = [
  "unassigned_encounter",
  "not_called_within_threshold",
  "task_not_submitted",
  "sync_rejected",
  "late_sync_quarantined",
  "awaiting_doctor_review",
  "completed_with_unresolved_steps",
  "insufficient_staffing",
  "unsynced_device_data",
];

const OPEN = ["open", "acknowledged", "escalated"] as const;
const minutes = (env: string, fallback: number) => {
  const v = Number(process.env[env]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};
const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();

/**
 * Detects operational exceptions (PRD §8.10) and keeps the exception queue in
 * sync: one open row per dedupeKey, auto-resolved when the condition clears.
 */
@Injectable()
export class ExceptionScanner implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("ExceptionScanner");
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(EventsService) private readonly events: EventsService,
    @Inject(NotificationService) private readonly notifications: NotificationService,
  ) {}

  onModuleInit() {
    if (process.env.EXCEPTION_SCAN === "off") return;
    this.timer = setInterval(() => void this.scan().catch((e) => this.logger.warn(`scan failed: ${(e as Error).message}`)), minutes("EXCEPTION_SCAN_INTERVAL_SEC", 60) * 1000);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async scan(): Promise<{ detected: number; raised: number; autoResolved: number }> {
    if (this.running) return { detected: 0, raised: 0, autoResolved: 0 };
    this.running = true;
    try {
      const detected = await this.detect();
      let raised = 0;
      for (const d of detected) if (await this.upsert(d)) raised++;
      const keys = new Set(detected.map((d) => d.dedupeKey));
      const open = await db.orm.hub.OperationalException.select("id", "dedupeKey")
        .where((e) => e.type.in(SCANNED_TYPES))
        .where((e) => e.status.in([...OPEN]))
        .all();
      const cleared = open.filter((o) => !keys.has(o.dedupeKey)).map((o) => o.id);
      if (cleared.length) {
        await db.orm.hub.OperationalException.where((e) => e.id.in(cleared)).updateAll({
          status: "resolved",
          resolvedAt: nowIso(),
          resolutionNote: "Auto-resolved: condition cleared",
        });
      }
      return { detected: detected.length, raised, autoResolved: cleared.length };
    } finally {
      this.running = false;
    }
  }

  private async upsert(d: Detected): Promise<boolean> {
    const existing = await db.orm.hub.OperationalException.select("id").where({ dedupeKey: d.dedupeKey }).where((e) => e.status.in([...OPEN])).first();
    if (existing) return false;
    const managers = d.severity === "high" || d.severity === "critical" ? await this.hubManagers(d.hubId) : [];
    try {
      await db.transaction(async (tx) => {
        const row = await tx.orm.hub.OperationalException.create({
          hubId: d.hubId,
          sessionId: d.sessionId ?? null,
          encounterId: d.encounterId ?? null,
          syncSubmissionId: d.syncSubmissionId ?? null,
          type: d.type,
          severity: d.severity,
          summary: d.summary,
          dedupeKey: d.dedupeKey,
          raisedAt: nowIso(),
        });
        await this.events.emit(tx, {
          eventType: "exception.raised",
          aggregateType: "operational_exception",
          aggregateId: row.id,
          hubId: d.hubId,
          sessionId: d.sessionId ?? null,
          payload: { exceptionId: row.id, type: d.type, severity: d.severity, encounterId: d.encounterId ?? null },
        });
        if (d.severity === "high" || d.severity === "critical") {
          for (const userId of managers) {
            await this.notifications.enqueue(tx, { template: "staff.exception_raised", userId, relatedType: "operational_exception", relatedId: row.id, deepLink: `healora-hub://exceptions/${row.id}` });
          }
        }
      });
      return true;
    } catch (err) {
      if ((err as { sqlState?: string }).sqlState === "23505") return false; // raced with another scanner
      throw err;
    }
  }

  private async hubManagers(hubId: string): Promise<string[]> {
    const ids = new Set<string>();
    const hub = await db.orm.hub.Hub.select("managerUserId").first({ id: hubId });
    if (hub?.managerUserId) ids.add(hub.managerUserId);
    const rows = await db.orm.identity.RoleAssignment.select("userId").where({ hubId, role: "hub_manager", status: "active" }).all();
    for (const r of rows) ids.add(r.userId);
    return [...ids];
  }

  private async detect(): Promise<Detected[]> {
    const out: Detected[] = [];

    // 1. Encounters checked in but never assigned.
    const unassigned = await db.orm.clinical.Encounter.select("id", "hubId", "sessionId")
      .where({ status: "created", encounterType: "hub_visit" })
      .where((e) => e.hubId.isNotNull())
      .where((e) => e.openedAt.lt(ago(minutes("EXC_UNASSIGNED_MIN", 10))))
      .all();
    for (const e of unassigned) out.push({ hubId: e.hubId!, sessionId: e.sessionId, encounterId: e.id, type: "unassigned_encounter", severity: "medium", summary: "Checked-in patient has no team member assigned", dedupeKey: `unassigned:${e.id}` });

    // 2. Patients waiting too long to be called.
    const waiting = await db.orm.hub.QueueTicket.select("id", "hubId", "sessionId", "encounterId", "displayCode")
      .where({ status: "waiting" })
      .where((t) => t.issuedAt.lt(ago(minutes("EXC_WAIT_MIN", 45))))
      .all();
    for (const t of waiting) out.push({ hubId: t.hubId, sessionId: t.sessionId, encounterId: t.encounterId, type: "not_called_within_threshold", severity: "medium", summary: `Token ${t.displayCode} waiting beyond threshold`, dedupeKey: `wait:${t.id}` });

    // 3. Measurement work started but not submitted.
    const stale = await db.orm.clinical.Encounter.select("id", "hubId", "sessionId")
      .where({ status: "in_progress" })
      .where((e) => e.hubId.isNotNull())
      .where((e) => e.updatedAt.lt(ago(minutes("EXC_TASK_MIN", 30))))
      .all();
    const pendingTaskEncounters = await this.encountersWithPendingRequired(stale.map((s) => s.id));
    for (const e of stale) {
      if (pendingTaskEncounters.has(e.id)) out.push({ hubId: e.hubId!, sessionId: e.sessionId, encounterId: e.id, type: "task_not_submitted", severity: "medium", summary: "Measurement task started but not submitted", dedupeKey: `task:${e.id}` });
    }

    // 4. Sync submissions rejected or quarantined.
    const failedSync = await db.orm.ops.SyncSubmission.select("id", "hubId", "sessionId", "encounterId", "status", "errorCategory")
      .where((s) => s.status.in(["rejected", "quarantined"]))
      .where((s) => s.resolvedAt.isNull())
      .where((s) => s.hubId.isNotNull())
      .all();
    for (const s of failedSync) {
      const quarantined = s.status === "quarantined";
      out.push({
        hubId: s.hubId!,
        sessionId: s.sessionId,
        encounterId: s.encounterId,
        syncSubmissionId: s.id,
        type: quarantined ? "late_sync_quarantined" : "sync_rejected",
        severity: "high",
        summary: quarantined ? "Late submission quarantined for review" : `Sync rejected (${s.errorCategory ?? "unknown"})`,
        dedupeKey: `sync:${s.id}`,
      });
    }

    // 5. Waiting for doctor review too long.
    const review = await db.orm.clinical.Encounter.select("id", "hubId", "sessionId")
      .where({ status: "submitted_for_review" })
      .where((e) => e.hubId.isNotNull())
      .where((e) => e.submittedAt.lt(ago(minutes("EXC_REVIEW_MIN", 60))))
      .all();
    for (const e of review) out.push({ hubId: e.hubId!, sessionId: e.sessionId, encounterId: e.id, type: "awaiting_doctor_review", severity: "medium", summary: "Encounter waiting for local doctor review", dedupeKey: `review:${e.id}` });

    // 6. Completed although required steps are unresolved (last 7 days).
    const completed = await db.orm.clinical.Encounter.select("id", "hubId", "sessionId")
      .where({ status: "completed" })
      .where((e) => e.hubId.isNotNull())
      .where((e) => e.closedAt.gt(ago(7 * 24 * 60)))
      .all();
    const incomplete = await this.encountersWithPendingRequired(completed.map((c) => c.id));
    for (const e of completed) {
      if (incomplete.has(e.id)) out.push({ hubId: e.hubId!, sessionId: e.sessionId, encounterId: e.id, type: "completed_with_unresolved_steps", severity: "high", summary: "Encounter completed with required steps unresolved", dedupeKey: `incomplete:${e.id}` });
    }

    // 7. Today's sessions without minimum staffing.
    const sessions = await db.orm.hub.HubSession.select("id", "hubId", "serviceTypeId")
      .where({ sessionDate: dhakaDate() })
      .where((s) => s.status.in(["published", "open_for_booking", "full", "in_progress"]))
      .all();
    for (const s of sessions) {
      const reqs = await db.orm.hub.ServiceTypeRequirement.select("staffRole", "minCount").where({ serviceTypeId: s.serviceTypeId, kind: "staff_role", mandatory: true }).all();
      if (!reqs.length) continue;
      const shifts = await db.orm.hub.StaffShift.select("role", "userId").where({ sessionId: s.id }).where((x) => x.status.in(["approved", "checked_in"])).all();
      const short = reqs
        .map((r) => ({ role: r.staffRole, need: r.minCount, have: new Set(shifts.filter((x) => x.role === r.staffRole).map((x) => x.userId)).size }))
        .filter((r) => r.have < r.need);
      if (short.length) {
        out.push({
          hubId: s.hubId,
          sessionId: s.id,
          type: "insufficient_staffing",
          severity: "high",
          summary: `Staffing short: ${short.map((r) => `${r.role} ${r.have}/${r.need}`).join(", ")}`,
          dedupeKey: `staffing:${s.id}`,
        });
      }
    }

    // 8. Devices holding unsynced clinical data.
    const devices = await db.orm.ops.DeviceInstallation.select("id", "hubId", "pendingCount")
      .where((d) => d.pendingCount.gt(0))
      .where((d) => d.oldestPendingAt.lt(ago(minutes("EXC_SYNC_PENDING_MIN", 30))))
      .where((d) => d.hubId.isNotNull())
      .where((d) => d.revokedAt.isNull())
      .all();
    for (const d of devices) out.push({ hubId: d.hubId!, type: "unsynced_device_data", severity: "high", summary: `Device has ${d.pendingCount} unsynced item(s)`, dedupeKey: `device:${d.id}` });

    return out;
  }

  private async encountersWithPendingRequired(ids: string[]): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const rows = await db.orm.clinical.EncounterTask.select("encounterId").where({ required: true, status: "pending" }).where((t) => t.encounterId.in(ids)).all();
    return new Set(rows.map((r) => r.encounterId));
  }
}
