/**
 * One-time bootstrap: creates the first platform super admin and the baseline
 * observation catalogue. Idempotent — safe to run again.
 *
 *   DATABASE_URL=... ADMIN_EMAIL=ops@healora.example npx tsx scripts/bootstrap.ts
 *
 * Thresholds, protocols and consent wording are NOT seeded: those must be
 * authored and approved by clinical governance (PRD §13.2, §17.4).
 */
import "temporal-polyfill/global";

import { hashPassword, temporaryPassword } from "../src/modules/auth/crypto.ts";
import { db } from "../src/prisma/db.ts";

const email = process.env.ADMIN_EMAIL ?? "admin@healora.local";

const OBSERVATIONS = [
  { code: "bp_systolic", name: "Systolic blood pressure", nameBn: "সিস্টোলিক রক্তচাপ", valueType: "quantity", canonicalUnit: "mmHg", allowedUnits: ["mmHg"], plausibleMin: "40", plausibleMax: "300", allowedSites: ["left_arm", "right_arm"], allowedMethods: ["automatic", "manual"], allowedContexts: ["sitting", "standing", "lying"] },
  { code: "bp_diastolic", name: "Diastolic blood pressure", nameBn: "ডায়াস্টোলিক রক্তচাপ", valueType: "quantity", canonicalUnit: "mmHg", allowedUnits: ["mmHg"], plausibleMin: "20", plausibleMax: "200", allowedSites: ["left_arm", "right_arm"], allowedMethods: ["automatic", "manual"], allowedContexts: ["sitting", "standing", "lying"] },
  { code: "heart_rate", name: "Pulse / heart rate", nameBn: "নাড়ির গতি", valueType: "quantity", canonicalUnit: "/min", allowedUnits: ["/min"], plausibleMin: "20", plausibleMax: "250", allowedSites: [], allowedMethods: ["device", "manual"], allowedContexts: [] },
  { code: "spo2", name: "Oxygen saturation", nameBn: "অক্সিজেন স্যাচুরেশন", valueType: "quantity", canonicalUnit: "%", allowedUnits: ["%"], plausibleMin: "50", plausibleMax: "100", allowedSites: ["finger"], allowedMethods: ["pulse_oximeter"], allowedContexts: ["room_air", "supplemental_oxygen"] },
  { code: "body_temperature", name: "Body temperature", nameBn: "শরীরের তাপমাত্রা", valueType: "quantity", canonicalUnit: "Cel", allowedUnits: ["Cel", "[degF]"], plausibleMin: "30", plausibleMax: "113", allowedSites: ["oral", "axillary", "tympanic", "forehead"], allowedMethods: ["digital", "infrared"], allowedContexts: [] },
  { code: "respiratory_rate", name: "Respiratory rate", nameBn: "শ্বাস-প্রশ্বাসের হার", valueType: "quantity", canonicalUnit: "/min", allowedUnits: ["/min"], plausibleMin: "4", plausibleMax: "80", allowedSites: [], allowedMethods: ["observed"], allowedContexts: [] },
  { code: "body_height", name: "Height", nameBn: "উচ্চতা", valueType: "quantity", canonicalUnit: "cm", allowedUnits: ["cm"], plausibleMin: "30", plausibleMax: "250", allowedSites: [], allowedMethods: ["stadiometer", "tape"], allowedContexts: [] },
  { code: "body_weight", name: "Weight", nameBn: "ওজন", valueType: "quantity", canonicalUnit: "kg", allowedUnits: ["kg"], plausibleMin: "1", plausibleMax: "350", allowedSites: [], allowedMethods: ["scale"], allowedContexts: [] },
  { code: "blood_glucose", name: "Blood glucose", nameBn: "রক্তে শর্করা", valueType: "quantity", canonicalUnit: "mmol/L", allowedUnits: ["mmol/L", "mg/dL"], plausibleMin: "0.5", plausibleMax: "600", allowedSites: ["capillary"], allowedMethods: ["glucometer"], allowedContexts: ["fasting", "random", "post_meal"] },
  { code: "pain_score", name: "Pain score (0-10)", nameBn: "ব্যথার মাত্রা (০-১০)", valueType: "scale", canonicalUnit: "{score}", allowedUnits: ["{score}"], plausibleMin: "0", plausibleMax: "10", allowedSites: [], allowedMethods: ["patient_reported"], allowedContexts: [] },
  { code: "bmi", name: "Body mass index (derived)", nameBn: "বিএমআই", valueType: "quantity", canonicalUnit: "kg/m2", allowedUnits: ["kg/m2"], plausibleMin: "5", plausibleMax: "100", allowedSites: [], allowedMethods: ["calculated"], allowedContexts: [], isDerived: true },
] as const;

let admin = await db.orm.identity.User.where({ email }).first();
if (!admin) {
  admin = await db.orm.identity.User.create({ email, name: "Platform Admin", status: "active", mfaEnabled: true });
  console.log(`created admin ${admin.id}`);
}
const hasRole = await db.orm.identity.RoleAssignment.where({ userId: admin.id, role: "platform_super_admin", status: "active" }).first();
if (!hasRole) {
  await db.orm.identity.RoleAssignment.create({
    userId: admin.id,
    role: "platform_super_admin",
    scopeType: "platform",
    validFrom: new Date().toISOString(),
    grantedById: admin.id,
  });
}

// First sign-in: a one-time temporary password that must be changed (then enrol MFA).
const login = await db.orm.identity.StaffLogin.first({ userId: admin.id });
if (!login) {
  const temp = process.env.ADMIN_TEMP_PASSWORD ?? temporaryPassword();
  await db.orm.identity.StaffLogin.create({ userId: admin.id, passwordHash: await hashPassword(temp), passwordUpdatedAt: new Date().toISOString(), mustChangePassword: true });
  console.log(`temporary admin password (shown once): ${temp}`);
}

for (const o of OBSERVATIONS) {
  const exists = await db.orm.clinical.ObservationDefinition.where({ code: o.code }).first();
  if (!exists) await db.orm.clinical.ObservationDefinition.create({ ...o, allowedUnits: [...o.allowedUnits], allowedSites: [...o.allowedSites], allowedMethods: [...o.allowedMethods], allowedContexts: [...o.allowedContexts] });
}

console.log(`admin user id: ${admin.id}`);
await db.close();
