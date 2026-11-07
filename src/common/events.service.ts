import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { Subject } from "rxjs";

import { db, type DbLike, nowIso } from "./db.ts";

/** Domain events from PRD §10.4. */
export type DomainEventType =
  | "hub.created"
  | "hub.updated"
  | "session.published"
  | "session.updated"
  | "session.cancelled"
  | "appointment.created"
  | "appointment.changed"
  | "patient.checked_in"
  | "queue.updated"
  | "encounter.assigned"
  | "encounter.started"
  | "encounter.updated"
  | "observation.submitted"
  | "observation.corrected"
  | "doctor.review_requested"
  | "doctor.review_completed"
  | "encounter.completed"
  | "sync.failed"
  | "sync.recovered"
  | "equipment.status_changed"
  | "exception.raised"
  | "roster.changed";

export interface DomainEventInput {
  eventType: DomainEventType;
  aggregateType: string;
  aggregateId: string;
  hubId?: string | null;
  sessionId?: string | null;
  correlationId?: string | null;
  /** IDs and statuses only — never raw health values (PRD §10.4). */
  payload: Record<string, unknown>;
}

export interface PublishedEvent {
  id: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  hubId: string | null;
  sessionId: string | null;
  occurredAt: string;
  payload: unknown;
}

/**
 * Transactional outbox. `emit` writes the event in the caller's transaction;
 * the relay publishes committed events to in-process subscribers (live queue
 * SSE) and is the hook for an external broker.
 */
@Injectable()
export class EventsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("Outbox");
  readonly stream = new Subject<PublishedEvent>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  async emit(tx: DbLike, e: DomainEventInput): Promise<void> {
    await tx.orm.ops.DomainEvent.create({
      eventType: e.eventType,
      schemaVersion: 1,
      occurredAt: nowIso(),
      aggregateType: e.aggregateType,
      aggregateId: e.aggregateId,
      hubId: e.hubId ?? null,
      sessionId: e.sessionId ?? null,
      correlationId: e.correlationId ?? null,
      payload: e.payload as never,
    });
  }

  onModuleInit() {
    if (process.env.OUTBOX_RELAY === "off") return;
    this.timer = setInterval(() => void this.relay(), Number(process.env.OUTBOX_INTERVAL_MS ?? 1500));
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async relay(batch = 100): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      return await db.transaction(async (tx) => {
        const rows = await tx.orm.ops.DomainEvent.where((d) => d.publishedAt.isNull())
          .orderBy((d) => d.occurredAt.asc())
          .limit(batch)
          .forUpdate({ skipLocked: true })
          .all();
        for (const r of rows) {
          this.stream.next({
            id: r.id,
            eventType: r.eventType,
            aggregateType: r.aggregateType,
            aggregateId: r.aggregateId,
            hubId: r.hubId,
            sessionId: r.sessionId,
            occurredAt: r.occurredAt,
            payload: r.payload,
          });
        }
        if (rows.length) {
          await tx.orm.ops.DomainEvent.where((d) => d.id.in(rows.map((r) => r.id))).updateAll({
            publishedAt: nowIso(),
          });
        }
        return rows.length;
      });
    } catch (err) {
      this.logger.warn(`relay failed: ${(err as Error).message}`);
      return 0;
    } finally {
      this.running = false;
    }
  }
}
