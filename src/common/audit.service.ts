import { Injectable } from "@nestjs/common";

import type { Principal } from "./auth/principal.ts";
import { db, type DbLike, nowIso } from "./db.ts";
import type { StaffRole } from "./roles.ts";

export interface AuditEntry {
  action: string;
  targetType: string;
  targetId?: string | null;
  hubId?: string | null;
  regionId?: string | null;
  patientId?: string | null;
  reason?: string | null;
  outcome?: "success" | "denied" | "error";
  priority?: "normal" | "high";
  /** Non-sensitive metadata only. Never put clinical values here. */
  metadata?: Record<string, unknown>;
  /** Role the actor was acting in, when meaningful. */
  actorRole?: StaffRole | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOrNull = (v: string | null | undefined) => (v && UUID_RE.test(v) ? v : null);

/** Append-only audit trail (PRD §16.2). Pass `tx` to commit with the change. */
@Injectable()
export class AuditService {
  async record(actor: Principal | null, entry: AuditEntry, tx: DbLike = db): Promise<void> {
    const staffId = actor?.kind === "staff" ? actor.userId : null;
    await tx.orm.ops.AuditEvent.create({
      occurredAt: nowIso(),
      actorUserId: staffId,
      actorRole: entry.actorRole ?? (actor?.kind === "staff" ? (actor.assignments[0]?.role ?? null) : null),
      scopeHubId: uuidOrNull(entry.hubId),
      scopeRegionId: uuidOrNull(entry.regionId),
      action: entry.action,
      targetType: entry.targetType,
      targetId: uuidOrNull(entry.targetId),
      patientId: uuidOrNull(entry.patientId ?? (actor?.kind === "patient" ? actor.patientId : null)),
      reason: entry.reason ?? null,
      outcome: entry.outcome ?? "success",
      priority: entry.priority ?? "normal",
      sourceIp: actor?.ip ?? null,
      userAgent: actor?.userAgent ?? null,
      deviceInstallationId: uuidOrNull(actor?.deviceInstallationId),
      authSessionId: actor?.authSessionId ?? null,
      correlationId: actor?.correlationId ?? null,
      metadata: (entry.metadata ?? null) as never,
    });
  }
}
