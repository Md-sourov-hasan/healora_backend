import { Inject, Injectable, Logger } from "@nestjs/common";
import { or } from "@prisma/orm-postgres/orm-client";

import { AuditService } from "../../common/audit.service.ts";
import { signJwt } from "../../common/auth/jwt.ts";
import type { Principal, StaffPrincipal } from "../../common/auth/principal.ts";
import { db, type DbLike, nowIso, toDate } from "../../common/db.ts";
import { AppError, badRequest, conflict, forbidden, notFound, unauthorized } from "../../common/errors.ts";
import { rateLimiter } from "../../common/rate-limit.ts";
import { PRIVILEGED, type StaffRole } from "../../common/roles.ts";
import {
  decrypt,
  DUMMY_PASSWORD_HASH,
  encrypt,
  hashPassword,
  keyedHash,
  newRefreshToken,
  newTotpSecret,
  numericCode,
  otpauthUri,
  passwordProblems,
  safeEqualHex,
  sha256,
  temporaryPassword,
  verifyPassword,
  verifyTotp,
} from "./crypto.ts";

// ---- policy (env-configurable) -----------------------------------------------

const num = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};
const POLICY = {
  accessTtlSec: () => num("ACCESS_TOKEN_TTL_SEC", 15 * 60),
  staffIdleMin: () => num("STAFF_SESSION_IDLE_MIN", 30),
  staffMaxHours: () => num("STAFF_SESSION_MAX_HOURS", 12),
  patientIdleDays: () => num("PATIENT_SESSION_IDLE_DAYS", 30),
  patientMaxDays: () => num("PATIENT_SESSION_MAX_DAYS", 90),
  maxFailedLogins: () => num("MAX_FAILED_LOGINS", 5),
  lockMinutes: () => num("LOCKOUT_MINUTES", 15),
  otpTtlSec: () => num("OTP_TTL_SEC", 300),
  challengeAttempts: 5,
};

const addMs = (ms: number) => new Date(Date.now() + ms).toISOString();
const isPast = (ts: string | null | undefined) => {
  const d = toDate(ts ?? null);
  return d !== null && d.getTime() <= Date.now();
};

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
  deviceInstallationId?: string | null;
  correlationId?: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  tokenType: "Bearer";
  expiresIn: number;
  sessionId: string;
  refreshExpiresAt: string;
}

// ---- OTP delivery -------------------------------------------------------------

/** Plug an SMS gateway in here. The code must never be written to the DB in clear. */
export interface OtpSender {
  send(phone: string, code: string): Promise<void>;
}

class LogOtpSender implements OtpSender {
  private readonly logger = new Logger("OtpSender");
  async send(phone: string, code: string) {
    this.logger.log(`OTP sent to ***${phone.slice(-3)}`);
    // TEST HOOK (automated tests only): with OTP_TEST_SINK_FILE set outside
    // production, append "phone code" so end-to-end tests can complete OTP login.
    // Never active in production; codes are otherwise never persisted in clear.
    const sink = process.env.OTP_TEST_SINK_FILE;
    if (sink && process.env.NODE_ENV !== "production") {
      const { appendFile } = await import("node:fs/promises");
      await appendFile(sink, `${phone} ${code}\n`);
    }
  }
}

/** Bangladesh-centric phone normalisation to +880XXXXXXXXXX; also returns stored variants. */
export function phoneVariants(raw: string): { e164: string; variants: string[] } | null {
  const digits = raw.replace(/[^\d]/g, "");
  let national: string | null = null;
  if (digits.startsWith("880") && digits.length === 13) national = digits.slice(3);
  else if (digits.startsWith("0") && digits.length === 11) national = digits.slice(1);
  else if (digits.length === 10) national = digits;
  if (!national) {
    if (digits.length < 8 || digits.length > 15) return null;
    return { e164: `+${digits}`, variants: [raw, `+${digits}`, digits] };
  }
  return { e164: `+880${national}`, variants: [`+880${national}`, `880${national}`, `0${national}`, national, raw] };
}

const maskName = (name: string) => {
  const [first, ...rest] = name.trim().split(/\s+/);
  return [first, ...rest.map((r) => `${r[0] ?? ""}.`)].join(" ");
};

