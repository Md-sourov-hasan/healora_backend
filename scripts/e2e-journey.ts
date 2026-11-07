/**
 * End-to-end journey over HTTP with REAL authentication (PRD §23, §9, §20).
 *
 *   Server: AUTH_DEV_TOKENS=false OTP_TEST_SINK_FILE=/tmp/otp.txt npx tsx src/main.ts
 *   Test:   API_BASE=http://localhost:3077/api/v1 OTP_TEST_SINK_FILE=/tmp/otp.txt \
 *           ADMIN_EMAIL=admin@healora.local ADMIN_PASSWORD='...' npx tsx scripts/e2e-journey.ts
 *
 * ADMIN_PASSWORD is the admin's current password. If the admin still has the
 * bootstrap temporary password, pass it and the script changes it to
 * ADMIN_NEW_PASSWORD (default below) and enrols MFA; the TOTP secret is written
 * to E2E_STATE_FILE so later runs can sign in again.
 *
 * Repeatable: every code / email carries a per-run suffix.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { currentStep, totpAt } from "../src/modules/auth/crypto.ts";

const B = process.env.API_BASE ?? "http://localhost:3077/api/v1";
const SINK = process.env.OTP_TEST_SINK_FILE ?? "";
const STATE_FILE = process.env.E2E_STATE_FILE ?? "scripts/.e2e-state.json";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "admin@healora.local";
const ADMIN_NEW_PASSWORD = process.env.ADMIN_NEW_PASSWORD ?? "E2e!Healora#Passphrase2026";
const RUN = Date.now().toString(36).toUpperCase();
const STAFF_PASSWORD = "Journey!Staff#2026x";

// ---- tiny harness -----------------------------------------------------------------
let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    passed++;
    console.log(`PASS ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL ${name}${detail === undefined ? "" : `  ${JSON.stringify(detail).slice(0, 600)}`}`);
  }
  return cond;
}
class Abort extends Error {}
function must(name: string, cond: boolean, detail?: unknown) {
  if (!check(name, cond, detail)) throw new Abort(name);
}

type Res = { status: number; json: any; text: string };
async function req(method: string, path: string, body?: unknown, token?: string, headers: Record<string, string> = {}): Promise<Res> {
  const r = await fetch(B + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: r.status, json, text };
}
const ok = (r: Res) => r.status >= 200 && r.status < 300;
const list = (j: any): any[] => (Array.isArray(j) ? j : (j?.items ?? j?.results ?? j?.data ?? j?.observations ?? j?.hubs ?? j?.sessions ?? j?.appointments ?? j?.instructions ?? j?.events ?? []));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitNextStep(after: number) {
  while (currentStep() <= after) await sleep(1000);
}

// ---- auth helpers ---------------------------------------------------------------
type Account = { id: string; email: string; token: string; refresh: string; secret?: string };

async function passwordLogin(email: string, password: string, secret?: string): Promise<Res> {
  const l = await req("POST", "/auth/staff/login", { email, password });
  if (!ok(l) || !l.json?.mfaRequired) return l;
  if (!secret) return l;
  const v = await req("POST", "/auth/staff/mfa/verify", { challengeId: l.json.challengeId, code: totpAt(secret, currentStep()) });
  return v;
}

/** temp password → change → refresh (→ MFA enrol + MFA login when privileged). */
async function activateAccount(email: string, temp: string, privileged: boolean): Promise<{ token: string; refresh: string; secret?: string }> {
  const l = await req("POST", "/auth/staff/login", { email, password: temp });
  must(`${email}: temp-password login`, ok(l) && l.json.passwordChangeRequired === true, l.json);
  const blocked = await req("GET", "/sessions", undefined, l.json.accessToken);
  check(`${email}: password-change gate blocks other routes`, blocked.json?.code === "PASSWORD_CHANGE_REQUIRED", blocked.json);
  const ch = await req("POST", "/auth/staff/password", { currentPassword: temp, newPassword: STAFF_PASSWORD }, l.json.accessToken);
  must(`${email}: password changed`, ok(ch), ch.json);
  const r = await req("POST", "/auth/refresh", { refreshToken: l.json.refreshToken });
  must(`${email}: refresh`, ok(r), r.json);
  if (!privileged) return { token: r.json.accessToken, refresh: r.json.refreshToken };

  const en = await req("POST", "/auth/staff/mfa/enroll", undefined, r.json.accessToken);
  must(`${email}: MFA enrol`, ok(en) && !!en.json.secret, en.json);
  const step = currentStep();
  const cf = await req("POST", "/auth/staff/mfa/confirm", { code: totpAt(en.json.secret, step) }, r.json.accessToken);
  must(`${email}: MFA confirm`, ok(cf), cf.json);
  await waitNextStep(step);
  const mv = await passwordLogin(email, STAFF_PASSWORD, en.json.secret);
  must(`${email}: MFA login`, ok(mv) && !!mv.json.accessToken, mv.json);
  return { token: mv.json.accessToken, refresh: mv.json.refreshToken, secret: en.json.secret };
}

async function otpCodeFor(phone: string, since: number): Promise<string> {
  for (let i = 0; i < 30; i++) {
    if (SINK && existsSync(SINK)) {
      const lines = readFileSync(SINK, "utf8").split("\n").slice(since).filter(Boolean);
      const digits = phone.replace(/\D/g, "").slice(-10);
      const hit = lines.reverse().find((l) => l.replace(/\D/g, "").includes(digits) || l.split(" ")[0]!.replace(/\D/g, "").endsWith(digits));
      if (hit) return hit.split(" ")[1]!;
    }
    await sleep(300);
  }
  throw new Abort(`OTP for ${phone} not found in sink (start the server with OTP_TEST_SINK_FILE)`);
}
const sinkLines = () => (SINK && existsSync(SINK) ? readFileSync(SINK, "utf8").split("\n").filter(Boolean).length : 0);

