# Healora Hub API — route reference

Generated from the running application by `scripts/routes.ts`. 259 routes. All paths are under `/api/v1` except `/health`.
Every route requires a bearer token unless marked **public**. Role requirements are enforced in each handler via `AccessService` (see README › Security model).

## System

| Method | Path | |
|---|---|---|
| POST | `/dev/token` | **public** |
| GET | `/health` | **public** |
| GET | `/me` |  |

## Authentication & sessions

| Method | Path | |
|---|---|---|
| POST | `/auth/admin/users/:userId/mfa/reset` |  |
| POST | `/auth/admin/users/:userId/revoke-sessions` |  |
| POST | `/auth/admin/users/:userId/temporary-password` |  |
| POST | `/auth/admin/users/:userId/unlock` |  |
| POST | `/auth/logout` |  |
| POST | `/auth/patient/otp` | **public** |
| POST | `/auth/patient/otp/verify` | **public** |
| POST | `/auth/patient/select` | **public** |
| POST | `/auth/refresh` | **public** |
| GET | `/auth/sessions` |  |
| DELETE | `/auth/sessions/:id` |  |
| POST | `/auth/staff/login` | **public** |
| POST | `/auth/staff/mfa/confirm` |  |
| POST | `/auth/staff/mfa/disable` |  |
| POST | `/auth/staff/mfa/enroll` |  |
| POST | `/auth/staff/mfa/verify` | **public** |
| POST | `/auth/staff/password` |  |

## Staff administration (identity)

| Method | Path | |
|---|---|---|
| GET | `/admin/break-glass` |  |
| POST | `/admin/break-glass` |  |
| POST | `/admin/break-glass/:id/end` |  |
| POST | `/admin/break-glass/:id/review` |  |
| GET | `/admin/break-glass/mine` |  |
| GET | `/admin/credentials` |  |
| POST | `/admin/credentials/:id/:action` |  |
| GET | `/admin/role-assignments` |  |
| POST | `/admin/role-assignments/:id/revoke` |  |
| GET | `/admin/users` |  |
| POST | `/admin/users` |  |
| GET | `/admin/users/:id` |  |
| PATCH | `/admin/users/:id` |  |
| GET | `/admin/users/:id/credentials` |  |
| POST | `/admin/users/:id/credentials` |  |
| GET | `/admin/users/:id/role-assignments` |  |
| POST | `/admin/users/:id/role-assignments` |  |
| POST | `/admin/users/:id/status` |  |

## Geography

| Method | Path | |
|---|---|---|
| GET | `/regions` |  |
| POST | `/regions` |  |
| GET | `/regions/:id` |  |
| PATCH | `/regions/:id` |  |
| POST | `/regions/:id/deactivate` |  |
| GET | `/regions/tree` |  |

## Stations

| Method | Path | |
|---|---|---|
| GET | `/hubs/:hubId/stations` |  |
| POST | `/hubs/:hubId/stations` |  |
| DELETE | `/stations/:id` |  |
| PATCH | `/stations/:id` |  |
| GET | `/stations/:id/service-types` |  |
| PUT | `/stations/:id/service-types` |  |
| POST | `/stations/:id/status` |  |

## Hubs

| Method | Path | |
|---|---|---|
| GET | `/hubs` |  |
| POST | `/hubs` |  |
| GET | `/hubs/:id` |  |
| PATCH | `/hubs/:id` |  |
| GET | `/hubs/:id/availability-blocks` |  |
| POST | `/hubs/:id/availability-blocks` |  |
| POST | `/hubs/:id/availability-blocks/:blockId/lift` |  |
| GET | `/hubs/:id/catchments` |  |
| POST | `/hubs/:id/catchments` |  |
| DELETE | `/hubs/:id/catchments/:regionId` |  |
| PUT | `/hubs/:id/manager` |  |
| GET | `/hubs/:id/operating-hours` |  |
| PUT | `/hubs/:id/operating-hours` |  |
| PUT | `/hubs/:id/regional-owner` |  |
| GET | `/hubs/:id/service-offerings` |  |
| POST | `/hubs/:id/service-offerings` |  |
| POST | `/hubs/:id/service-offerings/:offeringId/:action` |  |
| GET | `/hubs/:id/staff` |  |
| POST | `/hubs/:id/status` |  |

## Catalogue & clinical governance

