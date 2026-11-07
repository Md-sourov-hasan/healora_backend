import { Body, Controller, Get, Module, Post } from "@nestjs/common";

import { Auth, Public } from "../../common/auth/decorators.ts";
import { signJwt } from "../../common/auth/jwt.ts";
import type { Principal } from "../../common/auth/principal.ts";
import { db } from "../../common/db.ts";
import { forbidden, found } from "../../common/errors.ts";
import { parse, z, zId } from "../../common/validation.ts";

/** Navigation entries per role (PRD §8.1 — nav filtered by role). */
const NAV: Record<string, string[]> = {
  overview: ["platform_super_admin", "regional_ops_manager", "hub_manager", "reception_officer", "queue_coordinator", "equipment_officer", "operations_auditor"],
  hubs: ["platform_super_admin", "regional_ops_manager", "hub_manager"],
  sessions: ["platform_super_admin", "regional_ops_manager", "hub_manager", "reception_officer", "queue_coordinator"],
  appointments: ["platform_super_admin", "regional_ops_manager", "hub_manager", "reception_officer"],
  live_queue: ["platform_super_admin", "regional_ops_manager", "hub_manager", "reception_officer", "queue_coordinator"],
  patients: ["platform_super_admin", "regional_ops_manager", "hub_manager", "reception_officer"],
  team: ["platform_super_admin", "regional_ops_manager", "hub_manager"],
  stations_equipment: ["platform_super_admin", "regional_ops_manager", "hub_manager", "equipment_officer", "queue_coordinator"],
  reports: ["platform_super_admin", "regional_ops_manager", "hub_manager", "operations_auditor"],
  activity: ["platform_super_admin", "regional_ops_manager", "hub_manager", "reception_officer", "queue_coordinator", "equipment_officer", "operations_auditor"],
  settings: ["platform_super_admin", "clinical_ops_admin"],
};

@Controller()
class SystemController {
  @Public()
  @Get("health")
  async health() {
    const ok = await db.orm.hub.Region.select("id").first().then(() => true, () => false);
    return { status: ok ? "ok" : "degraded", database: ok, time: new Date().toISOString() };
  }

  /** Who am I + what can I see. Drives the website's role-filtered navigation. */
  @Get("me")
  async me(@Auth() p: Principal) {
    if (p.kind === "patient") {
      const patient = found(await db.orm.clinical.Patient.select("id", "healoraCode", "fullName", "fullNameBn", "preferredLanguage", "preferredHubId").first({ id: p.patientId }), "Patient");
      return { kind: "patient", patient, actingAsRepresentativeId: p.representativeId };
    }
    const user = found(await db.orm.identity.User.select("id", "email", "name", "nameBn", "preferredLanguage", "mfaEnabled").first({ id: p.userId }), "User");
    const roles = new Set(p.assignments.map((a) => a.role));
    const navigation = Object.entries(NAV).filter(([, allowed]) => allowed.some((r) => roles.has(r as never))).map(([k]) => k);
    return { kind: "staff", user, assignments: p.assignments, navigation, strongAuth: p.strongAuth };
  }
}

/**
 * Development-only token minting. The central Healora identity service issues
 * real tokens; enable this only with AUTH_DEV_TOKENS=true outside production.
 */
@Controller("dev")
class DevController {
  @Public()
  @Post("token")
  async token(@Body() body: unknown) {
    if (process.env.AUTH_DEV_TOKENS !== "true" || process.env.NODE_ENV === "production") throw forbidden("Dev tokens are disabled");
    const input = parse(
      z.object({ userId: zId.optional(), patientId: zId.optional(), mfa: z.boolean().default(true), ttlSeconds: z.number().int().max(86400).default(3600) }).refine((v) => !!v.userId !== !!v.patientId, "Give exactly one of userId or patientId"),
      body,
    );
    const token = input.userId
      ? signJwt({ sub: input.userId, typ: "staff", amr: input.mfa ? ["pwd", "otp"] : ["pwd"] }, input.ttlSeconds)
      : signJwt({ sub: input.patientId!, typ: "patient", amr: ["otp"] }, input.ttlSeconds);
    return { token, expiresIn: input.ttlSeconds };
  }
}

@Module({ controllers: [SystemController, DevController] })
export class SystemModule {}