async function patientLogin(phone: string): Promise<string> {
  const before = sinkLines();
  const o = await req("POST", "/auth/patient/otp", { phone });
  must(`patient ${phone}: OTP requested`, o.status === 202 && !!o.json.challengeId && !("devCode" in o.json), o.json);
  const code = await otpCodeFor(phone, before);
  const v = await req("POST", "/auth/patient/otp/verify", { challengeId: o.json.challengeId, code });
  must(`patient ${phone}: OTP verified`, ok(v) && v.json.selectionRequired === false && !!v.json.accessToken, v.json);
  return v.json.accessToken;
}

// =====================================================================================
async function main() {
  if (!SINK) throw new Abort("Set OTP_TEST_SINK_FILE (same path as the server)");
  // ---- 1. admin bootstrap ---------------------------------------------------------
  const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
  const adminPassword = process.env.ADMIN_PASSWORD ?? state.adminPassword ?? "Bootstrap#Temp2026x";
  let admin: Account;
  {
    let l = await req("POST", "/auth/staff/login", { email: ADMIN_EMAIL, password: adminPassword });
    must("admin: password login", ok(l), l.json);
    if (l.json.passwordChangeRequired) {
      const ch = await req("POST", "/auth/staff/password", { currentPassword: adminPassword, newPassword: ADMIN_NEW_PASSWORD }, l.json.accessToken);
      must("admin: temporary password changed", ok(ch), ch.json);
      const r = await req("POST", "/auth/refresh", { refreshToken: l.json.refreshToken });
      must("admin: refresh after password change", ok(r), r.json);
      const noMfa = await req("GET", "/hubs", undefined, r.json.accessToken);
      check("admin: privileged action refused without MFA", noMfa.json?.code === "MFA_REQUIRED", noMfa.json);
      const en = await req("POST", "/auth/staff/mfa/enroll", undefined, r.json.accessToken);
      must("admin: MFA enrol", ok(en), en.json);
      const step = currentStep();
      must("admin: MFA confirm", ok(await req("POST", "/auth/staff/mfa/confirm", { code: totpAt(en.json.secret, step) }, r.json.accessToken)));
      writeFileSync(STATE_FILE, JSON.stringify({ adminPassword: ADMIN_NEW_PASSWORD, adminSecret: en.json.secret }, null, 2));
      state.adminPassword = ADMIN_NEW_PASSWORD;
      state.adminSecret = en.json.secret;
      await waitNextStep(step);
      l = await req("POST", "/auth/staff/login", { email: ADMIN_EMAIL, password: ADMIN_NEW_PASSWORD });
    }
    must("admin: MFA challenge issued", l.json?.mfaRequired === true, l.json);
    must("admin: TOTP secret known (E2E_STATE_FILE)", !!state.adminSecret);
    let v = await req("POST", "/auth/staff/mfa/verify", { challengeId: l.json.challengeId, code: totpAt(state.adminSecret, currentStep()) });
    if (!ok(v) && v.json?.code === "INVALID_CODE") {
      // The current step may have been consumed by a previous run: wait one step and retry.
      await waitNextStep(currentStep());
      l = await req("POST", "/auth/staff/login", { email: ADMIN_EMAIL, password: state.adminPassword });
      v = await req("POST", "/auth/staff/mfa/verify", { challengeId: l.json.challengeId, code: totpAt(state.adminSecret, currentStep()) });
    }
    must("admin: MFA login", ok(v) && !!v.json.accessToken, v.json);
    const me = await req("GET", "/me", undefined, v.json.accessToken);
    must("admin: /me strongAuth", me.json?.strongAuth === true, me.json);
    admin = { id: me.json.user.id, email: ADMIN_EMAIL, token: v.json.accessToken, refresh: v.json.refreshToken };
  }
  const A = admin.token;

  // ---- 2. regions + users ------------------------------------------------------------
  const div = await req("POST", "/regions", { code: `E2E-DIV-${RUN}`, name: `E2E Division ${RUN}`, level: "division" }, A);
  must("region: division created", ok(div), div.json);
  const dist = await req("POST", "/regions", { code: `E2E-DIS-${RUN}`, name: `E2E District ${RUN}`, level: "district", parentId: div.json.id }, A);
  must("region: district created", ok(dist), dist.json);
  const div2 = await req("POST", "/regions", { code: `E2E-DIV2-${RUN}`, name: `E2E Other Division ${RUN}`, level: "division" }, A);
  must("region: second division created", ok(div2), div2.json);

  const people = ["regional", "manager", "reception", "queue", "worker", "doctor", "clinops"] as const;
  type Who = (typeof people)[number];
  const users = {} as Record<Who, Account>;
  const temps = {} as Record<Who, string>;
  for (const who of people) {
    const email = `e2e-${who}-${RUN.toLowerCase()}@test.local`;
    const u = await req("POST", "/admin/users", { email, name: `E2E ${who} ${RUN}` }, A);
    must(`user ${who}: created (invited)`, ok(u) && u.json.status === "invited", u.json);
    const act = await req("POST", `/admin/users/${u.json.id}/status`, { status: "active", reason: "E2E onboarding" }, A);
    must(`user ${who}: activated`, ok(act), act.json);
    const tp = await req("POST", `/auth/admin/users/${u.json.id}/temporary-password`, { reason: "E2E onboarding" }, A);
    must(`user ${who}: temporary password issued`, ok(tp) && !!tp.json.temporaryPassword, tp.json);
    users[who] = { id: u.json.id, email, token: "", refresh: "" };
    temps[who] = tp.json.temporaryPassword;
  }

  // privileged grants (admin only)
  const g1 = await req("POST", `/admin/users/${users.regional.id}/role-assignments`, { role: "regional_ops_manager", scopeType: "region", regionId: div.json.id }, A);
  must("grant: regional_ops_manager @division", ok(g1), g1.json);
  const g2 = await req("POST", `/admin/users/${users.clinops.id}/role-assignments`, { role: "clinical_ops_admin", scopeType: "platform" }, A);
  must("grant: clinical_ops_admin @platform", ok(g2), g2.json);

  for (const who of ["regional", "clinops"] as const) {
    const s = await activateAccount(users[who].email, temps[who], true);
    Object.assign(users[who], s);
  }
  const R = () => users.regional.token;
  const C = () => users.clinops.token;

  const regionalPrivileged = await req("POST", `/admin/users/${users.manager.id}/role-assignments`, { role: "clinical_ops_admin", scopeType: "platform" }, R());
  check("regional manager cannot grant a privileged role", regionalPrivileged.status === 403, regionalPrivileged.json);

  // credentials (clinical ops)
  const credIds: Record<string, string> = {};
  for (const [who, role, designation] of [["worker", "field_health_worker", "Health Assistant"], ["doctor", "local_doctor", "MBBS Medical Officer"]] as const) {
    const cr = await req(
      "POST",
      `/admin/users/${users[who].id}/credentials`,
      { professionalDesignation: designation, qualification: "E2E verified", registrationBody: who === "doctor" ? "BMDC" : null, registrationNumber: who === "doctor" ? `E2E-${who}-${RUN}` : null, permittedObservationCodes: ["bp_systolic", "bp_diastolic", "heart_rate"], qualifiesForRoles: [role], expiresAt: "2030-12-31" },
      C(),
    );
    must(`credential ${who}: created`, ok(cr), cr.json);
    const early = await req("POST", `/admin/users/${users[who].id}/role-assignments`, { role, scopeType: "region", regionId: div.json.id }, R());
    if (who === "worker") check("credentialed role refused before verification", early.status === 422 && early.json?.code === "CREDENTIAL_REQUIRED", early.json);
    const vf = await req("POST", `/admin/credentials/${cr.json.id}/verify`, {}, C());
    must(`credential ${who}: verified`, ok(vf), vf.json);
    credIds[who] = cr.json.id;
  }

  // ---- 3. catalogue (clinical ops) ---------------------------------------------------
  const proto = await req("POST", "/catalog/protocols", { code: `e2e-vitals-${RUN.toLowerCase()}`, name: "E2E basic vitals", clinicalOwnerId: users.clinops.id }, C());
  must("protocol: draft created", ok(proto), proto.json);
  for (const code of ["bp_systolic", "bp_diastolic", "heart_rate"]) {
    const po = await req("PUT", `/catalog/protocols/${proto.json.id}/observations/${code}`, { required: true, permittedRoles: ["field_health_worker", "local_doctor"] }, C());
    must(`protocol: requires ${code}`, ok(po), po.json);
  }
  const rule = await req(
    "POST",
    `/catalog/protocols/${proto.json.id}/alert-rules`,
    { code: "bp_systolic_high", observationCode: "bp_systolic", condition: { op: ">=", value: 180, unit: "mmHg" }, action: "contact_doctor", severity: "high", messageEn: "Systolic at or above 180: contact the doctor", messageBn: "সিস্টোলিক ১৮০ বা বেশি: ডাক্তারের সাথে যোগাযোগ করুন" },
    C(),
  );
  must("protocol: alert rule added", ok(rule), rule.json);
  const appr = await req("POST", `/catalog/protocols/${proto.json.id}/approve`, {}, C());
  must("protocol: approved", ok(appr), appr.json);
  const editApproved = await req("PUT", `/catalog/protocols/${proto.json.id}/observations/heart_rate`, { required: false, permittedRoles: ["field_health_worker"] }, C());
  check("approved protocol is immutable (409)", editApproved.status === 409, editApproved.json);

  const st = await req(
    "POST",
    "/catalog/service-types",
    {
      code: `e2e-basic-${RUN.toLowerCase()}`,
      name: "E2E basic health check",
      protocolId: proto.json.id,
      defaultSlotMinutes: 15,
      requiresDoctorReview: false,
      requirements: [
        { kind: "staff_role", staffRole: "field_health_worker", minCount: 1 },
        { kind: "station_type", stationType: "vitals", minCount: 1 },
        { kind: "equipment_type", equipmentCategory: "bp_monitor", minCount: 1 },
      ],
    },
    C(),
  );
  must("service type: created with requirements", ok(st) && st.json.requirements?.length === 3, st.json);

  const templates: Record<string, string> = {};
  for (const purpose of ["hub_service", "health_data_processing"] as const) {
    const t = await req(
      "POST",
      "/catalog/consent-templates",
      { code: `e2e-${purpose}-${RUN.toLowerCase()}`.replace(/_/g, "-"), purpose, language: "bn", title: `E2E ${purpose}`, body: `E2E consent text for ${purpose}. আপনার তথ্য কীভাবে ব্যবহার হবে তা এখানে ব্যাখ্যা করা হয়েছে।`, dataCategories: ["vitals"], recipients: ["healora_care_team"] },
      C(),
    );
    must(`consent template ${purpose}: created`, ok(t), t.json);
    const ta = await req("POST", `/catalog/consent-templates/${t.json.id}/approve`, {}, C());
    must(`consent template ${purpose}: approved`, ok(ta), ta.json);
    templates[purpose] = t.json.id;
  }

  // ---- 4. hub ------------------------------------------------------------------------
  const hub = await req("POST", "/hubs", { code: `E2E-HUB-${RUN}`, name: `E2E Hub ${RUN}`, regionId: dist.json.id, addressLine: "Union Parishad Road", latitude: "23.810300", longitude: "90.412500", contactPhone: "+8801700000000", languages: ["bn", "en"], emergencyContactName: "Upazila Health Complex", emergencyContactPhone: "+8801700000001", nearestReferralFacility: "Upazila Health Complex" }, R());
  must("hub: created (draft) by regional manager", ok(hub) && hub.json.status === "draft", hub.json);
  const H = hub.json.id as string;
  const hub2 = await req("POST", "/hubs", { code: `E2E-HUB2-${RUN}`, name: `E2E Other Hub ${RUN}`, regionId: div2.json.id, addressLine: "Elsewhere" }, A);
  must("hub 2: created in another division (admin)", ok(hub2), hub2.json);
  const regionalOther = await req("GET", `/hubs/${hub2.json.id}`, undefined, R());
  check("regional manager cannot read a hub outside their region (403)", regionalOther.status === 403, regionalOther.json);

  must("hub: catchment added", ok(await req("POST", `/hubs/${H}/catchments`, { regionId: dist.json.id }, R())));
  const hours = await req("PUT", `/hubs/${H}/operating-hours`, { hours: [1, 2, 3, 4, 5, 6, 7].map((d) => ({ dayOfWeek: d, opensAt: "00:00", closesAt: "23:59" })) }, R());
  must("hub: operating hours set", ok(hours), hours.json);

  // hub-scoped roles (regional manager grants)
  const grants: Record<string, string> = {};
  for (const [who, role] of [["manager", "hub_manager"], ["reception", "reception_officer"], ["queue", "queue_coordinator"], ["worker", "field_health_worker"], ["doctor", "local_doctor"]] as const) {
    const g = await req("POST", `/admin/users/${users[who].id}/role-assignments`, { role, scopeType: "hub", hubId: H }, R());
    must(`grant: ${role} @hub`, ok(g), g.json);
    grants[who] = g.json.id;
  }
  for (const who of ["manager", "reception", "queue", "worker", "doctor"] as const) {
    Object.assign(users[who], await activateAccount(users[who].email, temps[who], false));
  }
  const M = () => users.manager.token;

  const mgrOther = await req("GET", `/hubs/${hub2.json.id}`, undefined, M());
  check("hub manager cannot read another hub (403)", mgrOther.status === 403, mgrOther.json);
  const mgrOtherSessions = await req("GET", `/sessions?hubId=${hub2.json.id}`, undefined, M());
  check("hub manager cannot list another hub's sessions", mgrOtherSessions.status === 403 || (ok(mgrOtherSessions) && list(mgrOtherSessions.json).length === 0), mgrOtherSessions.json);

  const offer = await req("POST", `/hubs/${H}/service-offerings`, { serviceTypeId: st.json.id }, M());
  must("offering: proposed by hub manager", ok(offer), offer.json);
  const offerId = offer.json.id ?? offer.json.offering?.id;
  const mgrApprove = await req("POST", `/hubs/${H}/service-offerings/${offerId}/approve`, {}, M());
  check("hub manager cannot approve own offering (403)", mgrApprove.status === 403, mgrApprove.json);
  must("offering: approved by clinical ops", ok(await req("POST", `/hubs/${H}/service-offerings/${offerId}/approve`, {}, C())));
  must("hub: manager assigned", ok(await req("PUT", `/hubs/${H}/manager`, { userId: users.manager.id }, R())));
  const actv = await req("POST", `/hubs/${H}/status`, { status: "active", reason: "E2E launch after checklist" }, R());
  must("hub: activated", ok(actv), actv.json);

  const station = await req("POST", `/hubs/${H}/stations`, { code: "VIT1", name: "Vitals 1", stationType: "vitals" }, M());
  must("station: vitals created", ok(station), station.json);
  const S1 = station.json.id as string;
  const bpm = await req("POST", "/equipment", { hubId: H, stationId: S1, assetTag: `E2E-BPM-${RUN}`, category: "bp_monitor", make: "Omron", model: "HEM-7120", serialNumber: `SN-${RUN}`, supportedObservationCodes: ["bp_systolic", "bp_diastolic", "heart_rate"], supportedUnits: ["mmHg", "/min"], nextCalibrationDue: "2030-01-01" }, M());
  must("equipment: bp monitor registered", ok(bpm), bpm.json);
  const EQ = bpm.json.id as string;

  // session: starts in ~3 minutes, today in Asia/Dhaka
  const startsAt = new Date(Date.now() + 3 * 60_000);
  startsAt.setSeconds(0, 0);
  const endsAt = new Date(startsAt.getTime() + 3 * 3600_000);
  const sess = await req("POST", "/sessions", { hubId: H, serviceTypeId: st.json.id, title: `E2E clinic ${RUN}`, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), appointmentCapacity: 12, walkInCapacity: 4, slotMinutes: 15, patientDescription: "Bring any previous prescriptions.", patientDescriptionBn: "আগের প্রেসক্রিপশন সাথে আনুন।" }, M());
  must("session: created (draft)", ok(sess) && sess.json.status === "draft", sess.json);
  const SID = sess.json.id as string;
  const notReady = await req("GET", `/sessions/${SID}/readiness`, undefined, M());
  check("session: readiness reports unmet requirements", ok(notReady) && notReady.json.ready === false && notReady.json.unmet.length > 0, notReady.json);
  const earlyPublish = await req("POST", `/sessions/${SID}/publish`, {}, M());
  check("session: publish refused while not ready (422)", earlyPublish.status === 422, earlyPublish.json);
  const mgrOverride = await req("POST", `/sessions/${SID}/publish`, { overrideReason: "Hub manager tries to override" }, M());
  check("session: hub manager cannot override readiness", mgrOverride.status === 403 || mgrOverride.status === 422, mgrOverride.json);

  const slots = await req("POST", `/sessions/${SID}/slots/generate`, {}, M());
  must("session: slots generated", ok(slots), slots.json);

  const shiftW = await req("POST", "/shifts", { userId: users.worker.id, hubId: H, sessionId: SID, stationId: S1, role: "field_health_worker", startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() }, M());
  must("shift: worker proposed", ok(shiftW), shiftW.json);
  const shiftD = await req("POST", "/shifts", { userId: users.doctor.id, hubId: H, sessionId: SID, role: "local_doctor", startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() }, M());
  must("shift: doctor proposed", ok(shiftD), shiftD.json);
  const mgrApproveShift = await req("POST", `/shifts/${shiftW.json.id}/approve`, {}, M());
  check("shift: hub manager cannot approve a credentialed shift (403)", mgrApproveShift.status === 403, mgrApproveShift.json);
  must("shift: worker approved by regional", ok(await req("POST", `/shifts/${shiftW.json.id}/approve`, {}, R())));
  must("shift: doctor approved by regional", ok(await req("POST", `/shifts/${shiftD.json.id}/approve`, {}, R())));
  const overlap = await req("POST", "/shifts", { userId: users.worker.id, hubId: H, role: "field_health_worker", startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() }, M());
  check("shift: overlapping shift refused (409)", overlap.status === 409, overlap.json);

  const seq = await req("POST", `/sessions/${SID}/equipment`, { equipmentId: EQ, stationId: S1 }, M());
  must("session equipment: bp monitor assigned", ok(seq), seq.json);
  const ready = await req("GET", `/sessions/${SID}/readiness`, undefined, M());
  must("session: readiness passes", ok(ready) && ready.json.ready === true, ready.json);
  const pub = await req("POST", `/sessions/${SID}/publish`, {}, M());
  must("session: published", ok(pub), pub.json);
  const open = await req("POST", `/sessions/${SID}/open-booking`, {}, M());
  must("session: open for booking", ok(open), open.json);

  // ---- 5. patients -------------------------------------------------------------------
  const phoneTail = String(Date.now()).slice(-8);
  const phone1 = `+88017${phoneTail}`;
  const phone2 = `+88018${phoneTail}`;
  const reg1 = await req("POST", "/patients", { hubId: H, fullName: `Rahima Begum ${RUN}`, sex: "female", birthYearEstimated: 1968, phone: phone1, regionId: dist.json.id }, users.reception.token);
  must("patient 1: registered by reception", ok(reg1) && !!reg1.json.patient?.id, reg1.json);
  check("patient 1: no duplicate candidates", (reg1.json.duplicateCandidates ?? []).length === 0, reg1.json.duplicateCandidates);
  const reg2 = await req("POST", "/patients", { hubId: H, fullName: `Karim Uddin ${RUN}`, sex: "male", birthYearEstimated: 1975, phone: phone2, regionId: dist.json.id }, users.reception.token);
  must("patient 2: registered", ok(reg2) && !!reg2.json.patient?.id, reg2.json);
  const P1 = reg1.json.patient.id as string;
  const P2 = reg2.json.patient.id as string;
  check("registration response has no full phone", !reg1.text.includes(phoneTail), reg1.json.patient);

  const pt1 = await patientLogin(phone1);
  const pt2 = await patientLogin(phone2);
  const staffOnPatient = await req("GET", "/patient/me", undefined, users.reception.token);
  check("staff token refused on patient routes (403)", staffOnPatient.status === 403, staffOnPatient.json);
  const patientOnStaff = await req("GET", `/sessions/${SID}`, undefined, pt1);
  check("patient token refused on staff routes (403)", patientOnStaff.status === 403, patientOnStaff.json);

  const hubs = await req("GET", "/patient/hubs", undefined, pt1);
  must("patient: hub discovery includes the catchment hub", ok(hubs) && list(hubs.json).some((h: any) => h.id === H), hubs.json);
  check("patient: discovery exposes no staff", !hubs.text.includes(users.manager.email) && !hubs.text.includes("managerUserId"), undefined);
  const ps = await req("GET", `/patient/hubs/${H}/sessions`, undefined, pt1);
  const psRow = list(ps.json).find((s: any) => s.id === SID);
  must("patient: open session visible with slots", ok(ps) && !!psRow && (psRow.slots?.length ?? 0) > 0, ps.json);
  const slotId = psRow.slots.find((s: any) => s.available > 0).id;

  const key = `e2e-${RUN}-book-1`;
  const book = await req("POST", "/patient/appointments", { sessionId: SID, slotId }, pt1, { "Idempotency-Key": key });
  must("patient: booked a slot", ok(book) && !!book.json.id, book.json);
  const APPT = book.json.id as string;
  const replay = await req("POST", "/patient/appointments", { sessionId: SID, slotId }, pt1, { "Idempotency-Key": key });
  check("patient: idempotent replay returns the same appointment", ok(replay) && replay.json.id === APPT, replay.json);
  const dup = await req("POST", "/patient/appointments", { sessionId: SID, slotId }, pt1, { "Idempotency-Key": `${key}-again` });
  check("patient: second active booking for same session refused (409)", dup.status === 409, dup.json);
  const mine = await req("GET", "/patient/appointments", undefined, pt1);
  check("patient: my appointments lists it", ok(mine) && JSON.stringify(mine.json).includes(APPT), mine.json);
  const peek = await req("GET", `/patient/appointments/${APPT}`, undefined, pt2);
  check("another patient cannot read the appointment (404)", peek.status === 404, peek.json);
  const apptCode = book.json.code as string;

  // ---- 6. front desk ---------------------------------------------------------------
  const lookup = await req("POST", "/patients/lookup", { by: "appointment_code", value: apptCode, hubId: H }, users.reception.token);
  must("reception: lookup by appointment code finds the patient", ok(lookup) && lookup.json.matches?.[0]?.id === P1 && lookup.json.appointment?.id === APPT, lookup.json);
  check("reception: lookup view is minimal (no full phone)", !lookup.text.includes(phoneTail), lookup.json.matches?.[0]);
  const noConfirm = await req("POST", `/appointments/${APPT}/check-in`, {}, users.reception.token);
  check("check-in refused without identity confirmation (400)", noConfirm.status === 400, noConfirm.json);
  const ci = await req("POST", `/appointments/${APPT}/check-in`, { identityConfirmed: true }, users.reception.token);
  must("reception: checked in (encounter + queue ticket)", ok(ci) && !!ci.json.encounter?.id && !!ci.json.ticket?.id, ci.json);
  const ENC = ci.json.encounter.id as string;
  const queue = await req("GET", `/sessions/${SID}/queue`, undefined, users.reception.token);
  check("queue view lists the ticket", ok(queue) && queue.text.includes(ci.json.ticket.displayCode), queue.json);
  const board = await req("GET", `/display/sessions/${SID}/board`, undefined, users.reception.token);
  check("display board shows no patient names", ok(board) && !board.text.includes("Rahima") && board.text.includes(ci.json.ticket.displayCode), board.json);
  const recDoctor = await req("GET", `/doctor/encounters/${ENC}`, undefined, users.reception.token);
  check("receptionist cannot open the clinical encounter view (403)", recDoctor.status === 403, recDoctor.json);
  const recTimeline = await req("GET", `/doctor/patients/${P1}/timeline`, undefined, users.reception.token);
  check("receptionist cannot read the vitals timeline (403)", recTimeline.status === 403, recTimeline.json);

  const assign = await req("POST", `/encounters/${ENC}/assign`, { userId: users.worker.id, role: "field_health_worker", stationId: S1 }, users.queue.token);
  must("queue coordinator: encounter assigned to the worker", ok(assign), assign.json);

  // walk-in for patient 2 (second encounter, not assigned to the worker)
  const walk = await req("POST", `/sessions/${SID}/walk-ins`, { identityConfirmed: true, patientId: P2 }, users.reception.token);
  must("reception: walk-in registered for patient 2", ok(walk) && !!walk.json.encounter?.id, walk.json);
  const ENC2 = walk.json.encounter.id as string;

  // ---- 7. team app ----------------------------------------------------------------
  const W = () => users.worker.token;
  const dev = await req("POST", "/team/devices", { platform: "android", appVersion: "1.4.0", deviceModel: "E2E tablet", hubId: H }, W());
  must("worker: device registered", ok(dev) && !!dev.json.id, dev.json);
  const DH = { "X-Device-Id": dev.json.id as string };
  const tasks = await req("GET", "/team/tasks", undefined, W(), DH);
  const task = list(tasks.json).find((t: any) => t.encounter?.id === ENC);
  must("worker: task list contains the encounter", ok(tasks) && !!task, tasks.json);
  check("worker: task list does not include patient 2's walk-in", !list(tasks.json).some((t: any) => t.encounter?.id === ENC2));
  must("worker: assignment accepted", ok(await req("POST", `/team/assignments/${task.assignmentId}/accept`, {}, W(), DH)));
  const started = await req("POST", `/team/assignments/${task.assignmentId}/start`, {}, W(), DH);
  must("worker: encounter started", ok(started) && started.json.status === "in_progress", started.json);
  const cs = await req("GET", `/team/encounters/${ENC}/consent`, undefined, W(), DH);
  check("worker: consent initially missing", ok(cs) && cs.json.satisfied === false, cs.json);

  const now = () => new Date().toISOString();
  const group = randomUUID();
  const items = [
    { id: randomUUID(), idempotencyKey: `e2e-${RUN}-sys`, encounterId: ENC, observationCode: "bp_systolic", valueNumeric: 185, unit: "mmHg", bodySite: "left_arm", posture: "sitting", measuredAt: now(), clientRecordedAt: now(), equipmentId: EQ, readingGroupId: group },
    { id: randomUUID(), idempotencyKey: `e2e-${RUN}-dia`, encounterId: ENC, observationCode: "bp_diastolic", valueNumeric: 95, unit: "mmHg", bodySite: "left_arm", posture: "sitting", measuredAt: now(), clientRecordedAt: now(), equipmentId: EQ, readingGroupId: group },
    { id: randomUUID(), idempotencyKey: `e2e-${RUN}-hr`, encounterId: ENC, observationCode: "heart_rate", valueNumeric: 80, unit: "/min", measuredAt: now(), clientRecordedAt: now(), equipmentId: EQ },
  ];
  const noConsent = await req("POST", "/team/sync/observations", { items: [items[0]] }, W(), DH);
  check("capture refused while consent is missing", noConsent.status === 403 || noConsent.status === 409 || noConsent.json?.results?.[0]?.status === "rejected", noConsent.json);
  // a refused item must not have consumed its idempotency key into an accepted row
  for (const purpose of ["hub_service", "health_data_processing"] as const) {
    const cc = await req("POST", `/team/encounters/${ENC}/consents`, { templateId: templates[purpose], method: "app_acceptance" }, W(), DH);
    must(`worker: ${purpose} consent captured`, ok(cc), cc.json);
  }
  const cs2 = await req("GET", `/team/encounters/${ENC}/consent`, undefined, W(), DH);
  check("worker: consent now satisfied", cs2.json?.satisfied === true, cs2.json);

  if (noConsent.json?.results?.[0]?.status === "rejected") items[0] = { ...items[0]!, idempotencyKey: `e2e-${RUN}-sys-2` };
  const sync = await req("POST", "/team/sync/observations", { items }, W(), DH);
  const results = sync.json?.results ?? [];
  must("worker: 3 observations accepted", ok(sync) && results.length === 3 && results.every((r: any) => r.status === "accepted"), sync.json);
  const alertOut = results.find((r: any) => r.alerts?.length)?.alerts?.[0];
  check("worker: high systolic produced a contact_doctor alert", alertOut?.action === "contact_doctor", results);
  const again = await req("POST", "/team/sync/observations", { items }, W(), DH);
  check("worker: re-sync returns duplicate (no second row)", ok(again) && again.json.results.every((r: any) => r.status === "duplicate"), again.json);
  const zeroMissing = await req("POST", "/team/sync/observations", { items: [{ ...items[2]!, id: randomUUID(), idempotencyKey: `e2e-${RUN}-badunit`, unit: "mmHg" }] }, W(), DH);
  check("worker: wrong unit rejected", zeroMissing.json?.results?.[0]?.status === "rejected", zeroMissing.json);
  const foreign = await req("POST", "/team/sync/observations", { items: [{ ...items[2]!, id: randomUUID(), idempotencyKey: `e2e-${RUN}-foreign`, encounterId: ENC2 }] }, W(), DH);
  const fr = foreign.json?.results?.[0]?.status;
  check("worker: sync to an unassigned encounter is not accepted", foreign.status === 403 || fr === "rejected" || fr === "quarantined", foreign.json);
  const noDevice = await req("POST", "/team/sync/observations", { items: [{ ...items[2]!, id: randomUUID(), idempotencyKey: `e2e-${RUN}-nodev` }] }, W());
  check("worker: capture without a registered device refused", !ok(noDevice) || noDevice.json?.results?.[0]?.status === "rejected", noDevice.json);

  const sub = await req("POST", `/team/encounters/${ENC}/submit`, {}, W(), DH);
  must("worker: encounter submitted for review", ok(sub) && (sub.json.status ?? sub.json.encounterStatus) === "submitted_for_review", sub.json);

  // website view after capture: completeness, no values
  const opv = await req("GET", `/encounters/${ENC}/operational`, undefined, users.queue.token);
  check("ops view: completeness shown", ok(opv) && JSON.stringify(opv.json).includes("captured"), opv.json);
  check("ops view: contains no measurement values", ok(opv) && !/"value(Numeric|Text|Code)"|185|"mmHg"/.test(opv.text), opv.text.slice(0, 400));

  // ---- 8. doctor ------------------------------------------------------------------
  const D = () => users.doctor.token;
  const rq = await req("GET", "/doctor/review-queue", undefined, D());
  check("doctor: review queue contains the encounter", ok(rq) && JSON.stringify(rq.json).includes(ENC), rq.json);
  const dv = await req("GET", `/doctor/encounters/${ENC}`, undefined, D());
  must("doctor: clinical view loads", ok(dv), dv.json);
  check("doctor: view has provenance (performer, device, server time)", dv.text.includes(users.worker.id) || (dv.text.includes("performer") && dv.text.includes("serverReceivedAt")), dv.text.slice(0, 300));
  const alertIds: string[] = [];
  JSON.stringify(dv.json, (k, v) => {
    if (v && typeof v === "object" && "action" in v && "severity" in v && typeof v.id === "string" && ("status" in v)) alertIds.push(v.id);
    return v;
  });
  must("doctor: alert visible", alertIds.length > 0, dv.json?.alerts);
  const earlyClose = await req("POST", `/doctor/encounters/${ENC}/close`, { disposition: "completed" }, D());
  check("doctor: close refused while an alert is open (409)", earlyClose.status === 409, earlyClose.json);
  for (const id of alertIds) {
    const rs = await req("POST", `/doctor/alerts/${id}/resolve`, { resolutionNote: "Reviewed; repeat in two weeks" }, D());
    must("doctor: alert resolved", ok(rs), rs.json);
  }
  const workerReview = await req("POST", `/doctor/encounters/${ENC}/reviews`, { decision: "reviewed_no_action" }, W());
  check("worker cannot submit a doctor review (403)", workerReview.status === 403, workerReview.json);
  const rv = await req("POST", `/doctor/encounters/${ENC}/reviews`, { decision: "reviewed_no_action", summary: "Elevated BP; lifestyle advice given" }, D());
  must("doctor: review recorded", ok(rv), rv.json);
  const note = await req("POST", `/doctor/encounters/${ENC}/notes`, { noteType: "follow_up_instruction", content: "Reduce salt. Return for a BP check in 2 weeks.", language: "en", patientVisible: true }, D());
  must("doctor: patient-visible follow-up instruction added", ok(note), note.json);
  const close = await req("POST", `/doctor/encounters/${ENC}/close`, { disposition: "completed" }, D());
  must("doctor: encounter closed (completed)", ok(close), close.json);

  // late sync after close → quarantined
  const late = await req("POST", "/team/sync/observations", { items: [{ ...items[2]!, id: randomUUID(), idempotencyKey: `e2e-${RUN}-late` }] }, W(), DH);
  check("late sync to a closed encounter is quarantined", late.json?.results?.[0]?.status === "quarantined", late.json);

  // ---- 9. patient sees results --------------------------------------------------------
  const res = await req("GET", "/patient/results", undefined, pt1);
  const obs = list(res.json);
  const flat = JSON.stringify(res.json);
  check("patient: 3 results visible", ok(res) && obs.length === 3, res.json);
  check("patient: results carry provenance (hub + performer)", flat.includes(hub.json.name) && /performer|recordedBy|measuredBy/.test(flat), flat.slice(0, 400));
  check("patient: results flagged as doctor-reviewed", /"reviewed(ByDoctor)?":true|"reviewStatus":"reviewed"|"doctorReviewed":true/.test(flat), flat.slice(0, 400));
  check("patient: quarantined late reading is NOT in results", obs.filter((o: any) => (o.observationCode ?? o.code) === "heart_rate").length === 1, obs);
  const ins = await req("GET", "/patient/instructions", undefined, pt1);
  check("patient: follow-up instruction visible", ok(ins) && ins.text.includes("Reduce salt"), ins.json);
  const p2res = await req("GET", "/patient/results", undefined, pt2);
  check("patient 2 sees none of patient 1's results", ok(p2res) && list(p2res.json).length === 0, p2res.json);
  const apptDone = await req("GET", `/patient/appointments/${APPT}`, undefined, pt1);
  check("patient: appointment completed", ok(apptDone) && (apptDone.json.status ?? apptDone.json.appointment?.status) === "completed", apptDone.json);

  // ---- 10. operations ------------------------------------------------------------------
  const dash = await req("GET", `/dashboard/overview?hubId=${H}`, undefined, M());
  check("dashboard: overview loads for hub manager", ok(dash), dash.json);
  check("dashboard: no patient names", ok(dash) && !dash.text.includes("Rahima") && !dash.text.includes("Karim"));
  const today = new Date(Date.now() + 6 * 3600_000).toISOString().slice(0, 10);
  const att = await req("GET", `/reports/attendance?from=${today}&to=${today}&hubId=${H}`, undefined, M());
  check("report: attendance includes the session", ok(att) && att.text.includes(SID), att.json);
  const recReport = await req("GET", `/reports/attendance?from=${today}&to=${today}&hubId=${hub2.json.id}`, undefined, users.reception.token);
  check("report: receptionist refused for another hub (403)", recReport.status === 403, recReport.json);
  for (const action of ["auth.login", "patient.checked_in", "observation.create", "clinical_review.create", "encounter.close"]) {
    const a = await req("GET", `/audit-events?action=${encodeURIComponent(action)}&limit=50`, undefined, A);
    check(`audit: '${action}' recorded`, ok(a) && list(a.json).some((e: any) => e.action === action), a.json);
  }
  const auditMgr = await req("GET", `/audit-events?hubId=${H}&limit=100`, undefined, M());
  check("audit: hub manager sees only non-patient events", ok(auditMgr) && list(auditMgr.json).every((e: any) => e.patientId == null), auditMgr.json);

  // ---- 11. revocation takes effect on the next request -----------------------------------
  const beforeRevoke = await req("GET", `/sessions/${SID}/queue`, undefined, users.reception.token);
  check("receptionist can read the queue before revocation", ok(beforeRevoke), beforeRevoke.json);
  const rvk = await req("POST", `/admin/role-assignments/${grants.reception}/revoke`, { reason: "E2E: left the hub" }, R());
  must("regional: receptionist role revoked", ok(rvk), rvk.json);
  const afterRevoke = await req("GET", `/sessions/${SID}/queue`, undefined, users.reception.token);
  check("revoked receptionist loses access immediately (403)", afterRevoke.status === 403, afterRevoke.json);

  // ---- 12. sessions: logout ------------------------------------------------------------
  await req("POST", "/auth/logout", {}, users.worker.token);
  const afterLogout = await req("GET", "/team/tasks", undefined, users.worker.token, DH);
  check("logout invalidates the worker's access token (401)", afterLogout.status === 401, afterLogout.json);
}

main()
  .catch((e) => {
    if (!(e instanceof Abort)) {
      failures.push(`crash: ${(e as Error).message}`);
      console.error(e);
    } else console.log(`ABORTED at: ${e.message}`);
  })
  .finally(() => {
    console.log(`\n${passed} passed, ${failures.length} failed${failures.length ? `\n - ${failures.join("\n - ")}` : ""}`);
    process.exit(failures.length ? 1 : 0);
  });
