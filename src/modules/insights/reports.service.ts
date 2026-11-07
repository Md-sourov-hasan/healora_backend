import { Injectable } from "@nestjs/common";

import { db, median, minutesBetween, nowIso } from "../../common/db.ts";
import { inChunks, pct } from "./insights-scope.ts";

export interface ReportWindow {
  hubIds: string[];
  from: string;
  to: string;
  fromInstant: string;
  toInstant: string;
  serviceTypeId?: string;
}

const ARRIVED = new Set(["arrived", "checked_in", "in_service", "completed", "unable_to_complete", "referred"]);
const LIVE_SESSION = ["published", "open_for_booking", "full", "in_progress", "paused", "completed"] as const;

export const REPORT_CODES = [
  "attendance",
  "utilisation",
  "durations",
  "completion",
  "sync",
  "coverage",
  "equipment",
  "escalations",
] as const;
export type ReportCode = (typeof REPORT_CODES)[number];

/**
 * Aggregated, de-identified operational reports (PRD §8.11, §19). Rows carry
 * hub/session/day keys and counts only — no patient identifiers or clinical
 * values. No per-staff throughput rankings are produced.
 */
@Injectable()
export class ReportsService {
  async run(code: ReportCode, w: ReportWindow): Promise<{ rows: Record<string, unknown>[]; summary: Record<string, unknown>; exclusions: string[] }> {
    switch (code) {
      case "attendance":
        return this.attendance(w);
      case "utilisation":
        return this.utilisation(w);
      case "durations":
        return this.durations(w);
      case "completion":
        return this.completion(w);
      case "sync":
        return this.sync(w);
      case "coverage":
        return this.coverage(w);
      case "equipment":
        return this.equipment(w);
      case "escalations":
        return this.escalations(w);
    }
  }

  async sessions(w: ReportWindow) {
    if (w.hubIds.length === 0) return [];
    const rows = await inChunks(w.hubIds, (chunk) => {
      let q = db.orm.hub.HubSession.select("id", "hubId", "serviceTypeId", "sessionDate", "title", "status", "appointmentCapacity", "walkInCapacity", "bookedCount", "walkInCount")
        .where((s) => s.hubId.in(chunk))
        .where((s) => s.sessionDate.gte(w.from))
        .where((s) => s.sessionDate.lte(w.to));
      if (w.serviceTypeId) q = q.where({ serviceTypeId: w.serviceTypeId });
      return q.all();
    });
    return rows;
  }

  private async hubCodes(hubIds: string[]) {
    const hubs = await inChunks(hubIds, (c) => db.orm.hub.Hub.select("id", "code", "name").where((h) => h.id.in(c)).all());
    return new Map(hubs.map((h) => [h.id, h]));
  }

  private async appointmentsFor(sessionIds: string[]) {
    return inChunks(sessionIds, (c) =>
      db.orm.hub.Appointment.select("id", "sessionId", "hubId", "status", "isWalkIn", "source").where((a) => a.sessionId.in(c)).all(),
    );
  }

  async attendance(w: ReportWindow) {
    const sessions = await this.sessions(w);
    const appts = await this.appointmentsFor(sessions.map((s) => s.id));
    const hubs = await this.hubCodes([...new Set(sessions.map((s) => s.hubId))]);
    const bySession = new Map<string, typeof appts>();
    for (const a of appts) bySession.set(a.sessionId, [...(bySession.get(a.sessionId) ?? []), a]);
    const rows = sessions.map((s) => {
      const list = bySession.get(s.id) ?? [];
      const booked = list.filter((a) => !a.isWalkIn);
      const confirmed = booked.filter((a) => a.status !== "pending_confirmation" && a.status !== "cancelled").length;
      const arrived = booked.filter((a) => ARRIVED.has(a.status)).length;
      const noShow = booked.filter((a) => a.status === "no_show").length;
      return {
        date: s.sessionDate,
        hubCode: hubs.get(s.hubId)?.code ?? null,
        sessionId: s.id,
        sessionTitle: s.title,
        sessionStatus: s.status,
        confirmedBookings: confirmed,
        arrived,
        noShow,
        cancelled: booked.filter((a) => a.status === "cancelled").length,
        walkIns: list.filter((a) => a.isWalkIn).length,
        attendanceRatePct: pct(arrived, confirmed),
        noShowRatePct: pct(noShow, confirmed),
      };
    });
    const totals = rows.reduce((t, r) => ({ confirmed: t.confirmed + r.confirmedBookings, arrived: t.arrived + r.arrived, noShow: t.noShow + r.noShow, walkIns: t.walkIns + r.walkIns }), { confirmed: 0, arrived: 0, noShow: 0, walkIns: 0 });
    return {
      rows,
      summary: { ...totals, attendanceRatePct: pct(totals.arrived, totals.confirmed), noShowRatePct: pct(totals.noShow, totals.confirmed) },
      exclusions: ["Walk-ins are excluded from attendance and no-show rates", "Draft sessions have no bookings"],
    };
  }

