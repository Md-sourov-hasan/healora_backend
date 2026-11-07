import type { StaffRole } from "../roles.ts";

export interface ActiveAssignment {
  id: string;
  role: StaffRole;
  scopeType: "platform" | "region" | "hub" | "session";
  regionId: string | null;
  hubId: string | null;
  sessionId: string | null;
}

interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
  correlationId: string;
  authSessionId: string | null;
  deviceInstallationId: string | null;
  strongAuth: boolean;
}

export interface StaffPrincipal extends RequestMeta {
  kind: "staff";
  userId: string;
  name: string | null;
  assignments: ActiveAssignment[];
}

export interface PatientPrincipal extends RequestMeta {
  kind: "patient";
  patientId: string;
  /** Set when a caregiver is acting under recorded authority. */
  representativeId: string | null;
}

export type Principal = StaffPrincipal | PatientPrincipal;