@Injectable()
export class AuthService {
  private readonly logger = new Logger("Auth");
  private otpSender: OtpSender = new LogOtpSender();

  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  setOtpSender(sender: OtpSender) {
    this.otpSender = sender;
  }

  // =========================================================================
  // Sessions
  // =========================================================================

  private async issue(
    tx: DbLike,
    subject: { kind: "staff"; userId: string; mustChangePassword?: boolean } | { kind: "patient"; patientId: string; representativeId?: string | null },
    amr: string[],
    meta: RequestMeta,
    familyId?: string,
  ): Promise<TokenPair> {
    const refreshToken = newRefreshToken();
    const staff = subject.kind === "staff";
    const idleMs = staff ? POLICY.staffIdleMin() * 60_000 : POLICY.patientIdleDays() * 86_400_000;
    const maxMs = staff ? POLICY.staffMaxHours() * 3_600_000 : POLICY.patientMaxDays() * 86_400_000;
    const session = await tx.orm.identity.AuthSession.create({
      subjectKind: subject.kind,
      userId: staff ? subject.userId : null,
      patientId: staff ? null : subject.patientId,
      representativeId: staff ? null : (subject.representativeId ?? null),
      familyId: familyId ?? crypto.randomUUID(),
      refreshTokenHash: sha256(refreshToken),
      amr,
      ip: meta.ip,
      userAgent: meta.userAgent?.slice(0, 300) ?? null,
      deviceInstallationId: meta.deviceInstallationId ?? null,
      lastUsedAt: nowIso(),
      idleExpiresAt: addMs(Math.min(idleMs, maxMs)),
      absoluteExpiresAt: addMs(maxMs),
    });
    const accessToken = signJwt(
      staff
        ? { sub: subject.userId, typ: "staff", amr, sid: session.id, ...(subject.mustChangePassword ? { pcr: true } : {}) }
        : { sub: subject.patientId, typ: "patient", amr, sid: session.id, ...(subject.representativeId ? { rep: subject.representativeId } : {}) },
      POLICY.accessTtlSec(),
    );
    return { accessToken, refreshToken, tokenType: "Bearer", expiresIn: POLICY.accessTtlSec(), sessionId: session.id, refreshExpiresAt: session.idleExpiresAt };
  }

