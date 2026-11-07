import { Body, Controller, Delete, Get, HttpCode, Inject, Module, Param, Post, Req } from "@nestjs/common";

import { AccessService } from "../../common/access.service.ts";
import { Auth, Public, Staff } from "../../common/auth/decorators.ts";
import type { Principal, StaffPrincipal } from "../../common/auth/principal.ts";
import { db } from "../../common/db.ts";
import { forbidden, found } from "../../common/errors.ts";
import { RateLimit } from "../../common/rate-limit.ts";
import { ADMIN, REGIONAL } from "../../common/roles.ts";
import { parse, z, zId, zReason } from "../../common/validation.ts";
import { AuthService, type RequestMeta } from "./auth.service.ts";

type Req = { ip?: string; headers: Record<string, string | undefined> };
const meta = (req: Req): RequestMeta => ({
  ip: req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ?? req.ip ?? null,
  userAgent: req.headers["user-agent"] ?? null,
  deviceInstallationId: req.headers["x-device-id"] ?? null,
});

/**
 * Per-IP backstop limits. Hub staff share one NAT address and mobile patients
 * sit behind carrier-grade NAT, so these are deliberately generous; the real
 * brute-force protection is per account (login lockout, per-email and
 * per-phone limits, per-challenge attempt caps) in AuthService.
 * AUTH_IP_LIMIT_FACTOR scales them (e.g. 0.5 to tighten, 2 for a busy hub).
 */
const ipLimit = (base: number) => Math.max(5, Math.round(base * Number(process.env.AUTH_IP_LIMIT_FACTOR ?? 1)));

const zCode = z.string().trim().regex(/^\d{6}$/, "6-digit code");

/**
 * Authentication endpoints (PRD §6.4, §16.1).
 *
 * Staff:    POST /auth/staff/login → (MFA) POST /auth/staff/mfa/verify
 * Patients: POST /auth/patient/otp → POST /auth/patient/otp/verify → (shared phone) POST /auth/patient/select
 * Both:     POST /auth/refresh (rotating), POST /auth/logout, GET/DELETE /auth/sessions
 */