  async utilisation(w: ReportWindow) {
    const sessions = (await this.sessions(w)).filter((s) => s.status !== "draft" && s.status !== "cancelled");
    const appts = await this.appointmentsFor(sessions.map((s) => s.id));
    const hubs = await this.hubCodes([...new Set(sessions.map((s) => s.hubId))]);
    const completedBySession = new Map<string, number>();
    for (const a of appts) if (a.status === "completed") completedBySession.set(a.sessionId, (completedBySession.get(a.sessionId) ?? 0) + 1);
    const byHub = new Map<string, { capacity: number; walkInCapacity: number; booked: number; walkIns: number; completed: number; sessions: number }>();
    for (const s of sessions) {
      const h = byHub.get(s.hubId) ?? { capacity: 0, walkInCapacity: 0, booked: 0, walkIns: 0, completed: 0, sessions: 0 };
      h.capacity += s.appointmentCapacity;
      h.walkInCapacity += s.walkInCapacity;
      h.booked += s.bookedCount;
      h.walkIns += s.walkInCount;
      h.completed += completedBySession.get(s.id) ?? 0;
      h.sessions += 1;
      byHub.set(s.hubId, h);
    }
    const rows = [...byHub.entries()].map(([hubId, h]) => ({
      hubCode: hubs.get(hubId)?.code ?? null,
      hubName: hubs.get(hubId)?.name ?? null,
      sessions: h.sessions,
      appointmentCapacity: h.capacity,
      walkInCapacity: h.walkInCapacity,
      booked: h.booked,
      walkIns: h.walkIns,
      completedVisits: h.completed,
      bookingUtilisationPct: pct(h.booked, h.capacity),
      hubUtilisationPct: pct(h.completed, h.capacity + h.walkInCapacity),
    }));
    return { rows, summary: { hubs: rows.length, sessions: sessions.length }, exclusions: ["Draft and cancelled sessions are excluded"] };
  }

  private async ticketsFor(sessionIds: string[]) {
    return inChunks(sessionIds, (c) =>
      db.orm.hub.QueueTicket.select("hubId", "sessionId", "issuedAt", "serviceStartedAt", "completedAt", "status").where((t) => t.sessionId.in(c)).all(),
    );
  }

