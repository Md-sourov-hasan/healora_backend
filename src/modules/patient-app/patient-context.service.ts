import { Inject, Injectable } from "@nestjs/common";
import { or } from "@prisma/orm-postgres/orm-client";

import { AuditService, type AuditEntry } from "../../common/audit.service.ts";
import type { PatientPrincipal } from "../../common/auth/principal.ts";
import { db, type DbLike, nowIso } from "../../common/db.ts";
import { forbidden } from "../../common/errors.ts";

/**
 * Resolves who is acting in the patient app. When a caregiver token carries a
 * representative id, the authority is re-verified on every request (PRD §6.3):
 * it must belong to this patient, be verified, unrevoked and within validity.
 */
@Injectable()
export class PatientContextService {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  async resolve(p: PatientPrincipal): Promise<{ patientId: string; representativeId: string | null }> {
    if (p.representativeId) {
      const now = nowIso();
      const rep = await db.orm.clinical.PatientRepresentative.select("id")
        .where({ id: p.representativeId, patientId: p.patientId })
        .where((r) => r.revokedAt.isNull())
        .where((r) => r.verifiedAt.isNotNull())
        .where((r) => r.validFrom.lte(now))
        .where((r) => or(r.validTo.isNull(), r.validTo.gt(now)))
        .first();
      if (!rep) {
        await this.audit.record(p, {
          action: "denied:patient_app.representative",
          targetType: "patient_representative",
          targetId: p.representativeId,
          patientId: p.patientId,
          outcome: "denied",
          priority: "high",
        });
        throw forbidden("Caregiver authority is not valid for this patient", "REPRESENTATIVE_INVALID");
      }
    }
    return { patientId: p.patientId, representativeId: p.representativeId };
  }

  /** Audit a patient-app action, always recording the acting representative. */
  record(p: PatientPrincipal, entry: AuditEntry, tx: DbLike = db) {
    return this.audit.record(
      p,
      { ...entry, patientId: p.patientId, metadata: { ...(entry.metadata ?? {}), representativeId: p.representativeId } },
      tx,
    );
  }
}