  /**
   * Rotate a refresh token. Presenting an already-rotated token is treated as
   * theft: the whole session family is revoked (OAuth 2.0 BCP reuse detection).
   */
  async refresh(refreshToken: string, meta: RequestMeta): Promise<TokenPair> {
    const hash = sha256(refreshToken);
    // Revocations must COMMIT before we reject, so denials are returned, not thrown, inside the tx.
    let denial: string | null = null;
    const result = await db.transaction(async (tx): Promise<TokenPair | null> => {
      const session = await tx.orm.identity.AuthSession.where({ refreshTokenHash: hash }).forNoKeyUpdate().first();
      if (!session) {
        const reused = await tx.orm.identity.AuthSession.where({ previousTokenHash: hash }).first();
        if (reused) {
          await tx.orm.identity.AuthSession.where({ familyId: reused.familyId })
            .where((s) => s.revokedAt.isNull())
            .updateAll({ revokedAt: nowIso(), revokeReason: "refresh_token_reuse" });
          await this.audit.record(
            null,
            { action: "auth.refresh_reuse_detected", targetType: "auth_session", targetId: reused.id, outcome: "denied", priority: "high", metadata: { ip: meta.ip } },
            tx,
          );
        }
        denial = "Invalid refresh token";
        return null;
      }
      if (session.revokedAt || isPast(session.idleExpiresAt) || isPast(session.absoluteExpiresAt)) throw unauthorized("Session expired");

      let mustChangePassword = false;
      if (session.subjectKind === "staff") {
        const user = await tx.orm.identity.User.select("status").first({ id: session.userId! });
        if (!user || user.status !== "active") {
          await tx.orm.identity.AuthSession.where({ id: session.id }).update({ revokedAt: nowIso(), revokeReason: "account_inactive" });
          denial = "Account is not active";
          return null;
        }
        const login = await tx.orm.identity.StaffLogin.select("mustChangePassword").first({ userId: session.userId! });
        mustChangePassword = login?.mustChangePassword ?? false;
      } else {
        const patient = await tx.orm.clinical.Patient.select("status").first({ id: session.patientId! });
        if (!patient || patient.status !== "active") throw unauthorized("Patient account is not active");
        if (session.representativeId && !(await this.representativeValid(tx, session.representativeId, session.patientId!))) {
          await tx.orm.identity.AuthSession.where({ id: session.id }).update({ revokedAt: nowIso(), revokeReason: "representative_invalid" });
          denial = "Caregiver authority is no longer valid";
          return null;
        }
      }

      const next = newRefreshToken();
      const staff = session.subjectKind === "staff";
      const idleMs = staff ? POLICY.staffIdleMin() * 60_000 : POLICY.patientIdleDays() * 86_400_000;
      const absolute = toDate(session.absoluteExpiresAt)!.getTime();
      const idleExpiresAt = new Date(Math.min(Date.now() + idleMs, absolute)).toISOString();
      await tx.orm.identity.AuthSession.where({ id: session.id }).update({
        refreshTokenHash: sha256(next),
        previousTokenHash: hash,
        lastUsedAt: nowIso(),
        idleExpiresAt,
        ip: meta.ip,
      });
      const amr = [...session.amr];
      const accessToken = signJwt(
        staff
          ? { sub: session.userId!, typ: "staff", amr, sid: session.id, ...(mustChangePassword ? { pcr: true } : {}) }
          : { sub: session.patientId!, typ: "patient", amr, sid: session.id, ...(session.representativeId ? { rep: session.representativeId } : {}) },
        POLICY.accessTtlSec(),
      );
      return { accessToken, refreshToken: next, tokenType: "Bearer" as const, expiresIn: POLICY.accessTtlSec(), sessionId: session.id, refreshExpiresAt: idleExpiresAt };
    });
    if (!result) throw unauthorized(denial ?? "Invalid refresh token");
    return result;
  }

  async logout(p: Principal, everywhere: boolean) {
    const now = nowIso();
    if (everywhere) {
      if (p.kind === "staff") {
        await db.orm.identity.AuthSession.where({ userId: p.userId }).where((s) => s.revokedAt.isNull()).updateAll({ revokedAt: now, revokeReason: "logout_all" });
      } else {
        await db.orm.identity.AuthSession.where({ patientId: p.patientId }).where((s) => s.revokedAt.isNull()).updateAll({ revokedAt: now, revokeReason: "logout_all" });
      }
    } else if (p.authSessionId) {
      await db.orm.identity.AuthSession.where({ id: p.authSessionId }).where((s) => s.revokedAt.isNull()).updateAll({ revokedAt: now, revokeReason: "logout" });
    }
    await this.audit.record(p, { action: everywhere ? "auth.logout_all" : "auth.logout", targetType: "auth_session", targetId: p.authSessionId });
  }

  async listSessions(p: Principal) {
    const base =
      p.kind === "staff"
        ? db.orm.identity.AuthSession.where({ userId: p.userId })
        : db.orm.identity.AuthSession.where({ patientId: p.patientId });
    const rows = await base
      .select("id", "createdAt", "lastUsedAt", "idleExpiresAt", "absoluteExpiresAt", "ip", "userAgent", "amr", "representativeId")
      .where((s) => s.revokedAt.isNull())
      .orderBy((s) => s.lastUsedAt.desc())
      .limit(50)
      .all();
    return rows.filter((r) => !isPast(r.idleExpiresAt) && !isPast(r.absoluteExpiresAt)).map((r) => ({ ...r, current: r.id === p.authSessionId }));
  }

  async revokeSession(p: Principal, sessionId: string) {
    const s = await db.orm.identity.AuthSession.first({ id: sessionId });
    const mine = s && (p.kind === "staff" ? s.userId === p.userId : s.patientId === p.patientId);
    if (!s || !mine) throw notFound("Session");
    await db.orm.identity.AuthSession.where({ id: sessionId }).update({ revokedAt: nowIso(), revokeReason: "revoked_by_owner" });
    await this.audit.record(p, { action: "auth.session_revoked", targetType: "auth_session", targetId: sessionId });
  }

