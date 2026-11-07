import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";

import { db, nowIso } from "../../common/db.ts";
import { NotificationService } from "../../common/notification.service.ts";

/**
 * Queues one `appointment.reminder` per confirmed appointment whose session
 * starts within REMINDER_HOURS (default 24). Disable with REMINDERS=off.
 */
@Injectable()
export class ReminderService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("Reminders");
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(@Inject(NotificationService) private readonly notifications: NotificationService) {}

  onModuleInit() {
    if (process.env.REMINDERS === "off") return;
    this.timer = setInterval(() => void this.run(), 10 * 60_000);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async run(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const hours = Number(process.env.REMINDER_HOURS ?? 24);
      const now = nowIso();
      const until = new Date(Date.now() + hours * 3600_000).toISOString();
      const due = await db.orm.hub.Appointment.select("id", "patientId")
        .where({ status: "confirmed" })
        .where((a) => a.session.some((s) => s.startsAt.gt(now)))
        .where((a) => a.session.some((s) => s.startsAt.lte(until)))
        .limit(1000)
        .all();
      let queued = 0;
      for (const a of due) {
        const already = await db.orm.ops.Notification.select("id").where({ relatedId: a.id, templateCode: "appointment.reminder" }).first();
        if (already) continue;
        await db.transaction(async (tx) => {
          await this.notifications.enqueue(tx, {
            template: "appointment.reminder",
            patientId: a.patientId,
            deepLink: `healora://appointments/${a.id}`,
            relatedType: "appointment",
            relatedId: a.id,
          });
        });
        queued++;
      }
      return queued;
    } catch (err) {
      this.logger.warn(`reminder run failed: ${(err as Error).message}`);
      return 0;
    } finally {
      this.running = false;
    }
  }
}
