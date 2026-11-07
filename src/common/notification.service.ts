import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";

import { db, type DbLike, nowIso } from "./db.ts";

/**
 * Generic notification templates. Rendered text is deliberately non-clinical:
 * no diagnosis, vitals, reports or prescriptions in SMS/push previews
 * (PRD §8.12). Details are behind the authenticated deep link.
 */
export const TEMPLATES = {
  "appointment.confirmed": { category: "appointments", en: "Your Healora hub visit is confirmed.", bn: "আপনার হেলোরা হাব ভিজিট নিশ্চিত হয়েছে।" },
  "appointment.changed": { category: "appointments", en: "Your Healora hub visit has changed. Open the app for details.", bn: "আপনার হাব ভিজিটে পরিবর্তন হয়েছে। বিস্তারিত অ্যাপে দেখুন।" },
  "appointment.cancelled": { category: "appointments", en: "Your Healora hub visit was cancelled. Open the app to rebook.", bn: "আপনার হাব ভিজিট বাতিল হয়েছে। নতুন সময় নিতে অ্যাপ খুলুন।" },
  "appointment.reminder": { category: "reminders", en: "Reminder: you have a Healora hub visit soon.", bn: "মনে করিয়ে দিচ্ছি: শীঘ্রই আপনার হাব ভিজিট আছে।" },
  "session.cancelled": { category: "appointments", en: "A Healora hub session you booked was cancelled.", bn: "আপনার বুক করা হাব সেশনটি বাতিল হয়েছে।" },
  "hub.closed": { category: "appointments", en: "Your Healora hub is temporarily closed. Open the app for options.", bn: "আপনার হাব সাময়িকভাবে বন্ধ। বিকল্প দেখতে অ্যাপ খুলুন।" },
  "patient.checked_in": { category: "visit", en: "You are checked in. Your token number is in the app.", bn: "আপনার চেক-ইন হয়েছে। টোকেন নম্বর অ্যাপে দেখুন।" },
  "results.available": { category: "visit", en: "New results are available in your Healora app.", bn: "আপনার হেলোরা অ্যাপে নতুন ফলাফল এসেছে।" },
  "staff.encounter_assigned": { category: "work", en: "A patient has been assigned to you.", bn: "আপনাকে একজন রোগী নির্ধারণ করা হয়েছে।" },
  "staff.review_requested": { category: "work", en: "An encounter is waiting for your review.", bn: "একটি এনকাউন্টার আপনার রিভিউয়ের অপেক্ষায়।" },
  "staff.remeasurement_requested": { category: "work", en: "A doctor requested a repeat measurement.", bn: "ডাক্তার পুনরায় পরিমাপ চেয়েছেন।" },
  "staff.sync_failed": { category: "work", en: "Some captured data has not synced. Open the app.", bn: "কিছু তথ্য সিঙ্ক হয়নি। অ্যাপ খুলুন।" },
  "staff.roster_changed": { category: "work", en: "Your roster or session assignment changed.", bn: "আপনার রোস্টার বা সেশন পরিবর্তন হয়েছে।" },
  "staff.equipment_alert": { category: "work", en: "Equipment needs attention at your hub.", bn: "আপনার হাবে যন্ত্রপাতি দেখা প্রয়োজন।" },
  "staff.exception_raised": { category: "work", en: "An operational issue needs attention.", bn: "একটি অপারেশনাল সমস্যা দেখা প্রয়োজন।" },
} as const;

export type TemplateCode = keyof typeof TEMPLATES;
type Channel = "push" | "sms" | "whatsapp" | "in_app" | "email";

export interface NotifyInput {
  template: TemplateCode;
  patientId?: string;
  userId?: string;
  channels?: Channel[];
  deepLink?: string;
  relatedType?: string;
  relatedId?: string;
  serviceCritical?: boolean;
  language?: "bn" | "en";
}

/** Provider adapter. Replace with SMS gateway / FCM integrations. */
export interface NotificationProvider {
  name: string;
  send(channel: Channel, to: { patientId?: string | null; userId?: string | null }, text: string, deepLink: string | null): Promise<{ messageId: string }>;
}

class LogProvider implements NotificationProvider {
  name = "log";
  private readonly logger = new Logger("Notify");
  async send(channel: Channel, to: { patientId?: string | null; userId?: string | null }, _text: string) {
    this.logger.log(`[${channel}] -> ${to.patientId ? "patient" : "staff"} ${to.patientId ?? to.userId}`);
    return { messageId: `log-${Date.now()}` };
  }
}

@Injectable()
export class NotificationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("NotificationDispatcher");
  private provider: NotificationProvider = new LogProvider();
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  setProvider(p: NotificationProvider) {
    this.provider = p;
  }

  /** Queue in the caller's transaction; dispatch happens after commit. */
  async enqueue(tx: DbLike, n: NotifyInput): Promise<void> {
    const channels = n.channels ?? (n.patientId ? ["push", "sms"] : ["in_app", "push"]);
    const meta = TEMPLATES[n.template];
    for (const channel of channels) {
      if (n.patientId && !n.serviceCritical) {
        const pref = await tx.orm.ops.NotificationPreference.where({ patientId: n.patientId, category: meta.category, channel }).first();
        if (pref && !pref.enabled) continue;
      }
      await tx.orm.ops.Notification.create({
        recipientType: n.patientId ? "patient" : "staff",
        patientId: n.patientId ?? null,
        userId: n.userId ?? null,
        templateCode: n.template,
        channel,
        language: n.language ?? "bn",
        deepLink: n.deepLink ?? null,
        relatedType: n.relatedType ?? null,
        relatedId: n.relatedId ?? null,
        isServiceCritical: n.serviceCritical ?? false,
        status: channel === "in_app" ? "delivered" : "queued",
        queuedAt: nowIso(),
        deliveredAt: channel === "in_app" ? nowIso() : null,
      });
    }
  }

  render(code: string, language: string): string {
    const t = TEMPLATES[code as TemplateCode];
    if (!t) return "";
    return language === "en" ? t.en : t.bn;
  }

  onModuleInit() {
    if (process.env.NOTIFICATION_DISPATCH === "off") return;
    this.timer = setInterval(() => void this.dispatch(), Number(process.env.NOTIFICATION_INTERVAL_MS ?? 5000));
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async dispatch(batch = 50): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const rows = await db.orm.ops.Notification.where({ status: "queued" }).orderBy((n) => n.queuedAt.asc()).limit(batch).all();
      for (const n of rows) {
        try {
          const res = await this.provider.send(n.channel as Channel, { patientId: n.patientId, userId: n.userId }, this.render(n.templateCode, n.language), n.deepLink);
          await db.orm.ops.Notification.where({ id: n.id }).update({ status: "sent", sentAt: nowIso(), provider: this.provider.name, providerMessageId: res.messageId });
        } catch (err) {
          await db.orm.ops.Notification.where({ id: n.id }).update({ status: "failed", failureReason: (err as Error).message.slice(0, 200) });
        }
      }
      return rows.length;
    } catch (err) {
      this.logger.warn(`dispatch failed: ${(err as Error).message}`);
      return 0;
    } finally {
      this.running = false;
    }
  }
}
