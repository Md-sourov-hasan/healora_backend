/**
 * Authorisation sweep: enumerates EVERY registered route and calls it as
 *   1. anonymous                      → must be 401 unless @Public()
 *   2. an active staff user, no roles  → must never succeed (2xx) except self-service routes
 *   3. a patient                       → must never succeed outside /patient, /me, /auth
 *   4. a platform admin on /patient/*  → must be 403 (staff cannot use patient routes)
 *
 *   DATABASE_URL=... JWT_SECRET=... npx tsx scripts/authz-sweep.ts
 *
 * Exit code 1 if any route violates the policy.
 */
import "reflect-metadata";
import "temporal-polyfill/global";

import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants.js";
import { ModulesContainer, NestFactory } from "@nestjs/core";

import { AppModule } from "../src/app.module.ts";
import { signJwt } from "../src/common/auth/jwt.ts";
import { IS_PUBLIC } from "../src/common/auth/decorators.ts";
import { db } from "../src/prisma/db.ts";

process.env.OUTBOX_RELAY = "off";
process.env.NOTIFICATION_DISPATCH = "off";
process.env.EXCEPTION_SCAN = "off";
process.env.REMINDERS = "off";
process.env.AUTH_DEV_TOKENS = "true";

const METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "ALL", "OPTIONS", "HEAD"];
/** Routes any authenticated principal may legitimately use on itself. */
const SELF_SERVICE = [/^\/api\/v1\/me$/, /^\/api\/v1\/auth\//, /^\/api\/v1\/dev\//, /^\/health$/];
/** Staff self-service that may succeed with zero roles (own shifts, own notifications, own sessions). */
const STAFF_SELF = [/^\/api\/v1\/shifts\/mine$/, /^\/api\/v1\/notifications/, /^\/api\/v1\/admin\/break-glass\/mine$/];

const app = await NestFactory.create(AppModule, { logger: ["error"] });
app.setGlobalPrefix("api/v1", { exclude: ["health"] });
await app.listen(0);
const base = (await app.getUrl()).replace("[::1]", "localhost");

// ---- enumerate routes --------------------------------------------------------
type Route = { method: string; path: string; isPublic: boolean };
const routes: Route[] = [];
for (const mod of app.get(ModulesContainer).values()) {
  for (const wrapper of mod.controllers.values()) {
    const ctrl = wrapper.metatype as (new (...a: unknown[]) => unknown) | undefined;
    if (!ctrl) continue;
    const prefix = (Reflect.getMetadata(PATH_METADATA, ctrl) as string | undefined) ?? "";
    const classPublic = Reflect.getMetadata(IS_PUBLIC, ctrl) === true;
    for (const name of Object.getOwnPropertyNames(ctrl.prototype)) {
      const handler = ctrl.prototype[name];
      if (name === "constructor" || typeof handler !== "function") continue;
      const path = Reflect.getMetadata(PATH_METADATA, handler) as string | string[] | undefined;
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
      if (path === undefined || method === undefined) continue;
      for (const p of Array.isArray(path) ? path : [path]) {
        const full = `/${[prefix, p].map((s) => s.replace(/^\/|\/$/g, "")).filter(Boolean).join("/")}`;
        const withPrefix = full === "/health" ? full : `/api/v1${full}`;
        routes.push({ method: METHODS[method] ?? "GET", path: withPrefix, isPublic: classPublic || Reflect.getMetadata(IS_PUBLIC, handler) === true });
      }
    }
  }
}

// ---- principals ----------------------------------------------------------------
const stamp = Date.now();
const noRole = await db.orm.identity.User.create({ email: `sweep-norole-${stamp}@test.local`, name: "Sweep NoRole", status: "active" });
const admin = await db.orm.identity.RoleAssignment.where({ role: "platform_super_admin", status: "active" }).first();
if (!admin) throw new Error("Run scripts/bootstrap.ts first");
const region = (await db.orm.hub.Region.first()) ?? (await db.orm.hub.Region.create({ code: `SWEEP-${stamp}`, name: "Sweep", level: "division" }));
const patient = await db.orm.clinical.Patient.create({ healoraCode: `SW${stamp}`.slice(0, 12), fullName: "Sweep Patient", regionId: region.id });

const tokens = {
  anon: null as string | null,
  noRole: signJwt({ sub: noRole.id, typ: "staff", amr: ["pwd", "otp"] }, 600),
  patient: signJwt({ sub: patient.id, typ: "patient", amr: ["otp"] }, 600),
  admin: signJwt({ sub: admin.userId, typ: "staff", amr: ["pwd", "otp"] }, 600),
};

const fakeId = "01a1b000-0000-7000-8000-000000000000";
const concrete = (path: string) => path.replace(/:[A-Za-z]+/g, (m) => (m === ":code" ? "bp_systolic" : fakeId));

async function call(r: Route, token: string | null): Promise<number> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(`${base}${concrete(r.path)}?hubId=${fakeId}&sessionId=${fakeId}&from=2026-01-01&to=2026-01-31`, {
      method: r.method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: ["GET", "HEAD", "DELETE"].includes(r.method) ? undefined : "{}",
      signal: ctrl.signal,
    });
    await res.body?.cancel();
    return res.status;
  } catch {
    return -1; // SSE streams stay open: an abort means it connected
  } finally {
    clearTimeout(timer);
  }
}

const ok = (s: number) => s >= 200 && s < 300;
const violations: string[] = [];
const isSelf = (p: string) => SELF_SERVICE.some((re) => re.test(p));

for (const r of routes) {
  const label = `${r.method.padEnd(6)} ${r.path}`;
  const anon = await call(r, tokens.anon);
  if (!r.isPublic && anon !== 401) violations.push(`${label}  anonymous → ${anon} (expected 401)`);

  if (!r.isPublic && !isSelf(r.path)) {
    const nr = await call(r, tokens.noRole);
    const staffSelf = STAFF_SELF.some((re) => re.test(r.path)) || r.path.startsWith("/api/v1/team/");
    if ((ok(nr) || nr === -1) && !staffSelf) violations.push(`${label}  staff-without-roles → ${nr} (expected 401/403/404/400)`);
    if (r.path.startsWith("/api/v1/team/") && ok(nr) && r.method !== "GET") violations.push(`${label}  staff-without-roles → ${nr} on a team write`);

    if (!r.path.startsWith("/api/v1/patient/")) {
      const pt = await call(r, tokens.patient);
      if (ok(pt) || pt === -1) violations.push(`${label}  patient → ${pt} (expected 403)`);
    } else {
      const ad = await call(r, tokens.admin);
      if (ad !== 403) violations.push(`${label}  admin-on-patient-route → ${ad} (expected 403)`);
    }
  }
}

console.log(`routes checked: ${routes.length} (public: ${routes.filter((r) => r.isPublic).map((r) => r.path).join(", ")})`);
if (violations.length) {
  console.log(`\nVIOLATIONS (${violations.length}):\n${violations.join("\n")}`);
} else {
  console.log("no authorisation violations");
}
await app.close();
await db.close();
process.exit(violations.length ? 1 : 0);