  async revokeAllForUser(actor: StaffPrincipal, userId: string, reason: string, tx: DbLike = db) {
    await tx.orm.identity.AuthSession.where({ userId }).where((s) => s.revokedAt.isNull()).updateAll({ revokedAt: nowIso(), revokeReason: reason.slice(0, 200) });
    await this.audit.record(actor, { action: "auth.sessions_revoked_by_admin", targetType: "user", targetId: userId, reason, priority: "high" }, tx);
  }

  // =========================================================================
  // Staff: password + TOTP
  // =========================================================================

  async staffLogin(emailRaw: string, password: string, meta: RequestMeta) {
    const email = emailRaw.trim().toLowerCase();
    rateLimiter.consume(`login-email:${email}`, 10, 15 * 60_000);

    const user = await db.orm.identity.User.select("id", "email", "status").where({ email }).first();
    const login = user ? await db.orm.identity.StaffLogin.first({ userId: user.id }) : null;
    const ok = await verifyPassword(password, login?.passwordHash ?? DUMMY_PASSWORD_HASH);

    const fail = async (why: string) => {
      await this.audit.record(null, { action: "auth.login_failed", targetType: "user", targetId: user?.id ?? null, outcome: "denied", metadata: { why, ip: meta.ip } });
      // One generic message: no account / locked / wrong password are indistinguishable to the caller.
      throw new AppError(401, "INVALID_CREDENTIALS", "Invalid email or password, or the account is locked");
    };

    if (!user || !login) return fail("unknown_account");
    if (user.status !== "active") return fail("inactive");
    if (login.lockedUntil && !isPast(login.lockedUntil)) return fail("locked");
    if (!ok) {
      const attempts = login.failedAttempts + 1;
      const lock = attempts >= POLICY.maxFailedLogins();
      const lockMinutes = POLICY.lockMinutes() * 2 ** Math.max(0, attempts - POLICY.maxFailedLogins());
      await db.orm.identity.StaffLogin.where({ userId: user.id }).update({
        failedAttempts: attempts,
        lastFailedAt: nowIso(),
        lockedUntil: lock ? addMs(Math.min(lockMinutes, 24 * 60) * 60_000) : null,
      });
      if (lock) await this.audit.record(null, { action: "auth.account_locked", targetType: "user", targetId: user.id, priority: "high", outcome: "denied" });
      return fail("bad_password");
    }

    await db.orm.identity.StaffLogin.where({ userId: user.id }).update({ failedAttempts: 0, lockedUntil: null });
    const factor = await db.orm.identity.MfaFactor.where({ userId: user.id })
      .where((f) => f.confirmedAt.isNotNull())
      .where((f) => f.disabledAt.isNull())
      .first();

    if (factor) {
      const challenge = await db.orm.identity.LoginChallenge.create({
        kind: "staff_mfa",
        userId: user.id,
        patientIds: [],
        expiresAt: addMs(POLICY.otpTtlSec() * 1000),
        ip: meta.ip,
      });
      return { mfaRequired: true as const, challengeId: challenge.id, expiresIn: POLICY.otpTtlSec() };
    }

    const roles = await this.activeRoles(user.id);
    const tokens = await db.transaction(async (tx) => {
      await tx.orm.identity.StaffLogin.where({ userId: user.id }).update({ lastLoginAt: nowIso() });
      await tx.orm.identity.User.where({ id: user.id }).update({ lastLoginAt: nowIso() });
      await this.audit.record(null, { action: "auth.login", targetType: "user", targetId: user.id, metadata: { amr: ["pwd"], ip: meta.ip } }, tx);
      return this.issue(tx, { kind: "staff", userId: user.id, mustChangePassword: login.mustChangePassword }, ["pwd"], meta);
    });
    return {
      mfaRequired: false as const,
      ...tokens,
      passwordChangeRequired: login.mustChangePassword,
      mfaEnrollmentRequired: roles.some((r) => PRIVILEGED.includes(r)),
    };
  }

