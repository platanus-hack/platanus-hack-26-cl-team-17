/**
 * Cliente del servicio de reconstrucción 3D en vivo (vigia-live3d, gpu/splat/LIVE3D.md). Solo servidor.
 *
 * Nunca lanza a quien llama: sin servicio configurado, caído o lento, los cuadros simplemente
 * no se reenvían y las consultas devuelven null. La app funciona igual sin él.
 *
 * Reenvío: por misión, a lo más una petición en curso y un cuadro cada MIN_GAP_MS; los demás se
 * saltan (el servicio igual se queda con ~3 cuadros clave por segundo).
 */
import type { IdTokenClient } from "google-auth-library";
import { config } from "@/lib/config";
import { recordServerError } from "@/lib/server/diagnostics";
import { LIVE3D_SESSION_RE, parseLive3dStatus, type Live3DStatus } from "./live3d-types";

const MIN_GAP_MS = 250;
const FRAME_TIMEOUT_MS = 3_000;
const QUERY_TIMEOUT_MS = 4_000;
/** Un aviso en consola (y en diagnóstico) cada tanto por misión, no uno por cuadro. */
const WARN_EVERY_MS = 30_000;
/** Misiones sin cuadros por más que esto se olvidan. */
const IDLE_DROP_MS = 10 * 60_000;

interface ForwardState {
  inFlight: boolean;
  lastSentAt: number;
}

type GlobalWithLive3d = typeof globalThis & {
  __vigiaLive3dForward?: Map<string, ForwardState>;
  /** Último aviso por misión y tipo ("frames", "status", …). */
  __vigiaLive3dWarned?: Map<string, number>;
  __vigiaLive3dIdClient?: Promise<IdTokenClient>;
};

function g() {
  return globalThis as GlobalWithLive3d;
}

function forwardStates(): Map<string, ForwardState> {
  return (g().__vigiaLive3dForward ??= new Map());
}

/**
 * Con VIGIA_LIVE3D_AUTH=gcp, token de identidad de la cuenta del servicio para el Cloud Run
 * privado (el cliente lo guarda y lo renueva antes de que venza). Si falla, lanza.
 */
async function authHeaders(): Promise<Record<string, string>> {
  if (config.live3dAuth !== "gcp") return {};
  const gl = g();
  gl.__vigiaLive3dIdClient ??= import("google-auth-library").then(({ GoogleAuth }) =>
    new GoogleAuth().getIdTokenClient(config.live3dUrl),
  );
  try {
    const value = (await (await gl.__vigiaLive3dIdClient).getRequestHeaders()).get("authorization");
    return value ? { authorization: value } : {};
  } catch (err) {
    gl.__vigiaLive3dIdClient = undefined;
    throw err;
  }
}

export function isLive3dConfigured(): boolean {
  return Boolean(config.live3dUrl);
}

function sessionUrl(missionId: string, rest: string): string | null {
  if (!isLive3dConfigured() || !LIVE3D_SESSION_RE.test(missionId)) return null;
  return `${config.live3dUrl}/sessions/${encodeURIComponent(missionId)}/${rest}`;
}

function warnSparingly(missionId: string, kind: string, message: string, error?: unknown): void {
  const warned = (g().__vigiaLive3dWarned ??= new Map());
  const key = `${missionId}:${kind}`;
  const now = Date.now();
  if (now - (warned.get(key) ?? 0) < WARN_EVERY_MS) return;
  if (warned.size > 500) warned.clear();
  warned.set(key, now);
  console.warn(`[vigia-live3d] ${message}`, { mission: missionId, error: error instanceof Error ? error.message : error });
  recordServerError("dron", error ?? message, { context: `3D en vivo: ${message}`, now });
}

/**
 * Reenvía un cuadro JPEG del video en vivo al servicio, en segundo plano. Nunca lanza.
 * Devuelve una promesa que se resuelve sola (al instante si el cuadro se salta), para
 * poder pasarla a `deps.defer`.
 */
