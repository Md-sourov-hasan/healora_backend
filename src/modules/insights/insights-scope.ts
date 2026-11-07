import type { AccessService } from "../../common/access.service.ts";
import type { Principal } from "../../common/auth/principal.ts";
import { db } from "../../common/db.ts";
import { badRequest, forbidden } from "../../common/errors.ts";
import type { StaffRole } from "../../common/roles.ts";
import { z, zDate, zId } from "../../common/validation.ts";

export interface HubFilter {
  hubId?: string;
  regionId?: string;
}

/**
 * Materialises the hub ids a caller may see for `roles`, narrowed by an
 * optional hub/region filter. A filter outside the caller's scope is refused
 * (and logged by AccessService), never silently widened.
 */
export async function scopedHubIds(access: AccessService, p: Principal, roles: readonly StaffRole[], filter: HubFilter, action: string) {
  await access.require(p, roles, filter.hubId ? { hubId: filter.hubId } : filter.regionId ? { regionId: filter.regionId } : undefined, action);
  const scope = await access.hubScope(p, roles);
  let candidates: string[];
  if (filter.hubId) candidates = [filter.hubId];
  else if (filter.regionId) {
    const regions = await access.regionDescendants([filter.regionId]);
    candidates = (await db.orm.hub.Hub.select("id").where((h) => h.regionId.in(regions)).all()).map((h) => h.id);
  } else if (scope === "all") candidates = (await db.orm.hub.Hub.select("id").all()).map((h) => h.id);
  else candidates = scope;
  const ids = scope === "all" ? candidates : candidates.filter((id) => scope.includes(id));
  if (filter.hubId && ids.length === 0) throw forbidden();
  return { hubIds: ids, scopeLabel: scope === "all" && !filter.hubId && !filter.regionId ? ("all" as const) : ids };
}

export const MAX_RANGE_DAYS = 92;

export const zRange = z
  .object({ from: zDate, to: zDate, hubId: zId.optional(), regionId: zId.optional(), serviceTypeId: zId.optional() })
  .refine((v) => v.from <= v.to, "from must be on or before to");

export function rangeBounds(from: string, to: string) {
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400_000;
  if (days > MAX_RANGE_DAYS) throw badRequest("RANGE_TOO_LONG", `Date range may not exceed ${MAX_RANGE_DAYS} days`);
  // Bangladesh hubs: day boundaries in Asia/Dhaka (UTC+6, no DST).
  return { fromInstant: `${from}T00:00:00+06:00`, toInstant: `${to}T23:59:59.999+06:00` };
}

/** Run an `in (...)` query in chunks so huge id lists stay within parameter limits. */
export async function inChunks<T>(ids: string[], run: (chunk: string[]) => PromiseLike<T[]>, size = 1000): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += size) out.push(...(await run(ids.slice(i, i + size))));
  return out;
}

export function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const headers = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const esc = (v: unknown) => {
    if (v === null || v === undefined) return "";
    let s = typeof v === "object" ? JSON.stringify(v) : String(v);
    // Neutralise spreadsheet formula injection.
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(","), ...rows.map((r) => headers.map((h) => esc(r[h])).join(","))].join("\n");
}

export const pct = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);
