import { conflict } from "./errors.ts";

/**
 * Allowed status transitions (PRD §12). Any change not listed is refused with
 * 409 INVALID_TRANSITION. Terminal states have no outgoing edges.
 */
const MACHINES = {
  hub: {
    draft: ["active", "permanently_closed"],
    active: ["paused", "temporarily_closed", "permanently_closed"],
    paused: ["active", "temporarily_closed", "permanently_closed"],
    temporarily_closed: ["active", "permanently_closed"],
    permanently_closed: [],
  },
  session: {
    draft: ["published", "cancelled"],
    published: ["open_for_booking", "paused", "in_progress", "cancelled"],
    open_for_booking: ["full", "paused", "in_progress", "cancelled"],
    full: ["open_for_booking", "paused", "in_progress", "cancelled"],
    paused: ["published", "open_for_booking", "in_progress", "cancelled"],
    in_progress: ["paused", "completed", "cancelled"],
    completed: [],
    cancelled: [],
  },
  appointment: {
    pending_confirmation: ["confirmed", "cancelled"],
    confirmed: ["arrived", "checked_in", "cancelled", "no_show"],
    arrived: ["checked_in", "cancelled", "no_show"],
    checked_in: ["in_service", "completed", "cancelled", "unable_to_complete", "referred"],
    in_service: ["completed", "unable_to_complete", "referred"],
    completed: [],
    cancelled: [],
    no_show: [],
    unable_to_complete: [],
    referred: [],
  },
  encounter: {
    created: ["assigned", "unable_to_complete", "escalated"],
    assigned: ["assigned", "in_progress", "unable_to_complete", "escalated"],
    in_progress: ["awaiting_sync", "submitted_for_review", "awaiting_remeasurement", "completed", "referred", "escalated", "unable_to_complete"],
    awaiting_sync: ["in_progress", "sync_failed", "submitted_for_review", "completed"],
    sync_failed: ["awaiting_sync", "in_progress"],
    submitted_for_review: ["reviewed", "awaiting_remeasurement", "referred", "escalated"],
    awaiting_remeasurement: ["in_progress", "submitted_for_review", "escalated"],
    reviewed: ["completed", "referred", "awaiting_remeasurement"],
    referred: ["completed"],
    escalated: ["in_progress", "submitted_for_review", "referred", "completed", "unable_to_complete"],
    unable_to_complete: [],
    completed: [],
  },
  queue: {
    waiting: ["called", "paused", "transferred", "cancelled", "no_show", "referred"],
    called: ["in_service", "waiting", "transferred", "no_show", "cancelled", "referred"],
    in_service: ["awaiting_review", "completed", "transferred", "paused", "referred"],
    awaiting_review: ["completed", "in_service", "referred", "transferred"],
    paused: ["waiting", "cancelled"],
    transferred: ["waiting", "called", "in_service"],
    completed: [],
    cancelled: [],
    no_show: [],
    referred: [],
  },
} as const satisfies Record<string, Record<string, readonly string[]>>;

export type Machine = keyof typeof MACHINES;
export type StateOf<M extends Machine> = keyof (typeof MACHINES)[M] & string;

export function canTransition<M extends Machine>(machine: M, from: string, to: string): boolean {
  const edges = (MACHINES[machine] as Record<string, readonly string[]>)[from];
  return edges !== undefined && edges.includes(to);
}

export function assertTransition<M extends Machine>(machine: M, from: string, to: string): void {
  if (!canTransition(machine, from, to)) {
    throw conflict("INVALID_TRANSITION", `Cannot move ${machine} from '${from}' to '${to}'`, { from, to });
  }
}

export function isTerminal<M extends Machine>(machine: M, state: string): boolean {
  const edges = (MACHINES[machine] as Record<string, readonly string[]>)[state];
  return edges !== undefined && edges.length === 0;
}

export const ACTIVE_APPOINTMENT_STATUSES = ["pending_confirmation", "confirmed", "arrived", "checked_in", "in_service"] as const;
export const OPEN_ENCOUNTER_STATUSES = [
  "created",
  "assigned",
  "in_progress",
  "awaiting_sync",
  "sync_failed",
  "submitted_for_review",
  "awaiting_remeasurement",
  "reviewed",
  "escalated",
] as const;
export const ACTIVE_QUEUE_STATUSES = ["waiting", "called", "in_service", "awaiting_review", "paused", "transferred"] as const;
export const BOOKABLE_SESSION_STATUSES = ["open_for_booking"] as const;