| Method | Path | |
|---|---|---|
| GET | `/catalog/consent-templates` |  |
| POST | `/catalog/consent-templates` |  |
| GET | `/catalog/consent-templates/:id` |  |
| PATCH | `/catalog/consent-templates/:id` |  |
| POST | `/catalog/consent-templates/:id/approve` |  |
| POST | `/catalog/consent-templates/:id/retire` |  |
| GET | `/catalog/observation-definitions` |  |
| POST | `/catalog/observation-definitions` |  |
| PATCH | `/catalog/observation-definitions/:code` |  |
| GET | `/catalog/protocols` |  |
| POST | `/catalog/protocols` |  |
| GET | `/catalog/protocols/:id` |  |
| PATCH | `/catalog/protocols/:id` |  |
| POST | `/catalog/protocols/:id/alert-rules` |  |
| DELETE | `/catalog/protocols/:id/alert-rules/:ruleId` |  |
| PATCH | `/catalog/protocols/:id/alert-rules/:ruleId` |  |
| POST | `/catalog/protocols/:id/approve` |  |
| DELETE | `/catalog/protocols/:id/observations/:code` |  |
| PUT | `/catalog/protocols/:id/observations/:code` |  |
| POST | `/catalog/protocols/:id/retire` |  |
| GET | `/catalog/queue-priority-policies` |  |
| POST | `/catalog/queue-priority-policies` |  |
| POST | `/catalog/queue-priority-policies/:id/retire` |  |
| GET | `/catalog/service-types` |  |
| POST | `/catalog/service-types` |  |
| GET | `/catalog/service-types/:id` |  |
| PATCH | `/catalog/service-types/:id` |  |
| POST | `/catalog/service-types/:id/requirements` |  |
| DELETE | `/catalog/service-types/:id/requirements/:reqId` |  |

## Appointments & waitlist

| Method | Path | |
|---|---|---|
| GET | `/appointments` |  |
| GET | `/appointments/:id` |  |
| POST | `/appointments/:id/arrived` |  |
| POST | `/appointments/:id/cancel` |  |
| POST | `/appointments/:id/confirm` |  |
| POST | `/appointments/:id/no-show` |  |
| POST | `/appointments/:id/reschedule` |  |
| GET | `/sessions/:sessionId/appointments` |  |
| POST | `/sessions/:sessionId/appointments` |  |
| GET | `/sessions/:sessionId/waitlist` |  |
| POST | `/sessions/:sessionId/waitlist` |  |
| POST | `/waitlist/:id/offer` |  |
| POST | `/waitlist/:id/remove` |  |

## Equipment

| Method | Path | |
|---|---|---|
| GET | `/equipment` |  |
| POST | `/equipment` |  |
| GET | `/equipment/:id` |  |
| PATCH | `/equipment/:id` |  |
| GET | `/equipment/:id/events` |  |
| POST | `/equipment/:id/faults` |  |
| POST | `/equipment/:id/faults/resolve` |  |
| POST | `/equipment/:id/retire` |  |
| POST | `/equipment/:id/service-events` |  |
| POST | `/equipment/:id/status` |  |
| GET | `/sessions/:sessionId/equipment` |  |
| POST | `/sessions/:sessionId/equipment` |  |
| DELETE | `/sessions/:sessionId/equipment/:equipmentId` |  |

## Check-in, queue & encounter monitoring

| Method | Path | |
|---|---|---|
| POST | `/appointments/:id/check-in` |  |
| GET | `/display/sessions/:sessionId/board` |  |
| GET | `/doctor/encounters/:id` |  |
| POST | `/doctor/encounters/:id/close` |  |
| POST | `/doctor/encounters/:id/notes` |  |
| POST | `/doctor/encounters/:id/reviews` |  |
| GET | `/doctor/review-queue` |  |
| POST | `/encounters/:id/assign` |  |
| GET | `/encounters/:id/operational` |  |
| POST | `/queue-tickets/:id/call` |  |
| POST | `/queue-tickets/:id/cancel` |  |
| POST | `/queue-tickets/:id/complete` |  |
| POST | `/queue-tickets/:id/delay` |  |
| GET | `/queue-tickets/:id/history` |  |
| POST | `/queue-tickets/:id/no-show` |  |
| POST | `/queue-tickets/:id/pause` |  |
| POST | `/queue-tickets/:id/priority` |  |
| POST | `/queue-tickets/:id/reopen` |  |
| POST | `/queue-tickets/:id/resume` |  |
| POST | `/queue-tickets/:id/start` |  |
| POST | `/queue-tickets/:id/transfer` |  |
| GET | `/sessions/:sessionId/encounters` |  |
| GET | `/sessions/:sessionId/queue` |  |
| GET | `/sessions/:sessionId/queue/stream` |  |
| POST | `/sessions/:sessionId/walk-ins` |  |
| POST | `/shifts/:id/check-in` |  |
| POST | `/team/encounters/:id/confirm-identity` |  |
| GET | `/team/encounters/:id/consent` |  |
| POST | `/team/encounters/:id/consents` |  |
| GET | `/team/encounters/:id/context` |  |
| POST | `/team/encounters/:id/escalations` |  |
| POST | `/team/encounters/:id/notes` |  |
| POST | `/team/encounters/:id/submit` |  |
| POST | `/team/encounters/:id/tasks/:code/missing` |  |
| POST | `/team/encounters/:id/tasks/:code/waive` |  |

## Sessions, camps & capacity

