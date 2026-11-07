import { randomInt } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";
import { or } from "@prisma/orm-postgres/orm-client";

import { AuditService } from "../../common/audit.service.ts";
import type { StaffPrincipal } from "../../common/auth/principal.ts";
import { db, nowIso, type Tx } from "../../common/db.ts";
import { conflict, found } from "../../common/errors.ts";
import { EventsService } from "../../common/events.service.ts";
import { MIN_PATIENT_FIELDS, hashIdentifier, last4, minimalPatient } from "./patient-view.ts";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export type IdentifierType = "national_id" | "birth_registration" | "passport" | "healora_card" | "other";

export interface RegisterInput {
  hubId: string;
  fullName: string;
  fullNameBn?: string;
  dateOfBirth?: string;
  birthYearEstimated?: number;
  sex: "female" | "male" | "other" | "unknown";
  phone?: string;
  preferredLanguage: "bn" | "en";
  addressLine?: string;
  regionId?: string;
  identifiers: { type: IdentifierType; value: string }[];
}

const normaliseName = (n: string) => n.toLowerCase().replace(/[^\p{L}\s]/gu, "").replace(/\s+/g, " ").trim();
const birthYearOf = (p: { dateOfBirth: string | null; birthYearEstimated: number | null }) =>
  p.dateOfBirth ? Number(p.dateOfBirth.slice(0, 4)) : p.birthYearEstimated;

@Injectable()
export class PatientsService {
  constructor(
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(EventsService) private readonly events: EventsService,
  ) {}

  /**
   * Assisted registration (PRD §9.4). Never blocks on a suspected duplicate:
   * it records candidates for authorised resolution, and check-in refuses to
   * open a clinical encounter until they are resolved.
   */
  async register(p: StaffPrincipal, input: RegisterInput) {
    return db.transaction(async (tx) => {
      const patient = await tx.orm.clinical.Patient.create({
        healoraCode: await this.newHealoraCode(tx),
        fullName: input.fullName,
        fullNameBn: input.fullNameBn ?? null,
        dateOfBirth: input.dateOfBirth ?? null,
        birthYearEstimated: input.birthYearEstimated ?? null,
        sex: input.sex,
        phone: input.phone ?? null,
        preferredLanguage: input.preferredLanguage,
        addressLine: input.addressLine ?? null,
        regionId: input.regionId ?? null,
        registeredAtHubId: input.hubId,
        registeredById: p.userId,
      });

      const matches = new Map<string, string>();
      // 1. Same identifier hash → strong match; do not store a second copy.
      const skipped: string[] = [];
      for (const ident of input.identifiers) {
        const valueHash = hashIdentifier(ident.type, ident.value);
        const existing = await tx.orm.clinical.PatientIdentifier.where({ type: ident.type, valueHash }).first();
        if (existing) {
          matches.set(existing.patientId, `same ${ident.type}`);
          skipped.push(ident.type);
          continue;
        }
        await tx.orm.clinical.PatientIdentifier.create({ patientId: patient.id, type: ident.type, valueHash, valueLast4: last4(ident.value), verifiedById: p.userId, verifiedAt: nowIso() });
      }
      // 2. Same phone + similar name or same birth year.
      if (input.phone) {
        const samePhone = await tx.orm.clinical.Patient.select("id", "fullName", "dateOfBirth", "birthYearEstimated")
          .where({ phone: input.phone, status: "active" })
          .where((x) => x.id.neq(patient.id))
          .limit(50)
          .all();
        const name = normaliseName(input.fullName);
        const firstToken = name.split(" ")[0];
        const year = input.dateOfBirth ? Number(input.dateOfBirth.slice(0, 4)) : input.birthYearEstimated;
        for (const other of samePhone) {
          const otherName = normaliseName(other.fullName);
          const similarName = otherName === name || (firstToken && otherName.split(" ")[0] === firstToken);
          const otherYear = birthYearOf(other);
          const sameYear = year != null && otherYear != null && Math.abs(otherYear - year) <= 1;
          if (similarName || sameYear) matches.set(other.id, matches.get(other.id) ?? (similarName ? "same phone, similar name" : "same phone, similar birth year"));
        }
      }

      const candidates = [];
      for (const [otherId, reason] of matches) {
        candidates.push(await this.flagDuplicate(tx, p, patient.id, otherId, reason, input.hubId));
      }

      await this.audit.record(p, { action: "patient.registered", targetType: "patient", targetId: patient.id, hubId: input.hubId, patientId: patient.id, metadata: { duplicateCandidates: candidates.length } }, tx);
      return { patient: minimalPatient(patient), duplicateCandidates: candidates, identifiersNotStored: skipped };
    });
  }

