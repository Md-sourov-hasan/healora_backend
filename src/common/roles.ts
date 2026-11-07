/**
 * Role groups used by controllers. Keep authorisation decisions readable:
 * `access.require(p, HUB_OPS, { hubId })`.
 */
export type StaffRole =
  | "platform_super_admin"
  | "regional_ops_manager"
  | "hub_manager"
  | "reception_officer"
  | "queue_coordinator"
  | "equipment_officer"
  | "operations_auditor"
  | "clinical_ops_admin"
  | "special_team_lead"
  | "field_health_worker"
  | "local_doctor"
  | "registered_doctor";

export const ADMIN: StaffRole[] = ["platform_super_admin"];
export const REGIONAL: StaffRole[] = ["platform_super_admin", "regional_ops_manager"];
export const HUB_MANAGEMENT: StaffRole[] = ["platform_super_admin", "regional_ops_manager", "hub_manager"];
/** Website roles that work the live hub floor. */
export const HUB_FLOOR: StaffRole[] = [...HUB_MANAGEMENT, "reception_officer", "queue_coordinator"];
export const RECEPTION: StaffRole[] = [...HUB_MANAGEMENT, "reception_officer"];
export const QUEUE: StaffRole[] = [...HUB_MANAGEMENT, "queue_coordinator", "reception_officer"];
export const EQUIPMENT: StaffRole[] = [...HUB_MANAGEMENT, "equipment_officer"];
/** May view operational data (aggregates, statuses) without changing it. */
export const OPS_READ: StaffRole[] = [...HUB_FLOOR, "equipment_officer", "operations_auditor"];
export const AUDIT_READ: StaffRole[] = ["platform_super_admin", "operations_auditor"];
export const CLINICAL_GOVERNANCE: StaffRole[] = ["platform_super_admin", "clinical_ops_admin"];

/** Shared Local Doctor + Special Team app profiles. */
export const TEAM: StaffRole[] = ["special_team_lead", "field_health_worker", "local_doctor", "registered_doctor"];
export const CAPTURE: StaffRole[] = ["special_team_lead", "field_health_worker", "local_doctor", "registered_doctor"];
export const DOCTORS: StaffRole[] = ["local_doctor", "registered_doctor"];
export const CLINICAL_ROLES: StaffRole[] = TEAM;

/** Roles that require an active verified credential to be rostered/assigned. */
export const CREDENTIALED: StaffRole[] = ["field_health_worker", "special_team_lead", "local_doctor", "registered_doctor"];

/** Privileged roles that must use MFA (PRD §6.4). */
export const PRIVILEGED: StaffRole[] = ["platform_super_admin", "regional_ops_manager", "clinical_ops_admin"];