| Method | Path | |
|---|---|---|
| GET | `/session-recurrences` |  |
| POST | `/session-recurrences` |  |
| POST | `/session-recurrences/:id/deactivate` |  |
| POST | `/session-recurrences/:id/materialize` |  |
| GET | `/sessions` |  |
| POST | `/sessions` |  |
| GET | `/sessions/:id` |  |
| PATCH | `/sessions/:id` |  |
| POST | `/sessions/:id/cancel` |  |
| POST | `/sessions/:id/capacity` |  |
| POST | `/sessions/:id/complete` |  |
| POST | `/sessions/:id/open-booking` |  |
| POST | `/sessions/:id/pause` |  |
| POST | `/sessions/:id/publish` |  |
| GET | `/sessions/:id/readiness` |  |
| POST | `/sessions/:id/resume` |  |
| GET | `/sessions/:id/slots` |  |
| POST | `/sessions/:id/slots/:slotId/block` |  |
| POST | `/sessions/:id/slots/:slotId/unblock` |  |
| POST | `/sessions/:id/slots/generate` |  |
| POST | `/sessions/:id/start` |  |

## Roster

| Method | Path | |
|---|---|---|
| GET | `/shifts` |  |
| POST | `/shifts` |  |
| GET | `/shifts/:id` |  |
| POST | `/shifts/:id/absent` |  |
| POST | `/shifts/:id/approve` |  |
| POST | `/shifts/:id/cancel` |  |
| POST | `/shifts/:id/check-out` |  |
| GET | `/shifts/mine` |  |

## Patients (operational view)

| Method | Path | |
|---|---|---|
| GET | `/patient-duplicates` |  |
| POST | `/patient-duplicates/:id/resolve` |  |
| POST | `/patient-duplicates/merge` |  |
| POST | `/patients` |  |
| GET | `/patients/:id` |  |
| POST | `/patients/:id/identifiers` |  |
| GET | `/patients/:id/representatives` |  |
| POST | `/patients/:id/representatives` |  |
| POST | `/patients/:id/representatives/:repId/revoke` |  |
| POST | `/patients/:id/representatives/:repId/verify` |  |
| POST | `/patients/lookup` |  |

## Exceptions

| Method | Path | |
|---|---|---|
| GET | `/exceptions` |  |
| GET | `/exceptions/:id` |  |
| POST | `/exceptions/:id/acknowledge` |  |
| POST | `/exceptions/:id/assign` |  |
| POST | `/exceptions/:id/dismiss` |  |
| POST | `/exceptions/:id/escalate` |  |
| POST | `/exceptions/:id/resolve` |  |
| POST | `/exceptions/scan` |  |

## Dashboard, reports, exports, audit

| Method | Path | |
|---|---|---|
| GET | `/audit-events` |  |
| GET | `/dashboard/overview` |  |
| GET | `/exports` |  |
| POST | `/exports` |  |
| POST | `/exports/:id/approve` |  |
| GET | `/exports/:id/download` |  |
| POST | `/exports/:id/reject` |  |
| GET | `/notifications` |  |
| POST | `/notifications/:id/read` |  |
| GET | `/reports` |  |
| GET | `/reports/:code` |  |

## Local Doctor + Special Team app

| Method | Path | |
|---|---|---|
| POST | `/team/assignments/:id/accept` |  |
| POST | `/team/assignments/:id/release` |  |
| POST | `/team/assignments/:id/start` |  |
| POST | `/team/assignments/:id/transfer` |  |
| POST | `/team/devices` |  |
| DELETE | `/team/devices/:id` |  |
| POST | `/team/devices/:id/heartbeat` |  |
| POST | `/team/escalations/:id/close` |  |
| POST | `/team/observations/:id/corrections` |  |
| GET | `/team/sessions` |  |
| GET | `/team/sessions/:id/offline-package` |  |
| POST | `/team/sync/observations` |  |
| GET | `/team/sync/status` |  |
| POST | `/team/sync/submissions/:id/resubmit` |  |
| GET | `/team/tasks` |  |

## Doctor review

| Method | Path | |
|---|---|---|
| POST | `/doctor/alerts/:id/acknowledge` |  |
| POST | `/doctor/alerts/:id/resolve` |  |
| POST | `/doctor/notes/:id/amend` |  |
| GET | `/doctor/patients/:id/timeline` |  |

## Patient app

| Method | Path | |
|---|---|---|
| GET | `/patient/appointments` |  |
| POST | `/patient/appointments` |  |
| GET | `/patient/appointments/:id` |  |
| POST | `/patient/appointments/:id/cancel` |  |
| GET | `/patient/appointments/:id/instructions` |  |
| POST | `/patient/appointments/:id/reschedule` |  |
| GET | `/patient/consent-templates` |  |
| GET | `/patient/consents` |  |
| POST | `/patient/consents` |  |
| POST | `/patient/consents/:id/withdraw` |  |
| POST | `/patient/data-requests` |  |
| GET | `/patient/hubs` |  |
| GET | `/patient/hubs/:id` |  |
| GET | `/patient/hubs/:id/sessions` |  |
| GET | `/patient/instructions` |  |
| GET | `/patient/me` |  |
| GET | `/patient/notification-preferences` |  |
| PUT | `/patient/notification-preferences` |  |
| PUT | `/patient/preferred-hub` |  |
| GET | `/patient/representatives` |  |
| GET | `/patient/results` |  |