  async durations(w: ReportWindow) {
    const sessions = await this.sessions(w);
    const tickets = await this.ticketsFor(sessions.map((s) => s.id));
    const hubs = await this.hubCodes([...new Set(sessions.map((s) => s.hubId))]);
    const byHub = new Map<string, { wait: number[]; visit: number[]; service: number[] }>();
    for (const t of tickets) {
      const h = byHub.get(t.hubId) ?? { wait: [], visit: [], service: [] };
      const wait = minutesBetween(t.issuedAt, t.serviceStartedAt);
      const visit = minutesBetween(t.issuedAt, t.completedAt);
      const service = minutesBetween(t.serviceStartedAt, t.completedAt);
      if (wait !== null && wait >= 0) h.wait.push(wait);
      if (visit !== null && visit >= 0) h.visit.push(visit);
      if (service !== null && service >= 0) h.service.push(service);
      byHub.set(t.hubId, h);
    }
    const rows = [...byHub.entries()].map(([hubId, h]) => ({
      hubCode: hubs.get(hubId)?.code ?? null,
      servedVisits: h.wait.length,
      medianCheckInToFirstServiceMin: median(h.wait),
      medianCheckInToCompletionMin: median(h.visit),
      medianServiceMin: median(h.service),
    }));
    const all = [...byHub.values()];
    return {
      rows,
      summary: {
        estimate: true,
        medianCheckInToFirstServiceMin: median(all.flatMap((h) => h.wait)),
        medianCheckInToCompletionMin: median(all.flatMap((h) => h.visit)),
      },
      exclusions: ["Operational estimates from queue timestamps; not a staff quality measure", "Visits without the relevant timestamps are excluded"],
    };
  }

  async completion(w: ReportWindow) {
    const sessions = await this.sessions(w);
    const encs = await inChunks(sessions.map((s) => s.id), (c) =>
      db.orm.clinical.Encounter.select("id", "hubId", "status", "disposition").where((e) => e.sessionId.in(c)).all(),
    );
    const hubs = await this.hubCodes([...new Set(sessions.map((s) => s.hubId))]);
    const incompleteTasks = new Set(
      (
        await inChunks(encs.map((e) => e.id), (c) =>
          db.orm.clinical.EncounterTask.select("encounterId").where((t) => t.encounterId.in(c)).where({ required: true, status: "pending" }).all(),
        )
      ).map((t) => t.encounterId),
    );
    const byHub = new Map<string, Record<string, number>>();
    for (const e of encs) {
      const h = byHub.get(e.hubId ?? "none") ?? { total: 0, completed: 0, unableToComplete: 0, referred: 0, open: 0, withMissingRequiredData: 0 };
      h.total! += 1;
      if (e.status === "completed") h.completed! += 1;
      else if (e.status === "unable_to_complete") h.unableToComplete! += 1;
      else if (e.status === "referred") h.referred! += 1;
      else h.open! += 1;
      if (incompleteTasks.has(e.id)) h.withMissingRequiredData! += 1;
      byHub.set(e.hubId ?? "none", h);
    }
    const rows = [...byHub.entries()].map(([hubId, h]) => ({
      hubCode: hubs.get(hubId)?.code ?? null,
      ...h,
      completionRatePct: pct(h.completed!, h.total!),
      requiredDataCompletenessPct: pct(h.total! - h.withMissingRequiredData!, h.total!),
    }));
    return { rows, summary: { encounters: encs.length }, exclusions: ["Only encounters linked to sessions in the range"] };
  }

