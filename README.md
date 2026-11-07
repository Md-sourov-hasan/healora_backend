# Healora Hub Management — backend

NestJS 12 + Prisma 8 (PostgreSQL) backend for the **Healora Hub Management Platform** (PRD, 3 Nov 2026). One API serves all three interfaces on one canonical patient record:

| Interface | Route prefix | Who |
|---|---|---|
| Hub Management Website | `/api/v1/{hubs,sessions,appointments,…}` | platform / regional / hub operations staff |
| Local Doctor + Special Team app | `/api/v1/team/*`, `/api/v1/doctor/*` | field health workers, team leads, doctors |
| Patient app | `/api/v1/patient/*` | patients and caregivers |

The full list of 259 routes is in [docs/ROUTES.md](docs/ROUTES.md), generated from the code.

## API documentation (Swagger)

With the server running, open **http://localhost:3000/docs** for Swagger UI. The raw OpenAPI 3.1 document is at `/docs/openapi.json` and in [docs/openapi.json](docs/openapi.json).

Each operation shows:
- its request body, query and path parameters, with the validation rules (lengths, enums, UUIDs, defaults);
- who may call it (public, staff, patient), which roles pass, and any rate limit;
- the shared error envelope `{ code, message, details? }`.

Click **Authorize** and paste an access token from `/auth/staff/login` (or `/mfa/verify`) to use *Try it out*. The token stays in memory only, so reloading the page signs you out of the docs.

The spec is generated from the code, so there are no hand-written DTOs to drift. After changing routes or schemas, run `npm run docs:openapi`. The generator boots the app to list the routes, reads each handler's `parse(schema, …)` and `access.require(…)` calls, and converts the zod schemas to JSON Schema. It prints a warning for any body it could not resolve. Response bodies are not typed yet.

The docs are on by default outside production and off in production. Override this with `API_DOCS=on|off`.

## Deploying the API on Render

The repository includes a Render Blueprint in [render.yaml](render.yaml). Use this button to create it in your Render account:

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/kopotrahman/healora-hub-backend)

Render builds the Docker image, creates a PostgreSQL database, connects it through `DATABASE_URL`, initializes the Prisma contract, and generates three distinct secrets. After deploy, Swagger is at `https://<your-render-service>.onrender.com/docs`. This Blueprint uses Render's Singapore region and a free 1 GB database that expires after 30 days; use dummy/test data only. Export the demo data before expiry or upgrade the database to a paid plan to keep it.

The Blueprint runs the service in Render's Singapore region. The production data policy below requires health data to stay in Bangladesh, so use this setup for Swagger/demo access only unless your hosting and data-transfer setup has been approved for production.

## Quick start (local)

```bash
cp .env.example .env            # fill in DATABASE_URL and the three secrets
npm install
npx prisma db init              # create the schema in an empty database
ADMIN_EMAIL=you@org npx tsx scripts/bootstrap.ts   # first admin + observation catalogue; prints a one-time password
npm run dev                     # http://localhost:3000/api/v1
```

First sign-in: `POST /api/v1/auth/staff/login` with the temporary password → `POST /auth/staff/password` → `POST /auth/staff/mfa/enroll` + `/confirm` → sign in again with MFA. Then create regions, hubs, users and roles through the API.

After changing [src/prisma/contract.prisma](src/prisma/contract.prisma), run `npx prisma contract emit`, then `npx prisma migration plan --name <slug>` to create a migration.

## Docker (local PostgreSQL)

1. Copy `.env.example` to `.env` and set a strong `POSTGRES_PASSWORD` plus three distinct random secrets of at least 32 characters (`JWT_SECRET`, `AUTH_ENCRYPTION_KEY`, `IDENTIFIER_HASH_KEY`). Set the same password in `DATABASE_URL` for host-side tools.
2. Start PostgreSQL and the API with `docker compose up -d --build`. PostgreSQL is exposed on `localhost:5432`; the API uses `APP_PORT` (3000 by default) and serves `/api/v1`.
3. On a new database, initialize the current Prisma contract once: `docker compose exec app npm run db:init`.
4. Create the first admin if needed: `docker compose exec app npm run bootstrap` (set `ADMIN_EMAIL` in `.env` first).