  async addIdentifier(p: StaffPrincipal, patientId: string, hubId: string, type: IdentifierType, value: string) {
    return db.transaction(async (tx) => {
      found(await tx.orm.clinical.Patient.select("id").first({ id: patientId }), "Patient");
      const valueHash = hashIdentifier(type, value);
      const existing = await tx.orm.clinical.PatientIdentifier.where({ type, valueHash }).first();
      if (existing) {
        if (existing.patientId === patientId) return { id: existing.id, type, valueLast4: existing.valueLast4 };
        const candidate = await this.flagDuplicate(tx, p, patientId, existing.patientId, `same ${type}`, hubId);
        await this.audit.record(p, { action: "patient.identifier_conflict", targetType: "patient", targetId: patientId, hubId, patientId }, tx);
        return { conflict: true, duplicateCandidate: candidate };
      }
      const row = await tx.orm.clinical.PatientIdentifier.create({ patientId, type, valueHash, valueLast4: last4(value), verifiedById: p.userId, verifiedAt: nowIso() });
      await this.audit.record(p, { action: "patient.identifier_added", targetType: "patient", targetId: patientId, hubId, patientId, metadata: { type } }, tx);
      return { id: row.id, type, valueLast4: row.valueLast4 };
    });
  }

  async flagDuplicate(tx: Tx, p: StaffPrincipal, a: string, b: string, reason: string, hubId: string | null) {
    const [patientAId, patientBId] = a < b ? [a, b] : [b, a];
    let candidate = await tx.orm.clinical.PatientDuplicateCandidate.where({ patientAId, patientBId }).first();
    if (!candidate) {
      candidate = await tx.orm.clinical.PatientDuplicateCandidate.create({ patientAId, patientBId, matchReason: reason, detectedById: p.userId });
    } else if (candidate.status !== "open") {
      return { id: candidate.id, status: candidate.status, matchReason: candidate.matchReason };
    }
    if (hubId) {
      const dedupeKey = `dup:${patientAId}:${patientBId}`;
      const open = await tx.orm.hub.OperationalException.select("id")
        .where({ dedupeKey })
        .where((e) => e.status.in(["open", "acknowledged", "escalated"]))
        .first();
      if (!open) {
        await tx.orm.hub.OperationalException.create({
          hubId,
          type: "potential_duplicate_patient",
          severity: "medium",
          summary: "Possible duplicate patient record needs resolution before clinical data is attached",
          dedupeKey,
          raisedAt: nowIso(),
        });
        await this.events.emit(tx, { eventType: "exception.raised", aggregateType: "operational_exception", aggregateId: candidate.id, hubId, payload: { type: "potential_duplicate_patient", duplicateCandidateId: candidate.id } });
      }
    }
    return { id: candidate.id, status: candidate.status, matchReason: candidate.matchReason, otherPatientId: patientAId === a ? patientBId : patientAId };
  }

  async resolveDuplicate(p: StaffPrincipal, id: string, resolution: "not_duplicate" | "confirmed_duplicate", note: string) {
    return db.transaction(async (tx) => {
      const c = found(await tx.orm.clinical.PatientDuplicateCandidate.where({ id }).forNoKeyUpdate().first(), "Duplicate candidate");
      if (c.status !== "open") throw conflict("ALREADY_RESOLVED", `Candidate is ${c.status}`);
      const updated = await tx.orm.clinical.PatientDuplicateCandidate.where({ id }).update({ status: resolution, resolvedById: p.userId, resolvedAt: nowIso(), resolutionNote: note });
      await this.closeDuplicateException(tx, p, c.patientAId, c.patientBId, note);
      await this.audit.record(p, { action: `patient.duplicate_${resolution}`, targetType: "patient_duplicate_candidate", targetId: id, reason: note, priority: "high" }, tx);
      return updated;
    });
  }

  private async closeDuplicateException(tx: Tx, p: StaffPrincipal, a: string, b: string, note: string) {
    await tx.orm.hub.OperationalException.where({ dedupeKey: `dup:${a}:${b}` })
      .where((e) => e.status.in(["open", "acknowledged", "escalated"]))
      .updateAll({ status: "resolved", resolvedAt: nowIso(), resolvedById: p.userId, resolutionNote: note.slice(0, 500) });
  }

