import { createParamDecorator, type ExecutionContext, SetMetadata } from "@nestjs/common";

import { forbidden, unauthorized } from "../errors.ts";
import type { PatientPrincipal, Principal, StaffPrincipal } from "./principal.ts";

export const IS_PUBLIC = "healora:isPublic";
/** Skip authentication for a route (health checks, public hub directory). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

const principalOf = (ctx: ExecutionContext): Principal | undefined =>
  ctx.switchToHttp().getRequest().principal as Principal | undefined;

/** Any authenticated principal. */
export const Auth = createParamDecorator((_: unknown, ctx: ExecutionContext): Principal => {
  const p = principalOf(ctx);
  if (!p) throw unauthorized();
  return p;
});

/** Authenticated staff member (website or team app). */
export const Staff = createParamDecorator((_: unknown, ctx: ExecutionContext): StaffPrincipal => {
  const p = principalOf(ctx);
  if (!p) throw unauthorized();
  if (p.kind !== "staff") throw forbidden("Staff account required");
  return p;
});

/** Authenticated patient (or caregiver acting for them) from the patient app. */
export const PatientUser = createParamDecorator((_: unknown, ctx: ExecutionContext): PatientPrincipal => {
  const p = principalOf(ctx);
  if (!p) throw unauthorized();
  if (p.kind !== "patient") throw forbidden("Patient account required");
  return p;
});