  async staffMfaVerify(challengeId: string, code: string, meta: RequestMeta) {
    rateLimiter.consume(`mfa:${challengeId}`, 10, 15 * 60_000);
    return db.transaction(async (tx) => {
      const ch = await tx.orm.identity.LoginChallenge.where({ id: challengeId, kind: "staff_mfa" }).forNoKeyUpdate().first();
      if (!ch || ch.consumedAt || isPast(ch.expiresAt) || ch.attempts >= POLICY.challengeAttempts || !ch.userId) throw unauthorized("Challenge expired; sign in again");
      const factor = await tx.orm.identity.MfaFactor.where({ userId: ch.userId })
        .where((f) => f.confirmedAt.isNotNull())
        .where((f) => f.disabledAt.isNull())
        .forNoKeyUpdate()
        .first();
      const step = factor ? verifyTotp(decrypt(factor.secretEncrypted), code, factor.lastUsedStep) : null;
      if (!factor || step === null) {
        await tx.orm.identity.LoginChallenge.where({ id: ch.id }).update({ attempts: ch.attempts + 1 });
        await this.audit.record(null, { action: "auth.mfa_failed", targetType: "user", targetId: ch.userId, outcome: "denied" }, tx);
        throw new AppError(401, "INVALID_CODE", "Invalid verification code");
      }
      await tx.orm.identity.MfaFactor.where({ id: factor.id }).update({ lastUsedStep: step });
      await tx.orm.identity.LoginChallenge.where({ id: ch.id }).update({ consumedAt: nowIso() });
      const login = await tx.orm.identity.StaffLogin.first({ userId: ch.userId });
      await tx.orm.identity.StaffLogin.where({ userId: ch.userId }).update({ lastLoginAt: nowIso() });
      await tx.orm.identity.User.where({ id: ch.userId }).update({ lastLoginAt: nowIso() });
      await this.audit.record(null, { action: "auth.login", targetType: "user", targetId: ch.userId, metadata: { amr: ["pwd", "otp"], ip: meta.ip } }, tx);
      const tokens = await this.issue(tx, { kind: "staff", userId: ch.userId, mustChangePassword: login?.mustChangePassword ?? false }, ["pwd", "otp"], meta);
      return { ...tokens, passwordChangeRequired: login?.mustChangePassword ?? false };
    });
  }

  async mfaEnroll(p: StaffPrincipal) {
    const user = await db.orm.identity.User.select("email").first({ id: p.userId });
    if (!user) throw notFound("User");
    const existing = await db.orm.identity.MfaFactor.where({ userId: p.userId })
      .where((f) => f.confirmedAt.isNotNull())
      .where((f) => f.disabledAt.isNull())
      .first();
    if (existing) throw conflict("MFA_ALREADY_ENABLED", "An authenticator is already enrolled");
    await db.orm.identity.MfaFactor.where({ userId: p.userId }).where((f) => f.confirmedAt.isNull()).deleteAll();
    const secret = newTotpSecret();
    const factor = await db.orm.identity.MfaFactor.create({ userId: p.userId, secretEncrypted: encrypt(secret) });
    await this.audit.record(p, { action: "auth.mfa_enroll_started", targetType: "mfa_factor", targetId: factor.id });
    // The secret is shown once, here, and never again.
    return { factorId: factor.id, secret, otpauthUri: otpauthUri(secret, user.email) };
  }

  async mfaConfirm(p: StaffPrincipal, code: string) {
    return db.transaction(async (tx) => {
      const factor = await tx.orm.identity.MfaFactor.where({ userId: p.userId })
        .where((f) => f.confirmedAt.isNull())
        .where((f) => f.disabledAt.isNull())
        .orderBy((f) => f.createdAt.desc())
        .forNoKeyUpdate()
        .first();
      if (!factor) throw notFound("Pending authenticator enrolment");
      const step = verifyTotp(decrypt(factor.secretEncrypted), code, null);
      if (step === null) throw new AppError(400, "INVALID_CODE", "Invalid verification code");
      await tx.orm.identity.MfaFactor.where({ id: factor.id }).update({ confirmedAt: nowIso(), lastUsedStep: step });
      await tx.orm.identity.User.where({ id: p.userId }).update({ mfaEnabled: true });
      await this.audit.record(p, { action: "auth.mfa_enabled", targetType: "mfa_factor", targetId: factor.id, priority: "high" }, tx);
      return { enabled: true };
    });
  }

