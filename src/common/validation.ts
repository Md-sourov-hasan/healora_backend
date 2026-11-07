import { z, type ZodTypeAny } from "zod";

/** Parse untrusted input; ZodError is mapped to HTTP 400 by the global filter. */
export function parse<S extends ZodTypeAny>(schema: S, input: unknown): z.infer<S> {
  return schema.parse(input ?? {});
}

// ---- reusable field schemas -----------------------------------------------

export const zId = z.string().uuid();
export const zInstant = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), "Must be an ISO-8601 timestamp with offset");
export const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD");
export const zTime = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, "Must be HH:MM or HH:MM:SS");
export const zReason = z.string().trim().min(3).max(1000);
export const zPhone = z.string().trim().regex(/^\+?[0-9]{8,15}$/, "Invalid phone number");
export const zLang = z.enum(["bn", "en"]);
export const zDecimal = z
  .union([z.number(), z.string()])
  .transform((v) => String(v))
  .refine((v) => /^-?\d+(\.\d+)?$/.test(v), "Must be a decimal number");

export const zPage = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type Page = z.infer<typeof zPage>;

export { z };
