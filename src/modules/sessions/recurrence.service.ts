import { Inject, Injectable } from "@nestjs/common";
import { and } from "@prisma/orm-postgres/orm-client";

import { AccessService } from "../../common/access.service.ts";
import { AuditService } from "../../common/audit.service.ts";
import type { StaffPrincipal } from "../../common/auth/principal.ts";
import { db, dhakaDate, toDate } from "../../common/db.ts";
import { badRequest, conflict, found } from "../../common/errors.ts";
import { HUB_MANAGEMENT, OPS_READ } from "../../common/roles.ts";
import type { CreateRecurrenceInput } from "./sessions.schemas.ts";

const DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;
const MAX_HORIZON_DAYS = 120;

export interface ParsedRule {
  freq: "DAILY" | "WEEKLY";
  interval: number;
  byDay: number[]; // 0 = Sunday
}

/** Supports FREQ=DAILY|WEEKLY, INTERVAL=n, BYDAY=SU,MO,... (RFC 5545 subset). */
export function parseRrule(rrule: string): ParsedRule {
  const parts = Object.fromEntries(
    rrule
      .replace(/^RRULE:/i, "")
      .split(";")
      .filter(Boolean)
      .map((kv) => {
        const [k, v] = kv.split("=");
        return [(k ?? "").toUpperCase(), (v ?? "").toUpperCase()];
      }),
  );
  const freq = parts.FREQ;
  if (freq !== "DAILY" && freq !== "WEEKLY") throw badRequest("INVALID_RRULE", "Only FREQ=DAILY or FREQ=WEEKLY is supported");
  const interval = parts.INTERVAL ? Number(parts.INTERVAL) : 1;
  if (!Number.isInteger(interval) || interval < 1 || interval > 52) throw badRequest("INVALID_RRULE", "INTERVAL must be 1-52");
  let byDay: number[] = [];
  if (parts.BYDAY) {
    byDay = parts.BYDAY.split(",").map((d: string) => {
      const i = DAYS.indexOf(d as (typeof DAYS)[number]);
      if (i < 0) throw badRequest("INVALID_RRULE", `Unknown BYDAY value ${d}`);
      return i;
    });
  }
  if (freq === "WEEKLY" && byDay.length === 0) throw badRequest("INVALID_RRULE", "FREQ=WEEKLY requires BYDAY");
  const unknown = Object.keys(parts).filter((k) => !["FREQ", "INTERVAL", "BYDAY"].includes(k));
  if (unknown.length) throw badRequest("INVALID_RRULE", `Unsupported RRULE parts: ${unknown.join(",")}`);
  return { freq, interval, byDay };
}

const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const normTime = (t: string) => (t.length === 5 ? `${t}:00` : t.slice(0, 8));
/** Local Bangladesh wall time → UTC ISO instant (UTC+6, no DST). */
const dhakaInstant = (date: string, time: string) => new Date(`${date}T${normTime(time)}+06:00`).toISOString();

/** Dates matching `rule` between `from` and `until` (inclusive), anchored at `anchor`. */
export function occurrences(rule: ParsedRule, anchor: string, from: string, until: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= until; d = addDays(d, 1)) {
    const diff = dayDiff(anchor, d);
    if (diff < 0) continue;
    const weekday = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (rule.freq === "DAILY") {
      if (diff % rule.interval === 0 && (rule.byDay.length === 0 || rule.byDay.includes(weekday))) out.push(d);
    } else {
      const week = Math.floor(diff / 7);
      if (week % rule.interval === 0 && rule.byDay.includes(weekday)) out.push(d);
    }
  }
  return out;
}

