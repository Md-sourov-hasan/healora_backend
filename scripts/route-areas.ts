/** Groups routes into documentation areas. Shared by routes.ts (Markdown) and openapi.ts (Swagger tags). */
export const AREAS: [RegExp, string][] = [
  [/^\/(health|me|dev)/, "System"],
  [/^\/auth/, "Authentication & sessions"],
  [/^\/admin/, "Staff administration (identity)"],
  [/^\/regions/, "Geography"],
  [/^\/hubs\/[^/]+\/stations|^\/stations/, "Stations"],
  [/^\/hubs/, "Hubs"],
  [/^\/catalog/, "Catalogue & clinical governance"],
  [/^\/sessions\/[^/]+\/(appointments|waitlist)|^\/appointments\/[^/]+\/(confirm|arrived|cancel|reschedule|no-show)|^\/appointments$|^\/appointments\/:id$|^\/waitlist/, "Appointments & waitlist"],
  [/^\/sessions\/[^/]+\/equipment/, "Equipment"],
  [/check-in|walk-ins|queue|^\/display|^\/queue-tickets|encounters/, "Check-in, queue & encounter monitoring"],
  [/^\/sessions|^\/session-recurrences/, "Sessions, camps & capacity"],
  [/^\/shifts/, "Roster"],
  [/^\/equipment/, "Equipment"],
  [/^\/patients|^\/patient-duplicates/, "Patients (operational view)"],
  [/^\/exceptions/, "Exceptions"],
  [/^\/dashboard|^\/reports|^\/exports|^\/audit-events|^\/notifications/, "Dashboard, reports, exports, audit"],
  [/^\/team/, "Local Doctor + Special Team app"],
  [/^\/doctor/, "Doctor review"],
  [/^\/patient\//, "Patient app"],
];

export const areaOf = (path: string) => AREAS.find(([re]) => re.test(path))?.[1] ?? "Other";
export const AREA_ORDER = [...new Set(AREAS.map(([, a]) => a)), "Other"];