export function forwardLive3dFrame(missionId: string, bytes: Uint8Array, atMs: number): Promise<void> {
  const url = sessionUrl(missionId, `frames?t=${Math.round(atMs)}`);
  if (!url) return Promise.resolve();
  const now = Date.now();
  const states = forwardStates();
  for (const [id, s] of states) if (!s.inFlight && now - s.lastSentAt > IDLE_DROP_MS) states.delete(id);
  let s = states.get(missionId);
  if (!s) {
    s = { inFlight: false, lastSentAt: 0 };
    states.set(missionId, s);
  }
  if (s.inFlight || now - s.lastSentAt < MIN_GAP_MS) return Promise.resolve();
  s.inFlight = true;
  s.lastSentAt = now;
  const state = s;
  return (async () => {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { ...(await authHeaders()), "content-type": "image/jpeg" },
        body: bytes as BodyInit,
        signal: AbortSignal.timeout(FRAME_TIMEOUT_MS),
        cache: "no-store",
      });
      // El cuerpo es chico; se consume para liberar la conexión.
      await res.arrayBuffer().catch(() => undefined);
      if (!res.ok) warnSparingly(missionId, "frames", `el servicio respondió ${res.status} al reenviar un cuadro`);
    } catch (error) {
      warnSparingly(missionId, "frames", "falló el reenvío de un cuadro", error);
    } finally {
      state.inFlight = false;
    }
  })();
}

/** Estado de la sesión. null si no hay servicio, la sesión no existe (404) o falló la consulta. */
export async function fetchLive3dStatus(missionId: string): Promise<Live3DStatus | null> {
  const url = sessionUrl(missionId, "status");
  if (!url) return null;
  try {
    const res = await fetch(url, {
      headers: await authHeaders(),
      signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
      cache: "no-store",
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      warnSparingly(missionId, "status", `el servicio respondió ${res.status} al estado`);
      return null;
    }
    return parseLive3dStatus(await res.json());
  } catch (error) {
    warnSparingly(missionId, "status", "falló la consulta de estado", error);
    return null;
  }
}

/**
 * Trozos de puntos [from, from+max) tal cual los entrega el servicio (binario "VL3D").
 * status 0 = no se pudo consultar (sin servicio, id inválido o red caída).
 */
export async function fetchLive3dPoints(
  missionId: string,
  from: number,
  max: number,
): Promise<{ status: number; body: ArrayBuffer | null }> {
  const url = sessionUrl(missionId, `points?from=${from}&max=${max}`);
  if (!url) return { status: 0, body: null };
  try {
    const res = await fetch(url, {
      headers: await authHeaders(),
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
    if (!res.ok) {
      await res.arrayBuffer().catch(() => undefined);
      return { status: res.status, body: null };
    }
    return { status: res.status, body: await res.arrayBuffer() };
  } catch (error) {
    warnSparingly(missionId, "points", "falló la descarga de puntos", error);
    return { status: 0, body: null };
  }
}

/**
 * Última instantánea de los Gaussian splats en vivo (binario "VGS1") salvo que `after` ya sea ella.
 * Pedirla es lo que mantiene encendido el entrenamiento en el servicio. status 204 = sin nada más
 * nuevo; 0 = no se pudo consultar.
 */
export async function fetchLive3dSplat(
  missionId: string,
  after: number,
): Promise<{ status: number; body: ArrayBuffer | null; version: number | null }> {
  const url = sessionUrl(missionId, `splat?after=${Math.max(0, Math.floor(after))}`);
  if (!url) return { status: 0, body: null, version: null };
  try {
    const res = await fetch(url, {
      headers: await authHeaders(),
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
    });
    if (res.status !== 200) {
      await res.arrayBuffer().catch(() => undefined);
      return { status: res.status, body: null, version: null };
    }
    const version = Number(res.headers.get("x-splat-version"));
    return { status: 200, body: await res.arrayBuffer(), version: Number.isFinite(version) ? version : null };
  } catch (error) {
    warnSparingly(missionId, "splat", "falló la descarga de splats", error);
    return { status: 0, body: null, version: null };
  }
}

/** Borra la sesión en el servicio. true si respondió bien. */
export async function resetLive3dSession(missionId: string): Promise<boolean> {
  const url = sessionUrl(missionId, "reset");
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: await authHeaders(),
      signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
      cache: "no-store",
    });
    await res.arrayBuffer().catch(() => undefined);
    return res.ok;
  } catch (error) {
    warnSparingly(missionId, "reset", "falló el reinicio de la sesión", error);
    return false;
  }
}
