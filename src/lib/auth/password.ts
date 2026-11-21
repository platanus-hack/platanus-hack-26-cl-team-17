/**
 * Hash de contraseñas del personal con scrypt (node:crypto). Solo servidor (Node).
 *
 * Formato autodescriptivo, para poder subir parámetros sin invalidar cuentas:
 *   scrypt$<N>$<r>$<p>$<sal base64url>$<hash base64url>
 */
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

export const SCRYPT_PARAMS = {
  /** Costo de CPU/memoria (potencia de 2). 2^15 con r=8 ≈ 32 MiB por hash. */
  N: 32768,
  r: 8,
  p: 1,
  keylen: 64,
  saltBytes: 16,
} as const;

/** Límites al leer un hash guardado: un string manipulado no debe poder agotar la memoria. */
const MAX_N = 1 << 20;
const MIN_N = 1 << 10;
const MAX_R = 32;
const MAX_P = 16;

/** scrypt usa 128·N·r·p bytes; se deja holgura sobre ese mínimo. */
function maxmemFor(N: number, r: number, p: number): number {
  return 128 * N * r * p + 32 * 1024 * 1024;
}

function scryptAsync(password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const { N, r, p, keylen, saltBytes } = SCRYPT_PARAMS;
  const salt = randomBytes(saltBytes);
  const key = await scryptAsync(password, salt, keylen, { N, r, p, maxmem: maxmemFor(N, r, p) });
  return ["scrypt", N, r, p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

interface ParsedHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

const B64URL = /^[A-Za-z0-9_-]+$/;

function parseIntStrict(s: string): number | null {
  return /^[1-9][0-9]{0,8}$/.test(s) ? Number(s) : null;
}

function parseHash(stored: string): ParsedHash | null {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const N = parseIntStrict(parts[1]);
  const r = parseIntStrict(parts[2]);
  const p = parseIntStrict(parts[3]);
  if (N === null || r === null || p === null) return null;
  if (N < MIN_N || N > MAX_N || (N & (N - 1)) !== 0) return null;
  if (r > MAX_R || p > MAX_P) return null;
  if (!B64URL.test(parts[4]) || !B64URL.test(parts[5])) return null;
  const salt = Buffer.from(parts[4], "base64url");
  const hash = Buffer.from(parts[5], "base64url");
  if (salt.length < 16 || hash.length < 16 || hash.length > 128) return null;
  return { N, r, p, salt, hash };
}

/** true si la contraseña calza con el hash guardado. Nunca lanza: un hash malformado da false. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseHash(stored);
  if (!parsed) return false;
  const { N, r, p, salt, hash } = parsed;
  let key: Buffer;
  try {
    key = await scryptAsync(password, salt, hash.length, { N, r, p, maxmem: maxmemFor(N, r, p) });
  } catch {
    return false;
  }
  return key.length === hash.length && timingSafeEqual(key, hash);
}

let dummyHash: Promise<string> | null = null;

/**
 * Verificación de relleno cuando el correo no existe, para que la respuesta tarde
 * lo mismo que con una cuenta real y no se pueda enumerar al personal por tiempo.
 */
export async function dummyVerify(password: string): Promise<void> {
  dummyHash ??= hashPassword(randomBytes(18).toString("base64url"));
  await verifyPassword(password, await dummyHash);
}
