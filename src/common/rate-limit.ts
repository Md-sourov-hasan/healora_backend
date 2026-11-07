import {
  type CanActivate,
  type ExecutionContext,
  HttpStatus,
  Inject,
  Injectable,
  SetMetadata,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";

import { AppError } from "./errors.ts";

/**
 * Fixed-window rate limiter (PRD §16.1: rate-limit authentication and
 * patient-lookup endpoints). In-memory per process — put a shared store
 * (Redis) behind `RateLimiter` when running more than one instance.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();
  private lastSweep = Date.now();

  /** Returns remaining requests, or throws 429 when the limit is exceeded. */
  consume(key: string, limit: number, windowMs: number): number {
    const now = Date.now();
    if (now - this.lastSweep > 60_000) this.sweep(now);
    const b = this.buckets.get(key);
    if (!b || b.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + windowMs });
      return limit - 1;
    }
    b.count += 1;
    if (b.count > limit) {
      const retryAfter = Math.ceil((b.resetAt - now) / 1000);
      throw new AppError(HttpStatus.TOO_MANY_REQUESTS, "RATE_LIMITED", `Too many requests. Retry in ${retryAfter}s`, { retryAfter });
    }
    return limit - b.count;
  }

  reset(key: string) {
    this.buckets.delete(key);
  }

  private sweep(now: number) {
    for (const [k, v] of this.buckets) if (v.resetAt <= now) this.buckets.delete(k);
    this.lastSweep = now;
  }
}

export const rateLimiter = new RateLimiter();

export interface RateLimitOptions {
  /** Bucket name, e.g. "patient-lookup". */
  name: string;
  limit: number;
  windowSec: number;
  /** Key requests by IP (default), principal, or both. */
  by?: "ip" | "principal" | "ip+principal";
}

const RATE_LIMIT = "healora:rateLimit";
export const RateLimit = (opts: RateLimitOptions) => SetMetadata(RATE_LIMIT, opts);

/** Global guard; only acts on handlers decorated with `@RateLimit(...)`. Runs after AuthGuard. */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const opts = this.reflector.getAllAndOverride<RateLimitOptions | undefined>(RATE_LIMIT, [ctx.getHandler(), ctx.getClass()]);
    if (!opts) return true;
    const req = ctx.switchToHttp().getRequest();
    const ip = (req.headers["x-forwarded-for"]?.split(",")[0]?.trim() as string | undefined) ?? req.ip ?? "unknown";
    const who = req.principal ? (req.principal.kind === "staff" ? req.principal.userId : req.principal.patientId) : "anon";
    const by = opts.by ?? "ip";
    const key = `${opts.name}:${by === "ip" ? ip : by === "principal" ? who : `${ip}:${who}`}`;
    const remaining = rateLimiter.consume(key, opts.limit, opts.windowSec * 1000);
    ctx.switchToHttp().getResponse().setHeader("X-RateLimit-Remaining", String(remaining));
    return true;
  }
}