  /**
   * Audited platform-level merge (PRD §8.8). Clinical rows stay attached to
   * their original patient id; the PatientMerge record links the timelines.
   */
  async merge(p: StaffPrincipal, survivorId: string, mergedId: string, reason: string, duplicateCandidateId: string | null) {
    if (survivorId === mergedId) throw conflict("SAME_PATIENT", "Cannot merge a patient into itself");
    return db.transaction(async (tx) => {
      const [first, second] = survivorId < mergedId ? [survivorId, mergedId] : [mergedId, survivorId];
      const lockedFirst = found(await tx.orm.clinical.Patient.where({ id: first }).forNoKeyUpdate().first(), "Patient");
      const lockedSecond = found(await tx.orm.clinical.Patient.where({ id: second }).forNoKeyUpdate().first(), "Patient");
      const survivor = lockedFirst.id === survivorId ? lockedFirst : lockedSecond;
      const merged = lockedFirst.id === mergedId ? lockedFirst : lockedSecond;
      if (survivor.status !== "active" || merged.status !== "active") throw conflict("PATIENT_NOT_ACTIVE", "Both patients must be active");

      const now = nowIso();
      await tx.orm.clinical.Patient.where({ id: merged.id }).update({ status: "merged", mergedIntoId: survivor.id });
      await tx.orm.clinical.PatientIdentifier.where({ patientId: merged.id }).updateAll({ patientId: survivor.id });

      // Re-point open (not yet checked-in) appointments; cancel clashes with the survivor's bookings.
      const open = await tx.orm.hub.Appointment.where({ patientId: merged.id }).where((a) => a.status.in(["pending_confirmation", "confirmed", "arrived"])).all();
      let repointed = 0;
      let cancelled = 0;
      for (const a of open) {
        const clash = await tx.orm.hub.Appointment.select("id")
          .where({ patientId: survivor.id, sessionId: a.sessionId })
          .where((x) => x.status.in(["pending_confirmation", "confirmed", "arrived", "checked_in", "in_service"]))
          .first();
        if (clash) {
          await tx.orm.hub.Appointment.where({ id: a.id }).update({ status: "cancelled", cancelledAt: now, cancelReason: "duplicate booking after patient merge" });
          cancelled++;
        } else {
          await tx.orm.hub.Appointment.where({ id: a.id }).update({ patientId: survivor.id, version: a.version + 1 });
          repointed++;
        }
      }
      await tx.orm.hub.WaitlistEntry.where({ patientId: merged.id, status: "waiting" }).updateAll({ status: "cancelled" });

      let candidateId = duplicateCandidateId;
      const [a, b] = survivor.id < merged.id ? [survivor.id, merged.id] : [merged.id, survivor.id];
      const candidate = await tx.orm.clinical.PatientDuplicateCandidate.where({ patientAId: a, patientBId: b }).first();
      if (candidate) {
        candidateId = candidate.id;
        if (candidate.status === "open") {
          await tx.orm.clinical.PatientDuplicateCandidate.where({ id: candidate.id }).update({ status: "confirmed_duplicate", resolvedById: p.userId, resolvedAt: now, resolutionNote: reason });
        }
      }
      await this.closeDuplicateException(tx, p, a, b, `merged: ${reason}`);

      const record = await tx.orm.clinical.PatientMerge.create({
        survivorPatientId: survivor.id,
        mergedPatientId: merged.id,
        duplicateCandidateId: candidateId,
        reason,
        performedById: p.userId,
        performedAt: now,
      });
      await this.audit.record(p, { action: "patient.merged", targetType: "patient", targetId: merged.id, patientId: survivor.id, reason, priority: "high", metadata: { survivorId: survivor.id, repointed, cancelled } }, tx);
      return { merge: record, appointmentsRepointed: repointed, appointmentsCancelled: cancelled };
    });
  }

  async minimal(id: string) {
    const row = found(await db.orm.clinical.Patient.select(...MIN_PATIENT_FIELDS, "mergedIntoId").first({ id }), "Patient");
    return row;
  }

  /** Follow merge links to the surviving record. */
  async resolveSurvivor(id: string) {
    let current = await this.minimal(id);
    for (let i = 0; i < 5 && current.status === "merged" && current.mergedIntoId; i++) current = await this.minimal(current.mergedIntoId);
    return current;
  }

  openDuplicateFor(patientId: string, tx: Tx | typeof db = db) {
    return tx.orm.clinical.PatientDuplicateCandidate.select("id")
      .where({ status: "open" })
      .where((c) => or(c.patientAId.eq(patientId), c.patientBId.eq(patientId)))
      .first();
  }

  private async newHealoraCode(tx: Tx): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt++) {
      let code = "HL";
      for (let i = 0; i < 8; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      const clash = await tx.orm.clinical.Patient.select("id").where({ healoraCode: code }).first();
      if (!clash) return code;
    }
    throw new Error("Could not allocate Healora code");
  }
}