  async sync(w: ReportWindow) {
    const subs = w.hubIds.length
      ? await inChunks(w.hubIds, (c) =>
          db.orm.ops.SyncSubmission.select("hubId", "status", "errorCategory", "retryCount", "clientCreatedAt", "serverReceivedAt")
            .where((s) => s.hubId.in(c))
            .where((s) => s.serverReceivedAt.gte(w.fromInstant))
            .where((s) => s.serverReceivedAt.lte(w.toInstant))
            .all(),
        )
      : [];
    const devices = w.hubIds.length
      ? await inChunks(w.hubIds, (c) => db.orm.ops.DeviceInstallation.select("hubId", "pendingCount", "oldestPendingAt").where((d) => d.hubId.in(c)).where((d) => d.revokedAt.isNull()).all())
      : [];
    const hubs = await this.hubCodes(w.hubIds);
    const byHub = new Map<string, { submissions: number; accepted: number; duplicate: number; rejected: number; quarantined: number; resolved: number; retries: number; latencies: number[]; errors: Record<string, number> }>();
    for (const s of subs) {
      const h = byHub.get(s.hubId!) ?? { submissions: 0, accepted: 0, duplicate: 0, rejected: 0, quarantined: 0, resolved: 0, retries: 0, latencies: [], errors: {} };
      h.submissions += 1;
      h[s.status as "accepted"] = (h[s.status as "accepted"] ?? 0) + 1;
      h.retries += s.retryCount;
      const lat = minutesBetween(s.clientCreatedAt, s.serverReceivedAt);
      if (lat !== null && lat >= 0) h.latencies.push(lat);
      if (s.errorCategory) h.errors[s.errorCategory] = (h.errors[s.errorCategory] ?? 0) + 1;
      byHub.set(s.hubId!, h);
    }
    const pendingByHub = new Map<string, { pending: number; oldest: string | null }>();
    for (const d of devices) {
      const cur = pendingByHub.get(d.hubId!) ?? { pending: 0, oldest: null };
      cur.pending += d.pendingCount;
      if (d.oldestPendingAt && (!cur.oldest || d.oldestPendingAt < cur.oldest)) cur.oldest = d.oldestPendingAt;
      pendingByHub.set(d.hubId!, cur);
    }
    const rows = w.hubIds
      .filter((id) => byHub.has(id) || pendingByHub.has(id))
      .map((id) => {
        const h = byHub.get(id);
        const p = pendingByHub.get(id);
        return {
          hubCode: hubs.get(id)?.code ?? null,
          submissions: h?.submissions ?? 0,
          accepted: h?.accepted ?? 0,
          duplicates: h?.duplicate ?? 0,
          rejected: h?.rejected ?? 0,
          quarantined: h?.quarantined ?? 0,
          retries: h?.retries ?? 0,
          successRatePct: h ? pct(h.accepted + h.duplicate + h.resolved, h.submissions) : null,
          medianSyncLatencyMin: h ? median(h.latencies) : null,
          errorsByCategory: h?.errors ?? {},
          pendingOnDevicesNow: p?.pending ?? 0,
          oldestPendingAgeMin: p?.oldest ? minutesBetween(p.oldest, nowIso()) : null,
        };
      });
    return { rows, summary: { submissions: subs.length }, exclusions: ["Pending counts are the latest device heartbeat, not historical"] };
  }

  async coverage(w: ReportWindow) {
    const sessions = (await this.sessions(w)).filter((s) => (LIVE_SESSION as readonly string[]).includes(s.status));
    const hubs = await this.hubCodes([...new Set(sessions.map((s) => s.hubId))]);
    const stIds = [...new Set(sessions.map((s) => s.serviceTypeId))];
    const reqs = stIds.length
      ? await db.orm.hub.ServiceTypeRequirement.select("serviceTypeId", "staffRole", "minCount").where((r) => r.serviceTypeId.in(stIds)).where({ kind: "staff_role", mandatory: true }).all()
      : [];
    const shifts = await inChunks(sessions.map((s) => s.id), (c) =>
      db.orm.hub.StaffShift.select("sessionId", "role", "status", "checkedInAt").where((x) => x.sessionId.in(c)).where((x) => x.status.in(["approved", "checked_in", "checked_out"])).all(),
    );
    const rows = sessions.map((s) => {
      const mine = shifts.filter((x) => x.sessionId === s.id);
      const needed = reqs.filter((r) => r.serviceTypeId === s.serviceTypeId);
      const gaps = needed
        .map((r) => ({ role: r.staffRole, required: r.minCount, rostered: mine.filter((x) => x.role === r.staffRole).length }))
        .filter((g) => g.rostered < g.required);
      return {
        date: s.sessionDate,
        hubCode: hubs.get(s.hubId)?.code ?? null,
        sessionId: s.id,
        sessionTitle: s.title,
        rosteredStaff: mine.length,
        checkedInStaff: mine.filter((x) => x.checkedInAt).length,
        meetsRequiredRoster: gaps.length === 0,
        gaps,
      };
    });
    const meeting = rows.filter((r) => r.meetsRequiredRoster).length;
    return { rows, summary: { sessions: rows.length, meetingRequiredRoster: meeting, coveragePct: pct(meeting, rows.length) }, exclusions: ["Draft and cancelled sessions are excluded"] };
  }

