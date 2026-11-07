import { Injectable } from "@nestjs/common";

import { db, dhakaDate, minutesBetween, nowIso } from "../../common/db.ts";
import { OPEN_ENCOUNTER_STATUSES } from "../../common/workflow.ts";
import { inChunks } from "./insights-scope.ts";

const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
const card = <T extends Record<string, unknown>>(data: T) => ({ ...data, source: "live" as const });

/**
 * "What is happening today, what is blocked, what needs attention" (PRD §8.2).
 * Aggregate counts only — no patient names, diagnoses or measurements.
 */
@Injectable()
export class DashboardService {
  async overview(hubIds: string[], date: string = dhakaDate(), serviceTypeId?: string) {
    const dayStart = `${date}T00:00:00+06:00`;
    const dayEnd = `${date}T23:59:59.999+06:00`;
    const now = nowIso();

    const activeHubs = hubIds.length
      ? (await inChunks(hubIds, (c) => db.orm.hub.Hub.select("id").where((h) => h.id.in(c)).where({ status: "active" }).all())).length
      : 0;

    const sessions = hubIds.length
      ? await inChunks(hubIds, (c) => {
          let q = db.orm.hub.HubSession.select("id", "hubId", "status")
            .where((s) => s.hubId.in(c))
            .where({ sessionDate: date })
            .where((s) => s.status.in(["published", "open_for_booking", "full", "in_progress", "paused", "completed"]));
          if (serviceTypeId) q = q.where({ serviceTypeId });
          return q.all();
        })
      : [];
    const sessionIds = sessions.map((s) => s.id);

    const appts = await inChunks(sessionIds, (c) => db.orm.hub.Appointment.select("status").where((a) => a.sessionId.in(c)).all());
    const apptCount = (...st: string[]) => appts.filter((a) => st.includes(a.status)).length;

    const bookedToday = hubIds.length
      ? (
          await inChunks(hubIds, (c) =>
            db.orm.hub.Appointment.where((a) => a.hubId.in(c))
              .where((a) => a.createdAt.gte(dayStart))
              .where((a) => a.createdAt.lte(dayEnd))
              .aggregate((a) => ({ n: a.count() }))
              .then((r) => [r]),
          )
        ).reduce((s, r) => s + r.n, 0)
      : 0;

    const tickets = await inChunks(sessionIds, (c) =>
      db.orm.hub.QueueTicket.select("status", "issuedAt", "serviceStartedAt", "completedAt").where((t) => t.sessionId.in(c)).all(),
    );
    const tCount = (...st: string[]) => tickets.filter((t) => st.includes(t.status)).length;
    const waits = tickets.map((t) => minutesBetween(t.issuedAt, t.serviceStartedAt)).filter((x): x is number => x !== null && x >= 0);
    const services = tickets.map((t) => minutesBetween(t.serviceStartedAt, t.completedAt)).filter((x): x is number => x !== null && x >= 0);

    const shifts = hubIds.length
      ? await inChunks(hubIds, (c) =>
          db.orm.hub.StaffShift.select("checkedInAt")
            .where((x) => x.hubId.in(c))
            .where((x) => x.startsAt.lte(dayEnd))
            .where((x) => x.endsAt.gte(dayStart))
            .where((x) => x.status.in(["approved", "checked_in", "checked_out"]))
            .all(),
        )
      : [];

    const openEncounters = hubIds.length
      ? await inChunks(hubIds, (c) =>
          db.orm.clinical.Encounter.select("id", "status").where((e) => e.hubId.in(c)).where((e) => e.status.in([...OPEN_ENCOUNTER_STATUSES])).all(),
        )
      : [];
    const incompleteEnc = new Set(
      (
        await inChunks(openEncounters.map((e) => e.id), (c) =>
          db.orm.clinical.EncounterTask.select("encounterId").where((t) => t.encounterId.in(c)).where({ required: true, status: "pending" }).all(),
        )
      ).map((t) => t.encounterId),
    );

    const failedSync = hubIds.length
      ? await inChunks(hubIds, (c) =>
          db.orm.ops.SyncSubmission.select("id").where((s) => s.hubId.in(c)).where((s) => s.status.in(["rejected", "quarantined"])).where((s) => s.resolvedAt.isNull()).all(),
        )
      : [];
    const devices = hubIds.length
      ? await inChunks(hubIds, (c) =>
          db.orm.ops.DeviceInstallation.select("pendingCount", "oldestPendingAt").where((d) => d.hubId.in(c)).where((d) => d.revokedAt.isNull()).where((d) => d.pendingCount.gt(0)).all(),
        )
      : [];
    const oldestPending = devices.map((d) => d.oldestPendingAt).filter((x): x is string => !!x).sort()[0] ?? null;

    const equipment = hubIds.length
      ? await inChunks(hubIds, (c) => db.orm.hub.Equipment.select("status", "nextCalibrationDue").where((e) => e.hubId.in(c)).where((e) => e.status.neq("retired")).all())
      : [];

    const exceptions = hubIds.length
      ? await inChunks(hubIds, (c) =>
          db.orm.hub.OperationalException.select("type", "severity").where((x) => x.hubId.in(c)).where((x) => x.status.in(["open", "acknowledged", "escalated"])).all(),
        )
      : [];
    const byType: Record<string, number> = {};
    for (const x of exceptions) byType[x.type] = (byType[x.type] ?? 0) + 1;

    return {
      date,
      generatedAt: now,
      hubsInScope: hubIds.length,
      cards: {
        activeHubs: card({ count: activeHubs }),
        operatingToday: card({ hubs: new Set(sessions.map((s) => s.hubId)).size, sessions: sessions.length, inProgress: sessions.filter((s) => s.status === "in_progress").length }),
        appointmentsBookedToday: card({ count: bookedToday }),
        visits: card({
          expected: apptCount("pending_confirmation", "confirmed"),
          arrived: apptCount("arrived"),
          checkedIn: apptCount("checked_in", "in_service", "completed", "unable_to_complete", "referred"),
          waiting: tCount("waiting", "called", "transferred", "paused"),
          inService: tCount("in_service"),
          awaitingReview: tCount("awaiting_review"),
          completed: apptCount("completed"),
          cancelled: apptCount("cancelled"),
          noShow: apptCount("no_show"),
        }),
        timings: card({ estimate: true, avgWaitingMinutes: avg(waits), avgServiceMinutes: avg(services), basis: "queue ticket timestamps" }),
        staffing: card({ scheduled: shifts.length, checkedIn: shifts.filter((s) => s.checkedInAt).length }),
        unassignedEncounters: card({ count: openEncounters.filter((e) => e.status === "created").length }),
        incompleteRequiredMeasurements: card({ count: incompleteEnc.size }),
        sync: card({
          failedUnresolved: failedSync.length,
          devicesWithPending: devices.length,
          pendingItems: devices.reduce((s, d) => s + d.pendingCount, 0),
          oldestPendingAgeMinutes: oldestPending ? minutesBetween(oldestPending, now) : null,
        }),
        equipment: card({
          unavailable: equipment.filter((e) => ["maintenance", "out_of_service", "calibration_due"].includes(e.status)).length,
          calibrationOverdue: equipment.filter((e) => e.nextCalibrationDue && e.nextCalibrationDue < date).length,
        }),
        alerts: card({
          openCriticalOrHigh: exceptions.filter((x) => x.severity === "critical" || x.severity === "high").length,
          open: exceptions.length,
          byType,
        }),
      },
    };
  }
}
