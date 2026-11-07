import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Minimal HS256 JWT. In production the Healora central identity service
 * issues tokens; this service only verifies them with the shared secret
 * (or swap `verifyJwt` for JWKS/RS256 verification).
 *
 * Staff token:   { sub: <identity.user.id>, typ: "staff", amr?: ["pwd","otp"] }
 * Patient token: { sub: <clinical.patient.id>, typ: "patient", rep?: <representative id> }
 */
export interface JwtClaims {
  sub: string;
  typ: "staff" | "patient";
  iat: number;
  exp: number;
  /** Authentication methods; "otp"/"mfa" marks a strong login. */
  amr?: string[];
  /** Caregiver acting for the patient (patient tokens only). */
  rep?: string;
  /** Auth-session id; the guard checks the session is still live on every request. */
  sid?: string;
  /** Password change required: only /auth/* and /me are reachable. */
  pcr?: boolean;
}

const b64url = (buf: Buffer | string) =>
  Buffer.from(buf).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const fromB64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

function secret(): string {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 32) throw new Error("JWT_SECRET must be set (>= 32 chars)");
  return s;
}

export function signJwt(claims: Omit<JwtClaims, "iat" | "exp">, ttlSeconds = 15 * 60): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ ...claims, iat: now, exp: now + ttlSeconds }));
  const sig = b64url(createHmac("sha256", secret()).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${sig}`;
}

export function verifyJwt(token: string): JwtClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts as [string, string, string];
  try {
    const h = JSON.parse(fromB64url(header).toString("utf8"));
    if (h.alg !== "HS256") return null;
    const expected = createHmac("sha256", secret()).update(`${header}.${payload}`).digest();
    const given = fromB64url(sig);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const claims = JSON.parse(fromB64url(payload).toString("utf8")) as JwtClaims;
    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.exp !== "number" || claims.exp < now) return null;
    if (claims.typ !== "staff" && claims.typ !== "patient") return null;
    if (typeof claims.sub !== "string") return null;
    return claims;
  } catch {
    return null;
  }
}