  async equipment(w: ReportWindow) {
    const items = w.hubIds.length
      ? await inChunks(w.hubIds, (c) => db.orm.hub.Equipment.select("id", "hubId", "category", "status", "nextCalibrationDue").where((e) => e.hubId.in(c)).where((e) => e.status.neq("retired")).all())
      : [];
    const events = await inChunks(items.map((i) => i.id), (c) =>
      db.orm.hub.EquipmentEvent.select("equipmentId", "kind")
        .where((e) => e.equipmentId.in(c))
        .where((e) => e.occurredAt.gte(w.fromInstant))
        .where((e) => e.occurredAt.lte(w.toInstant))
        .all(),
    );
    const hubs = await this.hubCodes(w.hubIds);
    const today = w.to;
    const hubOf = new Map(items.map((i) => [i.id, i.hubId]));
    const byHub = new Map<string, Record<string, number>>();
    const bump = (hubId: string, k: string) => {
      const h = byHub.get(hubId) ?? { total: 0, available: 0, unavailable: 0, calibrationOverdue: 0, faultsReported: 0, faultsResolved: 0, maintenanceEvents: 0, calibrations: 0 };
      h[k] = (h[k] ?? 0) + 1;
      byHub.set(hubId, h);
    };
    for (const i of items) {
      bump(i.hubId, "total");
      bump(i.hubId, i.status === "available" || i.status === "assigned" ? "available" : "unavailable");
      if (i.nextCalibrationDue && i.nextCalibrationDue < today) bump(i.hubId, "calibrationOverdue");
    }
    for (const e of events) {
      const hubId = hubOf.get(e.equipmentId);
      if (!hubId) continue;
      if (e.kind === "fault_reported") bump(hubId, "faultsReported");
      if (e.kind === "fault_resolved") bump(hubId, "faultsResolved");
      if (e.kind === "maintenance") bump(hubId, "maintenanceEvents");
      if (e.kind === "calibration") bump(hubId, "calibrations");
    }
    const rows = [...byHub.entries()].map(([hubId, h]) => ({ hubCode: hubs.get(hubId)?.code ?? null, ...h, availabilityPct: pct(h.available ?? 0, h.total ?? 0) }));
    return { rows, summary: { items: items.length }, exclusions: ["Retired equipment is excluded", "Status is current; events are within the range"] };
  }

  async escalations(w: ReportWindow) {
    const rows0 = w.hubIds.length
      ? await inChunks(w.hubIds, (c) =>
          db.orm.clinical.EncounterEscalation.select("type", "encounterId")
            .where((e) => e.raisedAt.gte(w.fromInstant))
            .where((e) => e.raisedAt.lte(w.toInstant))
            .where((e) => e.encounter.some((x) => x.hubId.in(c)))
            .include("encounter", (x) => x.select("hubId"))
            .all(),
        )
      : [];
    const hubs = await this.hubCodes(w.hubIds);
    const byHub = new Map<string, Record<string, number>>();
    for (const e of rows0) {
      const hubId = e.encounter?.hubId ?? "none";
      const h = byHub.get(hubId) ?? { emergency: 0, urgent_clinical: 0, referral: 0, operational: 0 };
      h[e.type] = (h[e.type] ?? 0) + 1;
      byHub.set(hubId, h);
    }
    const sessions = await this.sessions(w);
    const referredAppts = (await this.appointmentsFor(sessions.map((s) => s.id))).filter((a) => a.status === "referred");
    const refByHub = new Map<string, number>();
    for (const a of referredAppts) refByHub.set(a.hubId, (refByHub.get(a.hubId) ?? 0) + 1);
    const ids = new Set([...byHub.keys(), ...refByHub.keys()]);
    const rows = [...ids].map((hubId) => ({ hubCode: hubs.get(hubId)?.code ?? null, ...(byHub.get(hubId) ?? { emergency: 0, urgent_clinical: 0, referral: 0, operational: 0 }), referredVisits: refByHub.get(hubId) ?? 0 }));
    return { rows, summary: { escalations: rows0.length, referredVisits: referredAppts.length }, exclusions: ["Operational counts only; no clinical detail"] };
  }
}
