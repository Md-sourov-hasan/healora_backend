import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;

// ---- passwords (scrypt, PHC-like string) -----------------------------------

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password.normalize("NFKC"), salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, saltB64, hashB64] = stored.split("$");
  if (alg !== "scrypt" || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  const actual = await scrypt(password.normalize("NFKC"), Buffer.from(saltB64, "base64"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** A hash to compare against when the account doesn't exist (constant-time-ish login). */
export const DUMMY_PASSWORD_HASH = "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

export function passwordProblems(password: string, email: string): string[] {
  const problems: string[] = [];
  if (password.length < 12) problems.push("at least 12 characters");
  if (password.length > 128) problems.push("at most 128 characters");
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (classes < 3) problems.push("at least three of: lowercase, uppercase, digit, symbol");
  const local = email.split("@")[0]?.toLowerCase();
  if (local && local.length >= 4 && password.toLowerCase().includes(local)) problems.push("must not contain your email name");
  return problems;
}

export function temporaryPassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < 14; i++) out += alphabet[randomInt(alphabet.length)];
  return `${out}#7`;
}

// ---- opaque tokens & codes ---------------------------------------------------

export const newRefreshToken = () => randomBytes(32).toString("base64url");
export const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

/** Keyed hash for OTP codes and phone numbers (not reversible, not guessable offline). */
export function keyedHash(value: string): string {
  const key = process.env.IDENTIFIER_HASH_KEY ?? process.env.JWT_SECRET ?? "";
  return createHmac("sha256", key).update(value).digest("hex");
}

export function numericCode(digits = 6): string {
  return String(randomInt(0, 10 ** digits)).padStart(digits, "0");
}

export function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && timingSafeEqual(x, y);
}

// ---- secret encryption (AES-256-GCM) ------------------------------------------

function encKey(): Buffer {
  const raw = process.env.AUTH_ENCRYPTION_KEY ?? process.env.JWT_SECRET;
  if (!raw || raw.length < 32) throw new Error("AUTH_ENCRYPTION_KEY must be set (>= 32 chars)");
  return createHash("sha256").update(raw).digest();
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encKey(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64")}.${cipher.getAuthTag().toString("base64")}.${data.toString("base64")}`;
}

export function decrypt(blob: string): string {
  const [v, iv, tag, data] = blob.split(".");
  if (v !== "v1" || !iv || !tag || !data) throw new Error("bad ciphertext");
  const decipher = createDecipheriv("aes-256-gcm", encKey(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}

// ---- TOTP (RFC 6238, SHA-1, 30 s, 6 digits) ------------------------------------

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, "").toUpperCase().replace(/\s+/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error("bad base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const newTotpSecret = () => base32Encode(randomBytes(20));

export function totpAt(secretB32: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", base32Decode(secretB32)).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0xf;
  const bin = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(bin % 1_000_000).padStart(6, "0");
}

export const currentStep = (now = Date.now()) => Math.floor(now / 1000 / 30);

/** Returns the matched step (for replay protection) or null. Window ±1 step. */
export function verifyTotp(secretB32: string, code: string, lastUsedStep: number | null): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const now = currentStep();
  for (const step of [now - 1, now, now + 1]) {
    if (lastUsedStep !== null && step <= lastUsedStep) continue;
    const expected = Buffer.from(totpAt(secretB32, step));
    const given = Buffer.from(code);
    if (expected.length === given.length && timingSafeEqual(expected, given)) return step;
  }
  return null;
}

export function otpauthUri(secretB32: string, account: string): string {
  const issuer = "Healora Hub";
  return `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