Compose persists database files in the `healora_postgres_data` volume. The API container connects to the Compose service name `postgres`; tools running on the host use the `localhost` URL from `.env`. Do not use the checked-in starter migration for this contract; create and review a migration from the current contract before adopting migrations.

## Database (Supabase)

- **Use the session pooler.** Use port **5432**. The 6543 transaction pooler (`?pgbouncer=true`) breaks the row locks and multi-statement transactions that booking and sync rely on.
- **Verify TLS fully.** Use `sslmode=verify-full&sslrootcert=certs%2Fsupabase-prod-ca-2021.crt`. The Supabase pooler presents a certificate signed by the Supabase Root 2021 CA, committed in [certs/](certs/) with SHA-256 `80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA`. You can compare it with the certificate from *Supabase → Project Settings → Database → SSL*. Never use `no-verify` in production.
- **Commands run from this folder.** The path is relative, so run commands from the backend folder (`npm run dev` does).

## Layout

```
src/
  common/            cross-cutting: auth guard, AccessService (authorisation), audit, outbox events,
                     notifications, rate limiting, state machines, validation, error mapping
  modules/
    auth/            staff password + TOTP MFA, patient/caregiver phone OTP, rotating refresh sessions
    admin/           staff users, scoped role assignments, credentials, break-glass
    geo/ hubs/       regions; hubs, catchments, hours, closures, service offerings
    catalog/         service types, observation catalogue, protocols + alert rules, consent templates
    sessions/        sessions & camps, readiness, publish, capacity, slots, recurrence
    roster/ stations/ equipment/
    patients/        operational patient lookup, assisted registration, duplicates, merge, caregivers
    appointments/    BookingService (capacity-safe), staff booking ops, waitlist
    frontdesk/       check-in, walk-ins, queue + live SSE, display board, encounter assignment
    exceptions/      exception queue + periodic scanner
    insights/        dashboard, reports, exports, audit log, staff inbox, reminders
    team/            shared mobile app: devices, tasks, offline package, consent, observation sync
    doctor/          review queue, clinical view, reviews, alerts, notes, closing encounters
    clinical-core/   observation validation, alert evaluation, encounter completion
    patient-app/     hub discovery, booking, results, instructions, consents, preferences
src/prisma/contract.prisma   the data model (4 Postgres schemas: identity, hub, clinical, ops)
scripts/             bootstrap, authz sweep, auth-flow test, e2e journey, route doc generator
```

## Security model

### Authentication
- **Staff:** email + password (scrypt) → TOTP MFA (RFC 6238, replay-protected, secret AES-256-GCM encrypted). After 5 failures the account locks for an escalating time. Every failure (wrong password, unknown account, locked account) returns the same message.
- **Patients and caregivers:** phone OTP, rate-limited per phone and IP. It answers the same way whether or not the phone is known, so it reveals nothing about accounts. A shared family phone gets a profile picker. A verified caregiver signs in as "acting for" the patient, and that authority is re-checked on every request.
- **Tokens:** a 15-minute access JWT, bound to a server-side `AuthSession` that is checked on every request. A refresh token is opaque, stored only as a hash, and rotated on every use. Re-using an old one revokes the whole session family. Logout, password change, MFA reset and admin revocation take effect immediately. Staff sessions end after 30 minutes idle and 12 hours at most, which suits shared hub computers.
- **Temporary passwords:** an admin-issued password must be changed before anything except `/auth/*` and `/me` works.
- **Privileged roles** (platform admin, regional ops, clinical ops) are refused with `MFA_REQUIRED` unless the session was MFA-authenticated.

