import { db } from "../prisma/db.ts";

export { db };

/** The client handed to a `db.transaction(async (tx) => ...)` callback. */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Anything that exposes `.orm` — the root client or a transaction. */
export type DbLike = typeof db | Tx;

export function nowIso(): string {
  return new Date().toISOString();
}

/** Date part (YYYY-MM-DD) of an instant, in Asia/Dhaka (UTC+6, no DST). */
export function dhakaDate(instant: Date = new Date()): string {
  const shifted = new Date(instant.getTime() + 6 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

/** Postgres timestamptz text ("2026-11-10 03:00:00+00") → Date. */
export function toDate(value: string | null | undefined): Date | null {
  if (value == null) return null;
  // Postgres prints "2026-11-10 09:00:00.123+06" or "...+05:30"; normalise to ISO-8601.
  const iso = value
    .trim()
    .replace(" ", "T")
    .replace(/([+-]\d{2})$/, "$1:00")
    .replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function minutesBetween(from: string | null | undefined, to: string | null | undefined): number | null {
  const a = toDate(from);
  const b = toDate(to);
  if (!a || !b) return null;
  return Math.round((b.getTime() - a.getTime()) / 60000);
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}
