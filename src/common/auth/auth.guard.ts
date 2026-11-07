import { randomUUID } from "node:crypto";

import { type CanActivate, type ExecutionContext, Inject, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { or } from "@prisma/orm-postgres/orm-client";

import { db, nowIso, toDate } from "../db.ts";
import { forbidden, unauthorized } from "../errors.ts";
import type { StaffRole } from "../roles.ts";
import { IS_PUBLIC } from "./decorators.ts";
import { verifyJwt } from "./jwt.ts";
import type { ActiveAssignment, Principal } from "./principal.ts";

/**
 * Global guard: verifies the bearer token and loads the caller's *current*
 * role assignments on every request, so a revoked assignment loses access
 * immediately (PRD §6.4). Authorisation itself is done by AccessService.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()]);

    const header: string | undefined = req.headers?.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    if (!token) {
      if (isPublic) return true;
      throw unauthorized();
    }
    const claims = verifyJwt(token);
    if (!claims) {
      if (isPublic) return true;
      throw unauthorized("Invalid or expired token");
    }

    // Every real token is bound to a live AuthSession: logout, admin revocation,
    // refresh-token reuse and idle timeout take effect within one request.
    // Session-less tokens exist only from the dev token endpoint.
    const devTokensAllowed = process.env.AUTH_DEV_TOKENS === "true" && process.env.NODE_ENV !== "production";
    if (claims.sid) {
      const session = await db.orm.identity.AuthSession.select("revokedAt", "idleExpiresAt", "absoluteExpiresAt", "userId", "patientId").first({ id: claims.sid });
      const now = Date.now();
      const live =
        session !== null &&
        session.revokedAt === null &&
        (toDate(session.idleExpiresAt)?.getTime() ?? 0) > now &&
        (toDate(session.absoluteExpiresAt)?.getTime() ?? 0) > now &&
        (claims.typ === "staff" ? session.userId === claims.sub : session.patientId === claims.sub);
      if (!live) throw unauthorized("Session has ended; sign in again");
    } else if (!devTokensAllowed) {
      throw unauthorized("Invalid or expired token");
    }

    // A temporary password must be replaced before anything else is reachable.
    if (claims.pcr) {
      const path: string = req.path ?? req.url ?? "";
      if (!/^\/api\/v1\/(auth\/|me$)/.test(path)) throw forbidden("Change your temporary password first", "PASSWORD_CHANGE_REQUIRED");
    }

    const meta = {
      ip: (req.headers["x-forwarded-for"]?.split(",")[0]?.trim() as string | undefined) ?? req.ip ?? null,
      userAgent: (req.headers["user-agent"] as string | undefined) ?? null,
      correlationId: (req.headers["x-correlation-id"] as string | undefined) ?? randomUUID(),
      authSessionId: claims.sid ?? null,
      deviceInstallationId: (req.headers["x-device-id"] as string | undefined) ?? null,
      strongAuth: Boolean(claims.amr?.some((m) => m === "otp" || m === "mfa")),
    };

    let principal: Principal;
    if (claims.typ === "staff") {
      const user = await db.orm.identity.User.select("id", "name", "status").first({ id: claims.sub });
      if (!user || user.status !== "active") throw unauthorized("Account is not active");
      const now = nowIso();
      const rows = await db.orm.identity.RoleAssignment.select("id", "role", "scopeType", "regionId", "hubId", "sessionId")
        .where({ userId: user.id, status: "active" })
        .where((r) => r.validFrom.lte(now))
        .where((r) => or(r.validTo.isNull(), r.validTo.gt(now)))
        .all();
      principal = {
        kind: "staff",
        userId: user.id,
        name: user.name,
        assignments: rows.map((r) => ({ ...r, role: r.role as StaffRole }) as ActiveAssignment),
        ...meta,
      };
    } else {
      const patient = await db.orm.clinical.Patient.select("id", "status").first({ id: claims.sub });
      if (!patient || patient.status !== "active") throw unauthorized("Patient account is not active");
      principal = { kind: "patient", patientId: patient.id, representativeId: claims.rep ?? null, ...meta };
    }
    req.principal = principal;
    return true;
  }
}
