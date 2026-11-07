import { z, zDate, zDecimal, zId, zInstant, zReason, zTime } from "../../common/validation.ts";

export const SESSION_TYPES = ["standard_clinic", "special_camp", "outreach_event", "other"] as const;
export const SESSION_STATUSES = ["draft", "published", "open_for_booking", "full", "in_progress", "paused", "completed", "cancelled"] as const;

const optionalText = (max = 2000) => z.string().trim().max(max).optional();

export const createSessionSchema = z.object({
  hubId: zId,
  serviceTypeId: zId,
  title: z.string().trim().min(2).max(200),
  titleBn: optionalText(200),
  sessionType: z.enum(SESSION_TYPES).default("standard_clinic"),
  sessionDate: zDate.optional(),
  startsAt: zInstant,
  endsAt: zInstant,
  venueAddress: optionalText(500),
  venueLatitude: zDecimal.optional(),
  venueLongitude: zDecimal.optional(),
  appointmentCapacity: z.number().int().min(0).max(5000),
  walkInCapacity: z.number().int().min(0).max(5000).default(0),
  slotMinutes: z.number().int().min(1).max(480).optional(),
  bufferMinutes: z.number().int().min(0).max(120).default(0),
  lateArrivalGraceMinutes: z.number().int().min(0).max(240).default(15),
  waitlistEnabled: z.boolean().default(false),
  bookingOpensAt: zInstant.optional(),
  bookingClosesAt: zInstant.optional(),
  eligibilityCriteria: optionalText(),
  patientDescription: optionalText(),
  patientDescriptionBn: optionalText(),
  operationalNotes: optionalText(),
  teamLeadUserId: zId.optional(),
  recurrenceId: zId.optional(),
});
export type CreateSessionInput = z.infer<typeof createSessionSchema>;

/** Overbooking is never enabled through the API (PRD default: no overbooking). */
export const updateSessionSchema = createSessionSchema
  .omit({ hubId: true, serviceTypeId: true, recurrenceId: true })
  .partial()
  .extend({
    teamLeadUserId: zId.nullable().optional(),
    bookingClosesAt: zInstant.nullable().optional(),
  })
  .strict();
export type UpdateSessionInput = z.infer<typeof updateSessionSchema>;

const csv = <T extends readonly [string, ...string[]]>(values: T) =>
  z.preprocess((v) => (typeof v === "string" ? v.split(",").filter(Boolean) : v), z.array(z.enum(values)).optional());

export const listSessionsSchema = z.object({
  hubId: zId.optional(),
  from: zDate.optional(),
  to: zDate.optional(),
  status: csv(SESSION_STATUSES),
  sessionType: z.enum(SESSION_TYPES).optional(),
  serviceTypeId: zId.optional(),
});
export type ListSessionsQuery = z.infer<typeof listSessionsSchema>;

export const publishSchema = z.object({ overrideReason: zReason.optional() });
export const reasonSchema = z.object({ reason: zReason });
export const optionalReasonSchema = z.object({ reason: zReason.optional() });

export const capacitySchema = z
  .object({
    appointmentCapacity: z.number().int().min(0).max(5000).optional(),
    walkInCapacity: z.number().int().min(0).max(5000).optional(),
    expectedVersion: z.number().int().min(1),
    reason: zReason,
  })
  .refine((v) => v.appointmentCapacity !== undefined || v.walkInCapacity !== undefined, "Give appointmentCapacity and/or walkInCapacity");
export type CapacityInput = z.infer<typeof capacitySchema>;

export const generateSlotsSchema = z.object({ perSlotCapacity: z.number().int().min(1).max(500).optional() });

export const createRecurrenceSchema = z.object({
  hubId: zId,
  serviceTypeId: zId,
  title: z.string().trim().min(2).max(200),
  sessionType: z.enum(SESSION_TYPES).default("standard_clinic"),
  rrule: z.string().trim().min(9).max(200),
  startTime: zTime,
  endTime: zTime,
  startsOn: zDate,
  endsOn: zDate.optional(),
  appointmentCapacity: z.number().int().min(0).max(5000),
  walkInCapacity: z.number().int().min(0).max(5000).default(0),
  slotMinutes: z.number().int().min(1).max(480),
});
export type CreateRecurrenceInput = z.infer<typeof createRecurrenceSchema>;

export const materializeSchema = z.object({ until: zDate });
export const listRecurrenceSchema = z.object({ hubId: zId.optional() });