@Injectable()
export class RecurrenceService {
  constructor(
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async create(p: StaffPrincipal, input: CreateRecurrenceInput) {
    const hub = found(await db.orm.hub.Hub.first({ id: input.hubId }), "Hub");
    await this.access.require(p, HUB_MANAGEMENT, { hubId: hub.id }, "recurrence.create");
    if (hub.status === "permanently_closed") throw conflict("HUB_CLOSED", "Hub is permanently closed");
    const offering = await db.orm.hub.HubServiceOffering.where({ hubId: hub.id, serviceTypeId: input.serviceTypeId, status: "approved" }).first();
    if (!offering) throw conflict("SERVICE_NOT_APPROVED", "This service is not an approved offering for the hub");
    parseRrule(input.rrule);
    if (normTime(input.endTime) <= normTime(input.startTime)) throw badRequest("INVALID_WINDOW", "endTime must be after startTime");
    if (input.endsOn && input.endsOn < input.startsOn) throw badRequest("INVALID_WINDOW", "endsOn must not be before startsOn");

    return db.transaction(async (tx) => {
      const rec = await tx.orm.hub.SessionRecurrence.create({ ...input, endsOn: input.endsOn ?? null, createdById: p.userId });
      await this.audit.record(p, { action: "recurrence.create", targetType: "session_recurrence", targetId: rec.id, hubId: hub.id, metadata: { rrule: input.rrule } }, tx);
      return rec;
    });
  }

  async list(p: StaffPrincipal, hubId?: string) {
    const scope = await this.access.hubScope(p, OPS_READ);
    if (hubId) this.access.assertInScope(scope, hubId);
    if (scope !== "all" && scope.length === 0) return [];
    return db.orm.hub.SessionRecurrence.where((r) => {
      const c = [];
      if (scope !== "all") c.push(r.hubId.in(scope));
      if (hubId) c.push(r.hubId.eq(hubId));
      return c.length ? and(...c) : r.id.isNotNull();
    })
      .orderBy((r) => r.createdAt.desc())
      .limit(500)
      .all();
  }

  async deactivate(p: StaffPrincipal, id: string, reason: string) {
    const rec = found(await db.orm.hub.SessionRecurrence.first({ id }), "Recurrence");
    await this.access.require(p, HUB_MANAGEMENT, { hubId: rec.hubId }, "recurrence.deactivate");
    return db.transaction(async (tx) => {
      const updated = await tx.orm.hub.SessionRecurrence.where({ id }).update({ status: "inactive" });
      await this.audit.record(p, { action: "recurrence.deactivate", targetType: "session_recurrence", targetId: id, hubId: rec.hubId, reason }, tx);
      return updated;
    });
  }

  /** Creates draft sessions for each occurrence up to `until` (max 120 days ahead). */
  async materialize(p: StaffPrincipal, id: string, until: string) {
    const rec = found(await db.orm.hub.SessionRecurrence.first({ id }), "Recurrence");
    await this.access.require(p, HUB_MANAGEMENT, { hubId: rec.hubId }, "recurrence.materialize");
    if (rec.status !== "active") throw conflict("RECURRENCE_INACTIVE", "Recurrence is inactive");
    const hub = found(await db.orm.hub.Hub.first({ id: rec.hubId }), "Hub");
    if (hub.status === "permanently_closed") throw conflict("HUB_CLOSED", "Hub is permanently closed");
    const serviceType = found(await db.orm.hub.ServiceType.first({ id: rec.serviceTypeId }), "Service type");
    const rule = parseRrule(rec.rrule);

    const today = dhakaDate();
    if (dayDiff(today, until) > MAX_HORIZON_DAYS) throw badRequest("HORIZON_TOO_FAR", `Materialise at most ${MAX_HORIZON_DAYS} days ahead`);
    const from = rec.startsOn > today ? rec.startsOn : today;
    const end = rec.endsOn && rec.endsOn < until ? rec.endsOn : until;
    const dates = occurrences(rule, rec.startsOn, from, end);

    const existing = await db.orm.hub.HubSession.select("sessionDate").where({ recurrenceId: id }).all();
    const have = new Set(existing.map((e) => e.sessionDate));
    const blocks = await db.orm.hub.HubAvailabilityBlock.where({ hubId: rec.hubId })
      .where((b) => b.liftedAt.isNull())
      .where((b) => b.blockType.in(["closure", "pause"]))
      .all();

    const created: string[] = [];
    const skipped: { date: string; reason: string }[] = [];
    await db.transaction(async (tx) => {
      for (const date of dates) {
        if (have.has(date)) {
          skipped.push({ date, reason: "exists" });
          continue;
        }
        const startsAt = dhakaInstant(date, rec.startTime);
        const endsAt = dhakaInstant(date, rec.endTime);
        const s0 = Date.parse(startsAt);
        const e0 = Date.parse(endsAt);
        const blocked = blocks.some((b) => toDate(b.startsAt)!.getTime() < e0 && (b.endsAt === null || toDate(b.endsAt)!.getTime() > s0));
        if (blocked) {
          skipped.push({ date, reason: "hub_closed" });
          continue;
        }
        const s = await tx.orm.hub.HubSession.create({
          hubId: rec.hubId,
          serviceTypeId: rec.serviceTypeId,
          protocolId: serviceType.protocolId,
          recurrenceId: id,
          title: rec.title,
          sessionType: rec.sessionType,
          sessionDate: date,
          startsAt,
          endsAt,
          appointmentCapacity: rec.appointmentCapacity,
          walkInCapacity: rec.walkInCapacity,
          slotMinutes: rec.slotMinutes,
          createdById: p.userId,
        });
        created.push(s.id);
      }
      await this.audit.record(p, { action: "recurrence.materialize", targetType: "session_recurrence", targetId: id, hubId: rec.hubId, metadata: { created: created.length, skipped: skipped.length, until } }, tx);
    });
    return { created: created.length, sessionIds: created, skipped };
  }
}
