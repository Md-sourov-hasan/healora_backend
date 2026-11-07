/**
 * Concurrency test (PRD §20.2: "two concurrent booking requests for the last
 * available slot cannot both succeed"). Needs a real PostgreSQL.
 *
 *   npx tsx --env-file=.env scripts/test-booking-race.ts
 *
 * Creates an isolated hub + one-place session, fires N bookings at once through
 * the real BookingService and checks exactly one wins and the counter is exact.
 */
import "reflect-metadata";
import "temporal-polyfill/global";

import { NestFactory } from "@nestjs/core";

for (const k of ["OUTBOX_RELAY", "NOTIFICATION_DISPATCH", "EXCEPTION_SCAN", "REMINDERS"]) process.env[k] = "off";

const { AppModule } = await import("../src/app.module.ts");
const { BookingService } = await import("../src/modules/appointments/booking.service.ts");
const { db } = await import("../src/prisma/db.ts");

const N = Number(process.env.RACE_N ?? 8);
const tag = `RACE${Date.now().toString(36).toUpperCase()}`;
const ctx = await NestFactory.createApplicationContext(AppModule, { logger: ["error"] });
const booking = ctx.get(BookingService);

const admin = (await db.orm.identity.RoleAssignment.where({ role: "platform_super_admin", status: "active" }).first())!;
const region = await db.orm.hub.Region.create({ code: tag, name: `Race ${tag}`, level: "division" });
const hub = await db.orm.hub.Hub.create({ code: tag, name: `Race hub ${tag}`, status: "active", regionId: region.id, addressLine: "test", languages: ["bn"], createdById: admin.userId });
const st = await db.orm.hub.ServiceType.create({ code: tag, name: "Race service" });
await db.orm.hub.HubServiceOffering.create({ hubId: hub.id, serviceTypeId: st.id, status: "approved", approvedById: admin.userId, approvedAt: new Date().toISOString() });
const start = new Date(Date.now() + 2 * 3600_000);
const session = await db.orm.hub.HubSession.create({
  hubId: hub.id,
  serviceTypeId: st.id,
  title: "Race session",
  status: "open_for_booking",
  sessionDate: new Date(start.getTime() + 6 * 3600_000).toISOString().slice(0, 10),
  startsAt: start.toISOString(),
  endsAt: new Date(start.getTime() + 3600_000).toISOString(),
  appointmentCapacity: 1,
  slotMinutes: 15,
  createdById: admin.userId,
});
const patients: { id: string }[] = [];
for (let i = 0; i < N; i++) {
  patients.push(await db.orm.clinical.Patient.create({ healoraCode: `${tag}${i}`.slice(0, 20), fullName: `Race Patient ${i}`, regionId: region.id }));
}

const actor = { kind: "staff", userId: admin.userId, name: "race", assignments: [], ip: null, userAgent: null, correlationId: tag, authSessionId: null, deviceInstallationId: null, strongAuth: true } as never;
const results = await Promise.allSettled(
  patients.map((p) => booking.book(actor, { patientId: p.id, sessionId: session.id, source: "operations_assignment", hubAssignmentBasis: "operations_assignment" })),
);

const won = results.filter((r) => r.status === "fulfilled").length;
const reasons = results.filter((r): r is PromiseRejectedResult => r.status === "rejected").map((r) => (r.reason?.response?.code ?? r.reason?.code ?? r.reason?.message ?? "?") as string);
const after = (await db.orm.hub.HubSession.first({ id: session.id }))!;
const active = await db.orm.hub.Appointment.where({ sessionId: session.id }).where((a) => a.status.in(["pending_confirmation", "confirmed"])).all();

console.log(`${N} concurrent bookings for 1 place → ${won} succeeded; rejections: ${JSON.stringify(reasons.reduce<Record<string, number>>((m, c) => ({ ...m, [c]: (m[c] ?? 0) + 1 }), {}))}`);
console.log(`session.bookedCount=${after.bookedCount} status=${after.status}; active appointments in DB=${active.length}`);
const raceOk = won === 1 && after.bookedCount === 1 && active.length === 1 && after.status === "full";
console.log(raceOk ? "PASS: exactly one booking won, counter exact, session marked full" : "FAIL: race");

// Booking-window regression: timestamps come back from Postgres as "2026-11-10 03:00:00+00".
const windowCase = async (opensAt: string | null, closesAt: string | null) => {
  const s = await db.orm.hub.HubSession.create({
    hubId: hub.id, serviceTypeId: st.id, title: "Window", status: "open_for_booking",
    sessionDate: session.sessionDate, startsAt: session.startsAt, endsAt: session.endsAt,
    appointmentCapacity: 5, slotMinutes: 15, createdById: admin.userId, bookingOpensAt: opensAt, bookingClosesAt: closesAt,
  });
  try {
    await booking.book(actor, { patientId: patients[1]!.id, sessionId: s.id, source: "operations_assignment", hubAssignmentBasis: "operations_assignment" });
    return "booked";
  } catch (e) {
    return ((e as { response?: { code?: string } }).response?.code ?? "error") as string;
  }
};
const notOpen = await windowCase(new Date(Date.now() + 3600_000).toISOString(), null);
const closed = await windowCase(null, new Date(Date.now() - 60_000).toISOString());
const openNow = await windowCase(new Date(Date.now() - 60_000).toISOString(), new Date(Date.now() + 3600_000).toISOString());
const windowOk = notOpen === "BOOKING_NOT_OPEN" && closed === "BOOKING_CLOSED" && openNow === "booked";
console.log(`${windowOk ? "PASS" : "FAIL"}: booking window — not yet open → ${notOpen}, closed → ${closed}, open → ${openNow}`);
const ok = raceOk && windowOk;

await ctx.close();
await db.close();
process.exit(ok ? 0 : 1);