  async mfaDisable(p: StaffPrincipal, code: string) {
    if (p.assignments.some((a) => PRIVILEGED.includes(a.role))) throw forbidden("Privileged roles must keep MFA enabled; ask a platform admin to reset it", "MFA_REQUIRED");
    return db.transaction(async (tx) => {
      const factor = await tx.orm.identity.MfaFactor.where({ userId: p.userId })
        .where((f) => f.confirmedAt.isNotNull())
        .where((f) => f.disabledAt.isNull())
        .forNoKeyUpdate()
        .first();
      if (!factor) throw notFound("Authenticator");
      if (verifyTotp(decrypt(factor.secretEncrypted), code, factor.lastUsedStep) === null) throw new AppError(400, "INVALID_CODE", "Invalid verification code");
      await tx.orm.identity.MfaFactor.where({ id: factor.id }).update({ disabledAt: nowIso() });
      await tx.orm.identity.User.where({ id: p.userId }).update({ mfaEnabled: false });
      await this.audit.record(p, { action: "auth.mfa_disabled", targetType: "mfa_factor", targetId: factor.id, priority: "high" }, tx);
      return { enabled: false };
    });
  }

  async adminResetMfa(actor: StaffPrincipal, userId: string, reason: string) {
    return db.transaction(async (tx) => {
      await tx.orm.identity.MfaFactor.where({ userId }).where((f) => f.disabledAt.isNull()).updateAll({ disabledAt: nowIso() });
      await tx.orm.identity.User.where({ id: userId }).update({ mfaEnabled: false });
      await this.revokeAllForUser(actor, userId, "mfa_reset", tx);
      await this.audit.record(actor, { action: "auth.mfa_reset_by_admin", targetType: "user", targetId: userId, reason, priority: "high" }, tx);
      return { reset: true };
    });
  }

  async changePassword(p: StaffPrincipal, current: string, next: string) {
    const user = await db.orm.identity.User.select("email").first({ id: p.userId });
    const login = await db.orm.identity.StaffLogin.first({ userId: p.userId });
    if (!user || !login || !(await verifyPassword(current, login.passwordHash))) throw new AppError(400, "INVALID_CREDENTIALS", "Current password is incorrect");
    const problems = passwordProblems(next, user.email);
    if (problems.length) throw badRequest("WEAK_PASSWORD", "Password does not meet the policy", problems);
    if (await verifyPassword(next, login.passwordHash)) throw badRequest("WEAK_PASSWORD", "New password must differ from the current one");
    const hash = await hashPassword(next);
    await db.transaction(async (tx) => {
      await tx.orm.identity.StaffLogin.where({ userId: p.userId }).update({ passwordHash: hash, passwordUpdatedAt: nowIso(), mustChangePassword: false });
      // Sign out every other session; keep the current one.
      await tx.orm.identity.AuthSession.where({ userId: p.userId })
        .where((s) => s.revokedAt.isNull())
        .where((s) => (p.authSessionId ? s.id.neq(p.authSessionId) : s.id.isNotNull()))
        .updateAll({ revokedAt: nowIso(), revokeReason: "password_changed" });
      await this.audit.record(p, { action: "auth.password_changed", targetType: "user", targetId: p.userId, priority: "high" }, tx);
    });
    return { changed: true, note: "Refresh your token to drop the password-change restriction." };
  }

  /** Admin-issued one-time temporary password (shown once). Revokes sessions. */
  async setTemporaryPassword(actor: StaffPrincipal, userId: string, reason: string) {
    const user = await db.orm.identity.User.select("id", "status").first({ id: userId });
    if (!user) throw notFound("User");
    const temp = temporaryPassword();
    const hash = await hashPassword(temp);
    await db.transaction(async (tx) => {
      const existing = await tx.orm.identity.StaffLogin.first({ userId });
      if (existing) {
        await tx.orm.identity.StaffLogin.where({ userId }).update({ passwordHash: hash, passwordUpdatedAt: nowIso(), mustChangePassword: true, failedAttempts: 0, lockedUntil: null });
      } else {
        await tx.orm.identity.StaffLogin.create({ userId, passwordHash: hash, passwordUpdatedAt: nowIso(), mustChangePassword: true });
      }
      await this.revokeAllForUser(actor, userId, "temporary_password_issued", tx);
      await this.audit.record(actor, { action: "auth.temporary_password_issued", targetType: "user", targetId: userId, reason, priority: "high" }, tx);
    });
    return { temporaryPassword: temp, mustChangePassword: true };
  }

