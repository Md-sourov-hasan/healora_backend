/**
 * Prints every registered route as a Markdown reference grouped by area.
 *   npx tsx scripts/routes.ts > docs/ROUTES.md
 * Booting needs no database queries (background jobs are switched off).
 */
import "reflect-metadata";
import "temporal-polyfill/global";

import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants.js";
import { ModulesContainer, NestFactory } from "@nestjs/core";

for (const k of ["OUTBOX_RELAY", "NOTIFICATION_DISPATCH", "EXCEPTION_SCAN", "REMINDERS"]) process.env[k] = "off";

const { AppModule } = await import("../src/app.module.ts");
const { IS_PUBLIC } = await import("../src/common/auth/decorators.ts");
const { AREA_ORDER, areaOf } = await import("./route-areas.ts");

const METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "ALL", "OPTIONS", "HEAD"];
const app = await NestFactory.create(AppModule, { logger: false });
await app.init();



const rows: { area: string; method: string; path: string; pub: boolean }[] = [];
for (const mod of app.get(ModulesContainer).values()) {
  for (const wrapper of mod.controllers.values()) {
    const ctrl = wrapper.metatype as (new (...a: unknown[]) => unknown) | undefined;
    if (!ctrl) continue;
    const prefix = (Reflect.getMetadata(PATH_METADATA, ctrl) as string | undefined) ?? "";
    for (const name of Object.getOwnPropertyNames(ctrl.prototype)) {
      const h = ctrl.prototype[name];
      if (name === "constructor" || typeof h !== "function") continue;
      const path = Reflect.getMetadata(PATH_METADATA, h) as string | string[] | undefined;
      const m = Reflect.getMetadata(METHOD_METADATA, h) as number | undefined;
      if (path === undefined || m === undefined) continue;
      for (const p of Array.isArray(path) ? path : [path]) {
        const full = `/${[prefix, p].map((s) => s.replace(/^\/|\/$/g, "")).filter(Boolean).join("/")}`;
        const area = areaOf(full);
        rows.push({ area, method: METHODS[m] ?? "GET", path: full, pub: Reflect.getMetadata(IS_PUBLIC, h) === true });
      }
    }
  }
}

const order = AREA_ORDER;
const out: string[] = [
  "# Healora Hub API — route reference",
  "",
  `Generated from the running application by \`scripts/routes.ts\`. ${rows.length} routes. All paths are under \`/api/v1\` except \`/health\`.`,
  "Every route requires a bearer token unless marked **public**. Role requirements are enforced in each handler via `AccessService` (see README › Security model).",
  "",
];
for (const area of order) {
  const list = rows.filter((r) => r.area === area).sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  if (!list.length) continue;
  out.push(`## ${area}`, "", "| Method | Path | |", "|---|---|---|");
  for (const r of list) out.push(`| ${r.method} | \`${r.path}\` | ${r.pub ? "**public**" : ""} |`);
  out.push("");
}
console.log(out.join("\n"));
await app.close();
process.exit(0);
