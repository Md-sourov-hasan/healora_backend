import { currentStep, totpAt } from "../src/modules/auth/crypto.ts";
const B = process.env.API_BASE ?? "http://localhost:3077/api/v1";
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => { cond ? pass++ : fail++; console.log(`${cond ? "PASS" : "FAIL"} ${name}`, cond ? "" : JSON.stringify(extra)); };
async function req(method: string, path: string, body?: unknown, token?: string) {
  const r = await fetch(B + path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json: any = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json };
}
const email = process.env.ADMIN_EMAIL ?? "admin@healora.local";
const TEMP = process.env.ADMIN_TEMP_PASSWORD ?? "Bootstrap#Temp2026x";
// devtokens disabled
check("dev token disabled", (await req("POST", "/dev/token", { userId: "01a1b0ad-eef0-7025-a835-fe565c48b624" })).status === 403);
// wrong password generic
const bad = await req("POST", "/auth/staff/login", { email, password: "wrong-password-1A!" });
check("wrong password → 401 generic", bad.status === 401 && bad.json.code === "INVALID_CREDENTIALS", bad);
const unknown = await req("POST", "/auth/staff/login", { email: "nobody@x.io", password: "whatever-1A!" });
check("unknown account → same 401", unknown.status === 401 && unknown.json.code === "INVALID_CREDENTIALS");
// temp password login
const l1 = await req("POST", "/auth/staff/login", { email, password: TEMP });
check("temp login ok + passwordChangeRequired", l1.status === 200 && l1.json.passwordChangeRequired === true && l1.json.mfaEnrollmentRequired === true, l1);
const t1 = l1.json.accessToken;
check("pcr gate blocks /hubs", (await req("GET", "/hubs", undefined, t1)).json?.code === "PASSWORD_CHANGE_REQUIRED");
check("pcr allows /me", (await req("GET", "/me", undefined, t1)).status === 200);
const weak = await req("POST", "/auth/staff/password", { currentPassword: TEMP, newPassword: "short" }, t1);
check("weak password rejected", weak.status === 400 && weak.json.code === "WEAK_PASSWORD", weak);
const ch = await req("POST", "/auth/staff/password", { currentPassword: TEMP, newPassword: "Str0ng!Passphrase#2026" }, t1);
check("password changed", ch.status === 200, ch);
const r1 = await req("POST", "/auth/refresh", { refreshToken: l1.json.refreshToken });
check("refresh after change", r1.status === 200, r1);
const t2 = r1.json.accessToken;
// no MFA yet: privileged actions blocked (REQUIRE_MFA_FOR_PRIVILEGED)
const hubsNoMfa = await req("GET", "/hubs", undefined, t2);
check("privileged w/o MFA → MFA_REQUIRED", hubsNoMfa.json?.code === "MFA_REQUIRED", hubsNoMfa);
// enroll mfa
const en = await req("POST", "/auth/staff/mfa/enroll", undefined, t2);
check("mfa enroll returns otpauth", en.status === 201 && en.json.otpauthUri?.startsWith("otpauth://"), en);
const secret = en.json.secret;
const conf = await req("POST", "/auth/staff/mfa/confirm", { code: totpAt(secret, currentStep()) }, t2);
check("mfa confirmed", conf.status === 200, conf);
// refresh reuse detection
const r2 = await req("POST", "/auth/refresh", { refreshToken: r1.json.refreshToken });
check("rotation ok", r2.status === 200);
const reuse = await req("POST", "/auth/refresh", { refreshToken: r1.json.refreshToken });
check("old refresh token reuse → 401", reuse.status === 401);
const afterReuse = await req("GET", "/me", undefined, r2.json.accessToken);
check("reuse revoked whole family (access token dead)", afterReuse.status === 401, afterReuse);
// login with MFA
const l2 = await req("POST", "/auth/staff/login", { email, password: "Str0ng!Passphrase#2026" });
check("login requires MFA", l2.status === 200 && l2.json.mfaRequired === true, l2);
const badCode = await req("POST", "/auth/staff/mfa/verify", { challengeId: l2.json.challengeId, code: "000000" });
check("bad TOTP → 401", badCode.status === 401);
await new Promise((r) => setTimeout(r, 31000)); // next TOTP step (replay protection rejects the step used at confirm)
const mv = await req("POST", "/auth/staff/mfa/verify", { challengeId: l2.json.challengeId, code: totpAt(secret, currentStep()) });
check("TOTP login ok", mv.status === 200 && mv.json.accessToken, mv);
const t3 = mv.json.accessToken;
check("privileged with MFA works", (await req("GET", "/hubs", undefined, t3)).status === 200);
const replay = await req("POST", "/auth/staff/mfa/verify", { challengeId: l2.json.challengeId, code: totpAt(secret, currentStep()) });
check("challenge single-use", replay.status === 401);
const sess = await req("GET", "/auth/sessions", undefined, t3);
check("sessions list has current", Array.isArray(sess.json) && sess.json.some((s: any) => s.current), sess);
await req("POST", "/auth/logout", {}, t3);
check("logout kills access token immediately", (await req("GET", "/me", undefined, t3)).status === 401);
check("logout kills refresh token", (await req("POST", "/auth/refresh", { refreshToken: mv.json.refreshToken })).status === 401);
// lockout
for (let i = 0; i < 5; i++) await req("POST", "/auth/staff/login", { email, password: "nope-Wrong#1234" });
const locked = await req("POST", "/auth/staff/login", { email, password: "Str0ng!Passphrase#2026" });
check("locked after 5 failures (correct password refused)", locked.status === 401, locked);
// patient OTP: unknown phone answers identically
const otp = await req("POST", "/auth/patient/otp", { phone: "01700000000" });
check("otp unknown phone → 202 no hint", otp.status === 202 && otp.json.challengeId && !("devCode" in otp.json), otp);
const v = await req("POST", "/auth/patient/otp/verify", { challengeId: otp.json.challengeId, code: "123456" });
check("otp verify unknown → 401", v.status === 401);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