  async unlock(actor: StaffPrincipal, userId: string, reason: string) {
    await db.orm.identity.StaffLogin.where({ userId }).update({ failedAttempts: 0, lockedUntil: null });
    await this.audit.record(actor, { action: "auth.account_unlocked", targetType: "user", targetId: userId, reason, priority: "high" });
    return { unlocked: true };
  }

  private async activeRoles(userId: string): Promise<StaffRole[]> {
    const now = nowIso();
    const rows = await db.orm.identity.RoleAssignment.select("role")
      .where({ userId, status: "active" })
      .where((r) => r.validFrom.lte(now))
      .where((r) => or(r.validTo.isNull(), r.validTo.gt(now)))
      .all();
    return rows.map((r) => r.role as StaffRole);
  }

  // =========================================================================
  // Patients & caregivers: phone OTP
  // =========================================================================

  /**
   * Always answers the same way whether or not the phone is known
   * (no account enumeration). Shared family phones are supported: one phone may
   * map to several patients and to caregivers acting for patients.
   */
  async patientOtpRequest(phoneRaw: string, meta: RequestMeta) {
    const phone = phoneVariants(phoneRaw);
    if (!phone) throw badRequest("INVALID_PHONE", "Invalid phone number");
    rateLimiter.consume(`otp-phone:${phone.e164}`, 3, 15 * 60_000);

    const candidates = await this.candidatesForPhone(phone.variants);
    const code = numericCode(6);
    const challenge = await db.orm.identity.LoginChallenge.create({
      kind: "patient_otp",
      phoneHash: keyedHash(phone.e164),
      codeHash: "pending",
      patientIds: candidates,
      expiresAt: addMs(POLICY.otpTtlSec() * 1000),
      ip: meta.ip,
    });
    await db.orm.identity.LoginChallenge.where({ id: challenge.id }).update({ codeHash: keyedHash(`${challenge.id}:${code}`) });
    if (candidates.length) await this.otpSender.send(phone.e164, code);
    const dev = process.env.AUTH_DEV_TOKENS === "true" && process.env.NODE_ENV !== "production";
    return { challengeId: challenge.id, expiresIn: POLICY.otpTtlSec(), ...(dev && candidates.length ? { devCode: code } : {}) };
  }

  async patientOtpVerify(challengeId: string, code: string, meta: RequestMeta) {
    rateLimiter.consume(`otp-verify:${challengeId}`, 10, 15 * 60_000);
    return db.transaction(async (tx) => {
      const ch = await tx.orm.identity.LoginChallenge.where({ id: challengeId, kind: "patient_otp" }).forNoKeyUpdate().first();
      if (!ch || ch.consumedAt || isPast(ch.expiresAt) || ch.attempts >= POLICY.challengeAttempts) throw unauthorized("Code expired; request a new one");
      const good = /^\d{6}$/.test(code) && ch.codeHash !== null && safeEqualHex(keyedHash(`${ch.id}:${code}`), ch.codeHash);
      if (!good || ch.patientIds.length === 0) {
        await tx.orm.identity.LoginChallenge.where({ id: ch.id }).update({ attempts: ch.attempts + 1 });
        throw new AppError(401, "INVALID_CODE", "Invalid code");
      }
      await tx.orm.identity.LoginChallenge.where({ id: ch.id }).update({ consumedAt: nowIso() });

      // Phone ownership is now proven for direct patient matches.
      const direct = ch.patientIds.filter((x) => !x.includes(":"));
      if (direct.length) {
        await tx.orm.clinical.Patient.where((pt) => pt.id.in(direct))
          .where((pt) => pt.phoneVerifiedAt.isNull())
          .updateAll({ phoneVerifiedAt: nowIso() });
      }

      if (ch.patientIds.length === 1) {
        const [patientId, representativeId] = ch.patientIds[0]!.split(":") as [string, string | undefined];
        await this.audit.record(null, { action: "auth.patient_login", targetType: "patient", targetId: patientId, patientId, metadata: { representative: Boolean(representativeId) } }, tx);
        return { selectionRequired: false as const, ...(await this.issue(tx, { kind: "patient", patientId, representativeId: representativeId ?? null }, ["otp"], meta)) };
      }

      const select = await tx.orm.identity.LoginChallenge.create({
        kind: "patient_select",
        patientIds: ch.patientIds,
        expiresAt: addMs(POLICY.otpTtlSec() * 1000),
        ip: meta.ip,
      });
      return { selectionRequired: true as const, challengeId: select.id, profiles: await this.describeProfiles(tx, [...ch.patientIds]) };
    });
  }

