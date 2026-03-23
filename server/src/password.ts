import crypto from "node:crypto";

type ScryptParams = { N: number; r: number; p: number; keyLen: number };

const DEFAULT_PARAMS: ScryptParams = { N: 16384, r: 8, p: 1, keyLen: 32 };

function b64u(buf: Buffer): string {
  return buf.toString("base64url");
}

function b64uToBuf(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, DEFAULT_PARAMS.keyLen, {
    N: DEFAULT_PARAMS.N,
    r: DEFAULT_PARAMS.r,
    p: DEFAULT_PARAMS.p,
    maxmem: 64 * 1024 * 1024,
  });

  return `scrypt$${DEFAULT_PARAMS.N}$${DEFAULT_PARAMS.r}$${DEFAULT_PARAMS.p}$${b64u(salt)}$${b64u(
    key as Buffer,
  )}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6) return false;
  const [algo, nStr, rStr, pStr, saltB64, hashB64] = parts;
  if (algo !== "scrypt") return false;

  const N = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  const salt = b64uToBuf(saltB64);
  const expected = b64uToBuf(hashB64);

  const derived = crypto.scryptSync(password, salt, expected.length, {
    N,
    r,
    p,
    maxmem: 64 * 1024 * 1024,
  }) as Buffer;

  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

