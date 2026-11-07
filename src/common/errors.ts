import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import { ZodError } from "zod";

/** Domain error with a stable machine-readable code. */
export class AppError extends HttpException {
  constructor(
    status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super({ code, message, details }, status);
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new AppError(HttpStatus.BAD_REQUEST, code, message, details);
export const unauthorized = (message = "Authentication required") =>
  new AppError(HttpStatus.UNAUTHORIZED, "AUTH_REQUIRED", message);
export const forbidden = (message = "You do not have permission for this action", code = "FORBIDDEN") =>
  new AppError(HttpStatus.FORBIDDEN, code, message);
export const notFound = (entity: string) =>
  new AppError(HttpStatus.NOT_FOUND, "NOT_FOUND", `${entity} not found`);
export const conflict = (code: string, message: string, details?: unknown) =>
  new AppError(HttpStatus.CONFLICT, code, message, details);
export const unprocessable = (code: string, message: string, details?: unknown) =>
  new AppError(HttpStatus.UNPROCESSABLE_ENTITY, code, message, details);

/** Throw 404 when a lookup returned null. */
export function found<T>(value: T | null | undefined, entity: string): T {
  if (value === null || value === undefined) throw notFound(entity);
  return value;
}

type PgLikeError = { sqlState?: string; constraint?: string; detail?: string; code?: string; message?: string };

/**
 * Maps every error to a JSON envelope `{ code, message, details? }`.
 * Database constraint violations become 409/422 without leaking SQL or values.
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger("Http");

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    const send = (status: number, body: Record<string, unknown>) => res.status(status).json(body);

    if (exception instanceof ZodError) {
      return send(400, {
        code: "VALIDATION_FAILED",
        message: "Request validation failed",
        details: exception.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      const status = exception.getStatus();
      if (typeof body === "object" && body !== null && "code" in body) return send(status, body as Record<string, unknown>);
      const message = typeof body === "string" ? body : ((body as { message?: unknown }).message ?? exception.message);
      return send(status, { code: HttpStatus[status] ?? "ERROR", message });
    }

    const err = (exception ?? {}) as PgLikeError;
    const constraint = err.constraint?.replace(/_[0-9a-f]{8}$/, "");
    switch (err.sqlState) {
      case "23505":
        return send(409, { code: "DUPLICATE", message: "A record with these values already exists", details: { constraint } });
      case "23514":
        return send(422, { code: "RULE_VIOLATION", message: "The change violates a data rule", details: { constraint } });
      case "23503":
        return send(422, { code: "INVALID_REFERENCE", message: "A referenced record does not exist or is still in use", details: { constraint } });
      case "22P02":
      case "22007":
      case "22008":
        return send(400, { code: "INVALID_VALUE", message: "A value has an invalid format" });
      case "40001":
      case "40P01":
        return send(409, { code: "CONCURRENT_UPDATE", message: "The record changed concurrently; retry the request" });
    }
    if (err.code === "RUNTIME.NO_ROWS") return send(404, { code: "NOT_FOUND", message: "Record not found" });
    if (typeof err.code === "string" && err.code.startsWith("ORM.ARGUMENT")) {
      return send(400, { code: "INVALID_ARGUMENT", message: "Invalid query argument" });
    }

    // Never log request bodies: they may contain health data.
    this.logger.error(err.message ?? String(exception), (exception as Error)?.stack);
    return send(500, { code: "INTERNAL_ERROR", message: "Unexpected server error" });
  }
}
