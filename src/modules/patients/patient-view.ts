import { createHmac } from "node:crypto";

/** Columns needed to build the minimal operational identity view. */
export const MIN_PATIENT_FIELDS = ["id", "healoraCode", "fullName", "fullNameBn", "phone", "dateOfBirth", "birthYearEstimated", "sex", "status"] as const;

export interface MinPatientSource {
  id: string;
  healoraCode: string;
  fullName: string;
  fullNameBn?: string | null;
  phone: string | null;
  dateOfBirth: string | null;
  birthYearEstimated: number | null;
  sex: string;
  status: string;
}

export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  return `${"*".repeat(Math.max(0, phone.length - 3))}${phone.slice(-3)}`;
}

/**
 * Minimum-necessary identity for operational screens (PRD §6.1, §8.8):
 * enough to avoid selecting the wrong person, nothing clinical.
 */
export function minimalPatient(p: MinPatientSource) {
  return {
    id: p.id,
    healoraCode: p.healoraCode,
    fullName: p.fullName,
    fullNameBn: p.fullNameBn ?? null,
    maskedPhone: maskPhone(p.phone),
    birthYear: p.dateOfBirth ? Number(p.dateOfBirth.slice(0, 4)) : (p.birthYearEstimated ?? null),
    sex: p.sex,
    status: p.status,
  };
}

/** Queue-board style identifier: code + first name only (PRD §14.2). */
export function queuePatient(p: { healoraCode: string; fullName: string }) {
  return { healoraCode: p.healoraCode, firstName: p.fullName.trim().split(/\s+/)[0] ?? "" };
}

/** Keyed hash of a secondary identifier (national ID etc.). Raw values are never stored. */
export function hashIdentifier(type: string, value: string): string {
  const key = process.env.IDENTIFIER_HASH_KEY || process.env.JWT_SECRET || "";
  if (!key) throw new Error("IDENTIFIER_HASH_KEY or JWT_SECRET must be set");
  const normalised = value.replace(/[\s-]/g, "").toUpperCase();
  return createHmac("sha256", key).update(`${type}:${normalised}`).digest("hex");
}

export function last4(value: string): string {
  return value.replace(/[\s-]/g, "").slice(-4);
}