### Authorisation (deny by default, enforced on the backend)
- **Who:** every handler calls `AccessService` with an explicit role list. It evaluates the caller's **current** role assignments, scoped by platform, region (including all sub-regions), hub or session.
- **Scope comes from the database:** it is always derived from the target as loaded from the database, never from a client-supplied id, so changing an id in a URL cannot reach another hub.
- **List endpoints:** filtered to the caller's hubs. A caller with none of the required roles gets `403`, never an empty `200`.
- **Clinical data:** reachable only through an active encounter assignment, a hub-scoped doctor role, or a time-limited, reason-bound and reviewed **break-glass** grant. Website roles can never read measurement values; they see statuses and completeness counts only.
- **Denials:** every denied attempt is audited at high priority.
- **Coverage check:** `scripts/authz-sweep.ts` boots the app, enumerates every route, and calls each one as an anonymous caller, a staff member with no roles, a patient, and (on patient routes) an admin. It fails on any route that lets one through.

### Data protection
- **Hashed identifiers:** national IDs and other identifiers are stored as a keyed HMAC plus the last 4 characters. A phone number is never a key.
- **Notifications:** content is generic; no vitals, diagnoses or prescriptions. Details sit behind an authenticated deep link.
- **Events and exports:** domain events carry IDs only. Exports are aggregated by default; patient-level exports need a second person's approval and never include clinical values.
- **Clinical records are append-only:** a correction is a new row that supersedes the old one, a repeat reading keeps both, and a missing measurement is a reason, never a zero. Late or reassigned offline syncs are quarantined, never attached to the wrong encounter.
- **Database checks:** check constraints back up the critical rules, including no overbooking, one value per observation, a reason for every correction, and identity confirmed before care.
- **HTTP:** `Cache-Control: no-store`, `nosniff`, and a strict CORS allow-list. Rate limits apply to login, OTP, refresh and patient lookup. Errors never echo SQL or values.

### Audit
`ops.audit_event` records every login, failure, role change, hub/session/capacity change, patient lookup, check-in, clinical read or write, consent change, export and break-glass use. Each record has the actor, role, hub, target, reason, outcome, IP, device and correlation id.

## Background jobs
These run in-process and can each be switched off per process with an env var (see `.env.example`):
- **Outbox relay** (`OUTBOX_RELAY`): feeds the live queue SSE stream and is the hook for an external broker.
- **Notification dispatcher** (`NOTIFICATION_DISPATCH`)
- **Exception scanner** (`EXCEPTION_SCAN`)
- **Appointment reminders** (`REMINDERS`)

When running several replicas, enable the jobs on one worker process only, and move the in-memory rate limiter to Redis.

## Tests
```bash
npx tsc --noEmit -p .                    # typecheck everything
npx tsx scripts/authz-sweep.ts           # every route × every caller class
npx tsx scripts/test-auth-flow.ts        # login, MFA, rotation/reuse, logout, lockout, OTP (server running)
npx tsx scripts/e2e-journey.ts           # PRD journey: setup → booking → check-in → capture → review → results
npm run docs:openapi                     # regenerate docs/openapi.json (Swagger)
npm run docs:routes                      # regenerate docs/ROUTES.md
```

## Integrations to plug in before production
- **SMS / push:** implement `NotificationProvider` (notification.service.ts) and `OtpSender` (auth.service.ts). The defaults only log.
- **Object storage:** export files are stored inline; move them to Bangladesh-hosted object storage.
- **Frontend SSE:** browser `EventSource` cannot send an `Authorization` header, so use a fetch-based SSE client for `/sessions/:id/queue/stream`.

## Release gates the code cannot satisfy (PRD §17.4)
- **Hosting region:** `prisma.config.ts` still targets Prisma Cloud **us-east-1** from the starter template. That conflicts with the Bangladesh data-residency requirement (PRD §17.2). Choose a Bangladesh-hosted PostgreSQL before storing any real patient data.
- **Legal and clinical approvals:** licensing, health-worker scope, clinical thresholds and protocols, consent wording, the retention schedule, overseas specialist access, and emergency SOPs all need sign-off from qualified reviewers. The system stores and enforces these once they are approved, but does not invent them.
#   h e a l o r a _ b a c k e n d  
 