@Controller("auth")
class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(AccessService) private readonly access: AccessService,
  ) {}

  // ---- staff ------------------------------------------------------------------

  @Public()
  @RateLimit({ name: "staff-login", limit: ipLimit(100), windowSec: 900 })
  @Post("staff/login")
  @HttpCode(200)
  login(@Body() body: unknown, @Req() req: Req) {
    const b = parse(z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) }), body);
    return this.auth.staffLogin(b.email, b.password, meta(req));
  }

  @Public()
  @RateLimit({ name: "staff-mfa", limit: ipLimit(100), windowSec: 900 })
  @Post("staff/mfa/verify")
  @HttpCode(200)
  mfaVerify(@Body() body: unknown, @Req() req: Req) {
    const b = parse(z.object({ challengeId: zId, code: zCode }), body);
    return this.auth.staffMfaVerify(b.challengeId, b.code, meta(req));
  }

  @Post("staff/mfa/enroll")
  mfaEnroll(@Staff() p: StaffPrincipal) {
    return this.auth.mfaEnroll(p);
  }

  @Post("staff/mfa/confirm")
  @HttpCode(200)
  mfaConfirm(@Staff() p: StaffPrincipal, @Body() body: unknown) {
    return this.auth.mfaConfirm(p, parse(z.object({ code: zCode }), body).code);
  }

  @Post("staff/mfa/disable")
  @HttpCode(200)
  mfaDisable(@Staff() p: StaffPrincipal, @Body() body: unknown) {
    return this.auth.mfaDisable(p, parse(z.object({ code: zCode }), body).code);
  }

  @RateLimit({ name: "password-change", limit: 10, windowSec: 900, by: "principal" })
  @Post("staff/password")
  @HttpCode(200)
  changePassword(@Staff() p: StaffPrincipal, @Body() body: unknown) {
    const b = parse(z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().min(1).max(200) }), body);
    return this.auth.changePassword(p, b.currentPassword, b.newPassword);
  }

  // ---- staff account administration --------------------------------------------

  /** Regional managers may administer staff in their region; platform admins anyone. */
  private async requireUserAdmin(p: Principal, userId: string) {
    const target = found(await db.orm.identity.User.select("id").first({ id: userId }), "User");
    if (await this.access.can(p, ADMIN)) return this.access.staff(p);
    const staff = await this.access.require(p, REGIONAL, undefined, "auth.admin");
    const myRegions = staff.assignments.filter((a) => a.role === "regional_ops_manager" && a.regionId).map((a) => a.regionId!);
    const regions = await this.access.regionDescendants(myRegions);
    const theirs = await db.orm.identity.RoleAssignment.select("role", "hubId", "regionId", "scopeType").where({ userId: target.id, status: "active" }).all();
    if (theirs.some((a) => a.scopeType === "platform" || a.role === "regional_ops_manager" || a.role === "clinical_ops_admin")) throw forbidden("Only a platform admin can administer this account");
    const hubIds = theirs.filter((a) => a.hubId).map((a) => a.hubId!);
    const hubs = hubIds.length ? await db.orm.hub.Hub.select("regionId").where((h) => h.id.in(hubIds)).all() : [];
    const inside = [...hubs.map((h) => h.regionId), ...theirs.filter((a) => a.regionId).map((a) => a.regionId!)];
    if (inside.length === 0 || !inside.every((r) => regions.includes(r))) throw forbidden("User is outside your region");
    return staff;
  }

  @Post("admin/users/:userId/temporary-password")
  async tempPassword(@Auth() p: Principal, @Param("userId") userId: string, @Body() body: unknown) {
    const staff = await this.requireUserAdmin(p, parse(zId, userId));
    if (staff.userId === userId) throw forbidden("Use the change-password endpoint for your own account");
    return this.auth.setTemporaryPassword(staff, userId, parse(z.object({ reason: zReason }), body).reason);
  }

  @Post("admin/users/:userId/unlock")
  @HttpCode(200)
  async unlock(@Auth() p: Principal, @Param("userId") userId: string, @Body() body: unknown) {
    const staff = await this.requireUserAdmin(p, parse(zId, userId));
    return this.auth.unlock(staff, userId, parse(z.object({ reason: zReason }), body).reason);
  }

  @Post("admin/users/:userId/mfa/reset")
  @HttpCode(200)
  async resetMfa(@Auth() p: Principal, @Param("userId") userId: string, @Body() body: unknown) {
    const staff = await this.access.require(p, ADMIN, undefined, "auth.mfa_reset");
    return this.auth.adminResetMfa(staff, parse(zId, userId), parse(z.object({ reason: zReason }), body).reason);
  }

  @Post("admin/users/:userId/revoke-sessions")
  @HttpCode(200)
  async revokeUserSessions(@Auth() p: Principal, @Param("userId") userId: string, @Body() body: unknown) {
    const staff = await this.requireUserAdmin(p, parse(zId, userId));
    await this.auth.revokeAllForUser(staff, userId, parse(z.object({ reason: zReason }), body).reason);
    return { revoked: true };
  }

  // ---- patients & caregivers ----------------------------------------------------

  @Public()
  @RateLimit({ name: "patient-otp", limit: ipLimit(60), windowSec: 900 })
  @Post("patient/otp")
  @HttpCode(202)
  otp(@Body() body: unknown, @Req() req: Req) {
    return this.auth.patientOtpRequest(parse(z.object({ phone: z.string().min(6).max(20) }), body).phone, meta(req));
  }

  @Public()
  @RateLimit({ name: "patient-otp-verify", limit: ipLimit(120), windowSec: 900 })
  @Post("patient/otp/verify")
  @HttpCode(200)
  otpVerify(@Body() body: unknown, @Req() req: Req) {
    const b = parse(z.object({ challengeId: zId, code: zCode }), body);
    return this.auth.patientOtpVerify(b.challengeId, b.code, meta(req));
  }

  @Public()
  @RateLimit({ name: "patient-select", limit: ipLimit(120), windowSec: 900 })
  @Post("patient/select")
  @HttpCode(200)
  select(@Body() body: unknown, @Req() req: Req) {
    const b = parse(z.object({ challengeId: zId, profileKey: z.string().regex(/^[0-9a-f-]{36}(:[0-9a-f-]{36})?$/i) }), body);
    return this.auth.patientSelect(b.challengeId, b.profileKey, meta(req));
  }

  // ---- sessions -------------------------------------------------------------------

  @Public()
  @RateLimit({ name: "refresh", limit: 60, windowSec: 300 })
  @Post("refresh")
  @HttpCode(200)
  refresh(@Body() body: unknown, @Req() req: Req) {
    return this.auth.refresh(parse(z.object({ refreshToken: z.string().min(20).max(200) }), body).refreshToken, meta(req));
  }

  @Post("logout")
  @HttpCode(204)
  async logout(@Auth() p: Principal, @Body() body: unknown) {
    await this.auth.logout(p, parse(z.object({ everywhere: z.boolean().default(false) }), body).everywhere);
  }

  @Get("sessions")
  sessions(@Auth() p: Principal) {
    return this.auth.listSessions(p);
  }

  @Delete("sessions/:id")
  @HttpCode(204)
  async revoke(@Auth() p: Principal, @Param("id") id: string) {
    await this.auth.revokeSession(p, parse(zId, id));
  }
}

@Module({ controllers: [AuthController], providers: [AuthService], exports: [AuthService] })
export class AuthModule {}