  async patientSelect(challengeId: string, profileKey: string, meta: RequestMeta) {
    return db.transaction(async (tx) => {
      const ch = await tx.orm.identity.LoginChallenge.where({ id: challengeId, kind: "patient_select" }).forNoKeyUpdate().first();
      if (!ch || ch.consumedAt || isPast(ch.expiresAt)) throw unauthorized("Selection expired; sign in again");
      if (!ch.patientIds.includes(profileKey)) throw forbidden("Profile not available for this sign-in");
      await tx.orm.identity.LoginChallenge.where({ id: ch.id }).update({ consumedAt: nowIso() });
      const [patientId, representativeId] = profileKey.split(":") as [string, string | undefined];
      if (representativeId && !(await this.representativeValid(tx, representativeId, patientId))) throw forbidden("Caregiver authority is not valid");
      await this.audit.record(null, { action: "auth.patient_login", targetType: "patient", targetId: patientId, patientId, metadata: { representative: Boolean(representativeId) } }, tx);
      return this.issue(tx, { kind: "patient", patientId, representativeId: representativeId ?? null }, ["otp"], meta);
    });
  }

  /** "patientId" for self, "patientId:representativeId" for caregiver access. */
  private async candidatesForPhone(variants: string[]): Promise<string[]> {
    const self = await db.orm.clinical.Patient.select("id")
      .where({ status: "active" })
      .where((pt) => pt.phone.in(variants))
      .limit(10)
      .all();
    const now = nowIso();
    const reps = await db.orm.clinical.PatientRepresentative.select("id", "patientId")
      .where((r) => r.phone.in(variants))
      .where((r) => r.revokedAt.isNull())
      .where((r) => r.verifiedAt.isNotNull())
      .where((r) => r.validFrom.lte(now))
      .where((r) => or(r.validTo.isNull(), r.validTo.gt(now)))
      .limit(10)
      .all();
    return [...self.map((s) => s.id), ...reps.map((r) => `${r.patientId}:${r.id}`)];
  }

  private async describeProfiles(tx: DbLike, keys: readonly string[]) {
    const ids = [...new Set(keys.map((k) => k.split(":")[0]!))];
    const patients = await tx.orm.clinical.Patient.select("id", "fullName", "healoraCode").where((pt) => pt.id.in(ids)).all();
    const byId = new Map(patients.map((p) => [p.id, p]));
    return keys.map((key) => {
      const [pid, rep] = key.split(":");
      const pt = byId.get(pid!);
      return { profileKey: key, displayName: pt ? maskName(pt.fullName) : "Patient", codeSuffix: pt?.healoraCode.slice(-4) ?? null, actingAsCaregiver: Boolean(rep) };
    });
  }

  async representativeValid(tx: DbLike, representativeId: string, patientId: string): Promise<boolean> {
    const now = nowIso();
    const rep = await tx.orm.clinical.PatientRepresentative.where({ id: representativeId, patientId })
      .where((r) => r.revokedAt.isNull())
      .where((r) => r.verifiedAt.isNotNull())
      .where((r) => r.validFrom.lte(now))
      .where((r) => or(r.validTo.isNull(), r.validTo.gt(now)))
      .first();
    return rep !== null;
  }
}
