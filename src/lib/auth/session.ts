/**
 * Cookie de sesión del personal: `__session = base64url(payload).base64url(HMAC-SHA256)`.
 *
 * Se llama `__session` porque Firebase Hosting (vigilia.live) borra todas las demás cookies
 * antes de reenviar la petición a Cloud Run.
 *
 * Usa solo Web Crypto (crypto.subtle), TextEncoder y btoa/atob, para que sirva igual
 * en los route handlers (Node) y en src/proxy.ts, sin depender de node:crypto ni Buffer.
 * La firma prueba que la cookie la emitimos nosotros y no ha vencido; que la cuenta
 * siga activa lo comprueba getStaff() contra la base de datos.
 */
import { config } from "@/lib/config";

export const SESSION_COOKIE = "__session";
export const SESSION_VERSION = 1;
/** 12 horas: un turno largo. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export interface SessionPayload {
  /** id del registro en la tabla staff. */
  sid: string;
  /** Vencimiento en milisegundos desde epoch. */
  exp: number;
  v: number;
}

export class SessionConfigError extends Error {
  constructor() {
    super(
      "Falta VIGIA_SESSION_SECRET: con DATABASE_URL definido es obligatorio un secreto para firmar " +
        "las sesiones del personal (genera uno con `openssl rand -base64 32`).",
    );
    this.name = "SessionConfigError";
  }
}

/** Secreto de firma; lanza SessionConfigError si no está definido (nunca se inventa uno). */
export function getSessionSecret(): string {
  const secret = config.sessionSecret;
  if (!secret) throw new SessionConfigError();
  return secret;
}

/* ───────────── base64url sin Buffer ───────────── */

function bytesToB64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null;
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    return null;
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ───────────── HMAC ───────────── */

const encoder = new TextEncoder();
const keyCache = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let key = keyCache.get(secret);
  if (!key) {
    key = crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
      "verify",
    ]);
    // Normalmente hay un solo secreto; el tope evita crecer sin límite en pruebas.
    if (keyCache.size > 8) keyCache.clear();
    keyCache.set(secret, key);
  }
  return key;
}

export async function signSessionPayload(payload: SessionPayload, secret: string): Promise<string> {
  if (!secret) throw new SessionConfigError();
  const body = bytesToB64url(encoder.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(body));
  return `${body}.${bytesToB64url(new Uint8Array(sig))}`;
}

/** Crea el valor de la cookie para `staffId`, vigente por SESSION_TTL_MS desde `now`. */
export function createSessionToken(staffId: string, secret: string, now: number = Date.now()): Promise<string> {
  return signSessionPayload({ sid: staffId, exp: now + SESSION_TTL_MS, v: SESSION_VERSION }, secret);
}

function isPayload(v: unknown): v is SessionPayload {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.sid === "string" &&
    o.sid.length > 0 &&
    o.sid.length <= 128 &&
    typeof o.exp === "number" &&
    Number.isFinite(o.exp) &&
    typeof o.v === "number"
  );
}

/**
 * Verifica firma (en tiempo constante, vía crypto.subtle.verify), versión y vencimiento.
 * Devuelve el payload o null; nunca lanza por un token malformado.
 */
export async function verifySessionToken(
  token: string | null | undefined,
  secret: string,
  now: number = Date.now(),
): Promise<SessionPayload | null> {
  if (!token || !secret || token.length > 2048) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sigText] = parts;
  const sig = b64urlToBytes(sigText);
  if (!sig || sig.length !== 32 || body.length === 0) return null;
  const valid = await crypto.subtle.verify("HMAC", await hmacKey(secret), sig, encoder.encode(body));
  if (!valid) return null;
  const raw = b64urlToBytes(body);
  if (!raw) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return null;
  }
  if (!isPayload(payload)) return null;
  if (payload.v !== SESSION_VERSION) return null;
  if (payload.exp <= now) return null;
  return payload;
}

/* ───────────── Opciones de la cookie ───────────── */

/** true si la petición llegó por https (directo o detrás del balanceador de Cloud Run). */
export function isSecureRequest(req: Request): boolean {
  const proto = req.headers.get("x-forwarded-proto");
  if (proto) return proto.split(",")[0].trim().toLowerCase() === "https";
  try {
    return new URL(req.url).protocol === "https:";
  } catch {
    return false;
  }
}

export interface SessionCookieOptions {
  httpOnly: true;
  sameSite: "lax";
  path: "/";
  secure: boolean;
  maxAge: number;
}

export function sessionCookieOptions(req: Request): SessionCookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: isSecureRequest(req),
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  };
}

/** Opciones para borrar la cookie (mismos atributos, vencida). */
export function clearedSessionCookieOptions(req: Request): SessionCookieOptions {
  return { ...sessionCookieOptions(req), maxAge: 0 };
}
