import { or } from "@prisma/orm-postgres/orm-client";

import { db, type DbLike, dhakaDate, nowIso } from "../../common/db.ts";
import { found } from "../../common/errors.ts";
import { CREDENTIALED, type StaffRole } from "../../common/roles.ts";

export interface UnmetItem {
  kind: "hub" | "availability" | "staff_role" | "station_type" | "equipment_type" | "equipment_item" | "service_offering";
  code: string;
  required?: number;
  available?: number;
  detail: string;
}

export interface Readiness {
  ready: boolean;
  unmet: UnmetItem[];
  warnings: UnmetItem[];
  snapshot: Record<string, unknown>;
}

const ROSTERED = ["approved", "checked_in"] as const;
const UNUSABLE_EQUIPMENT = ["out_of_service", "retired", "maintenance"];

/** Verified, unexpired credential that qualifies `userId` for `role`. */
export async function hasValidCredential(tx: DbLike, userId: string, role: string, onDate: string = dhakaDate()): Promise<boolean> {
  const creds = await tx.orm.identity.StaffCredential.select("qualifiesForRoles", "expiresAt")
    .where({ userId, status: "verified" })
    .where((c) => or(c.expiresAt.isNull(), c.expiresAt.gte(onDate)))
    .all();
  return creds.some((c) => (c.qualifiesForRoles as string[]).includes(role));
}

/** Equipment usable for a session on `onDate` (not out of service, calibration not overdue). */
export function equipmentUsable(e: { status: string; nextCalibrationDue: string | null }, onDate: string): boolean {
  if (UNUSABLE_EQUIPMENT.includes(e.status)) return false;
  if (e.nextCalibrationDue && e.nextCalibrationDue < onDate) return false;
  return true;
}

/**
 * Evaluates whether a session meets the minimum staffing / station /
 * equipment configuration for its service type (PRD §8.5, §9.1).
 */
export async function evaluateReadiness(sessionId: string, tx: DbLike = db): Promise<Readiness> {
  const session = found(await tx.orm.hub.HubSession.first({ id: sessionId }), "Session");
  const hub = found(await tx.orm.hub.Hub.first({ id: session.hubId }), "Hub");
  const unmet: UnmetItem[] = [];
  const warnings: UnmetItem[] = [];

  if (hub.status !== "active") unmet.push({ kind: "hub", code: "hub_not_active", detail: `Hub status is '${hub.status}'` });

  const offering = await tx.orm.hub.HubServiceOffering.where({ hubId: hub.id, serviceTypeId: session.serviceTypeId }).first();
  if (!offering || offering.status !== "approved") {
    unmet.push({ kind: "service_offering", code: "service_not_approved_for_hub", detail: "The service type is not an approved offering for this hub" });
  }

  const blocks = await tx.orm.hub.HubAvailabilityBlock.where({ hubId: hub.id })
    .where((b) => b.liftedAt.isNull())
    .where((b) => b.startsAt.lt(session.endsAt))
    .where((b) => or(b.endsAt.isNull(), b.endsAt.gt(session.startsAt)))
    .all();
  for (const b of blocks) {
    const item: UnmetItem = { kind: "availability", code: `hub_${b.blockType}`, detail: b.reason };
    if (b.blockType === "capacity_block") warnings.push(item);
    else unmet.push(item);
  }

  const requirements = await tx.orm.hub.ServiceTypeRequirement.where({ serviceTypeId: session.serviceTypeId }).all();
  const shifts = await tx.orm.hub.StaffShift.select("id", "userId", "role", "status", "stationId")
    .where({ sessionId })
    .where((s) => s.status.in([...ROSTERED]))
    .all();
  const stations = await tx.orm.hub.HubStation.select("id", "code", "stationType", "status").where({ hubId: hub.id }).all();
  const sessionEquipmentRows = await tx.orm.hub.SessionEquipment.where({ sessionId })
    .include("equipment", (e) => e.select("id", "assetTag", "category", "status", "nextCalibrationDue"))
    .all();
  const sessionEquipment = sessionEquipmentRows.flatMap((se) => (se.equipment ? [{ ...se, equipment: se.equipment }] : []));

  // Staff: count rostered people per role; credentialed roles must hold a valid credential.
  const validByRole = new Map<string, Set<string>>();
  for (const s of shifts) {
    if (CREDENTIALED.includes(s.role as StaffRole) && !(await hasValidCredential(tx, s.userId, s.role, session.sessionDate))) {
      warnings.push({ kind: "staff_role", code: "credential_invalid", detail: `Rostered ${s.role} ${s.userId} has no valid credential` });
      continue;
    }
    const set = validByRole.get(s.role) ?? new Set<string>();
    set.add(s.userId);
    validByRole.set(s.role, set);
  }

  for (const r of requirements) {
    const target = r.mandatory ? unmet : warnings;
    if (r.kind === "staff_role" && r.staffRole) {
      const available = validByRole.get(r.staffRole)?.size ?? 0;
      if (available < r.minCount) target.push({ kind: "staff_role", code: r.staffRole, required: r.minCount, available, detail: `Need ${r.minCount} rostered ${r.staffRole}` });
    } else if (r.kind === "station_type" && r.stationType) {
      const available = stations.filter((s) => s.stationType === r.stationType && s.status !== "out_of_service").length;
      if (available < r.minCount) target.push({ kind: "station_type", code: r.stationType, required: r.minCount, available, detail: `Need ${r.minCount} ${r.stationType} station(s) in service` });
    } else if (r.kind === "equipment_type" && r.equipmentCategory) {
      const available = sessionEquipment.filter((se) => se.equipment.category === r.equipmentCategory && equipmentUsable(se.equipment, session.sessionDate)).length;
      if (available < r.minCount) target.push({ kind: "equipment_type", code: r.equipmentCategory, required: r.minCount, available, detail: `Need ${r.minCount} usable ${r.equipmentCategory} assigned to the session` });
    }
  }

  for (const se of sessionEquipment) {
    if (se.mandatory && !equipmentUsable(se.equipment, session.sessionDate)) {
      unmet.push({ kind: "equipment_item", code: se.equipment.assetTag, detail: `Mandatory equipment ${se.equipment.assetTag} is ${se.equipment.status}${se.equipment.nextCalibrationDue && se.equipment.nextCalibrationDue < session.sessionDate ? " (calibration overdue)" : ""}` });
    }
  }

  return {
    ready: unmet.length === 0,
    unmet,
    warnings,
    snapshot: {
      evaluatedAt: nowIso(),
      appointmentCapacity: session.appointmentCapacity,
      walkInCapacity: session.walkInCapacity,
      requirements: requirements.map((r) => ({ kind: r.kind, staffRole: r.staffRole, stationType: r.stationType, equipmentCategory: r.equipmentCategory, minCount: r.minCount, mandatory: r.mandatory })),
      roster: shifts.map((s) => ({ shiftId: s.id, userId: s.userId, role: s.role, stationId: s.stationId })),
      equipment: sessionEquipment.map((se) => ({ equipmentId: se.equipment.id, assetTag: se.equipment.assetTag, category: se.equipment.category, status: se.equipment.status, mandatory: se.mandatory })),
      stations: stations.map((s) => ({ stationId: s.id, code: s.code, type: s.stationType, status: s.status })),
    },
  };
}
