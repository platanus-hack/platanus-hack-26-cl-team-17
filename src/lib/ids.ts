/**
 * Identificadores, códigos y secretos. Solo servidor (usa node:crypto).
 */
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export function newId(): string {
  return randomUUID();
}

/** Alfabeto sin caracteres ambiguos (0/O, 1/I/L) para dictar códigos por teléfono o radio. */
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/** Código corto de incidente para vecinos y QR, p. ej. "VG-7K3Q". */
export function newIncidentCode(): string {
  const bytes = randomBytes(4);
  let out = "";
  for (let i = 0; i < 4; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return `VG-${out}`;
}

/** Normaliza lo que escribe un vecino: "vg 7k3q" → "VG-7K3Q". */
export function normalizeIncidentCode(input: string): string {
  const clean = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const body = clean.startsWith("VG") ? clean.slice(2) : clean;
  return `VG-${body}`;
}

/** Secreto aleatorio URL-safe (tokens de subida, de ingesta de dron, claves de enlace). */
export function newToken(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hmacHex(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("hex");
}

/** Comparación en tiempo constante de dos strings hexadecimales/ASCII. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
