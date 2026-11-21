/**
 * Lógica pura de los hooks de sondeo (`use-live.ts`): claves SWR, fusión de respuestas
 * `{ unchanged: true }`, frescura (stale) y política de reintentos. Sin React ni globals del
 * navegador, así se prueba en node.
 */
import type { UnchangedResponse } from "@/lib/contract";
import { ApiClientError } from "@/lib/client/api";

/* ───────────── Intervalos por defecto ───────────── */

export const LIST_INTERVAL_MS = 5_000;
export const SNAPSHOT_INTERVAL_MS = 2_500;
export const BRIEFING_INTERVAL_MS = 4_000;
/** Sin respuesta exitosa por más de esto → `stale = true`. */
export const DEFAULT_STALE_AFTER_MS = 15_000;
/** Tope del reintento ante fallas transitorias (red, 5xx): en un carro en movimiento hay que volver pronto. */
export const TRANSIENT_RETRY_CAP_MS = 15_000;

/* ───────────── Claves SWR ───────────── */
// Exportadas para que otras pantallas puedan invalidar con `mutate(snapshotKey(id))` tras un PATCH.

export const LIST_KEY = "/api/incidents";
export const STATUS_KEY = "/api/status";
export const ME_KEY = "/api/auth/me";

const clean = (v: string | null | undefined): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t : null;
};

/** Clave del snapshot de un incidente; null (sin sondeo) si no hay id. */
export function snapshotKey(id: string | null | undefined): string | null {
  const i = clean(id);
  return i ? `/api/incidents/${encodeURIComponent(i)}` : null;
}

/** Clave del briefing; incluye la clave de acceso para no mezclar respuestas de enlaces distintos. */
export function briefingKey(id: string | null | undefined, key: string | null | undefined): string | null {
  const i = clean(id);
  const k = clean(key);
  return i && k ? `/api/briefing/${encodeURIComponent(i)}?k=${encodeURIComponent(k)}` : null;
}

/**
 * Enlace de briefing sin clave (`?k=` ausente o vacío): no se consulta al servidor, pero la
 * página debe poder mostrar "Enlace inválido o vencido" igual que con un 401.
 */
export function isMissingBriefingKey(id: string | null | undefined, key: string | null | undefined): boolean {
  return clean(id) !== null && clean(key) === null;
}

/** Error fijo (misma identidad en cada render) para un enlace de briefing sin clave. */
export const MISSING_BRIEFING_KEY_ERROR = new ApiClientError(
  401,
  "unauthorized",
  "Enlace inválido o vencido. Pide uno nuevo al puesto de mando.",
);

/* ───────────── Fusión de sondeos con rev ───────────── */

/** Cualquier respuesta completa que lleve `incident.rev` (IncidentSnapshot, BriefingSnapshot). */
export interface Revisioned {
  unchanged?: false;
  incident: { rev: number };
}

export function isUnchangedResponse(v: unknown): v is UnchangedResponse {
  return typeof v === "object" && v !== null && (v as { unchanged?: unknown }).unchanged === true;
}

export function hasRev(v: unknown): v is Revisioned {
  if (typeof v !== "object" || v === null || isUnchangedResponse(v)) return false;
  const inc = (v as { incident?: unknown }).incident;
  return typeof inc === "object" && inc !== null && typeof (inc as { rev?: unknown }).rev === "number";
}

/** rev a enviar en el próximo sondeo (null → pedir completo). */
export function revOf(prev: Revisioned | null | undefined): number | null {
  return prev && Number.isFinite(prev.incident.rev) ? prev.incident.rev : null;
}

/**
 * Aplica una respuesta de sondeo sobre el valor anterior.
 * - Respuesta completa → la nueva.
 * - `{ unchanged: true }` con el mismo rev que `prev` → `prev` (misma identidad: SWR no re-renderiza).
 * - `{ unchanged: true }` sin `prev` o con otro rev → null: hay que pedir el snapshot completo.
 */
export function applyPoll<T extends Revisioned>(
  prev: T | null | undefined,
  res: T | UnchangedResponse,
): T | null {
  if (!isUnchangedResponse(res)) return res;
  if (prev && prev.incident.rev === res.rev) return prev;
  return null;
}

/**
 * Un ciclo de sondeo: pide con el rev conocido y, si el servidor dice "sin cambios" pero no calza
 * con lo que tenemos, repite sin rev. `onOk` se llama por cada respuesta exitosa (incluidas las
 * "sin cambios"), para medir la frescura.
 */
export async function pollWithRev<T extends Revisioned>(
  prev: T | null | undefined,
  fetchRev: (rev: number | null) => Promise<T | UnchangedResponse>,
  onOk: () => void,
): Promise<T> {
  const rev = revOf(prev);
  const res = await fetchRev(rev);
  onOk();
  const merged = applyPoll(prev, res);
  if (merged) return merged;
  if (rev === null) throw unexpectedResponse();
  const full = await fetchRev(null);
  onOk();
  const fresh = applyPoll(null, full);
  if (!fresh) throw unexpectedResponse();
  return fresh;
}

const unexpectedResponse = () =>
  new ApiClientError(0, "internal", "Respuesta inesperada del servidor. Intenta de nuevo en un momento.");

/* ───────────── Errores y reintentos ───────────── */

/** Normaliza cualquier error a `ApiClientError` (los de `api` ya lo son). */
export function toApiClientError(err: unknown): ApiClientError {
  if (err instanceof ApiClientError) return err;
  return new ApiClientError(0, "internal", "Ocurrió un error inesperado. Intenta de nuevo en un momento.");
}

/** Errores que no se arreglan reintentando (sesión, permisos, enlace inválido, solicitud mala). */
export function isFatalError(err: ApiClientError): boolean {
  return (
    err.code === "unauthorized" ||
    err.code === "forbidden" ||
    err.code === "invalid" ||
    err.code === "too_large"
  );
}

/**
 * Espera antes del reintento n.º `retryCount` (1, 2, …) tras un error; null = no reintentar
 * (el hook queda detenido hasta `refresh()` o hasta que la pestaña vuelva a tener foco).
 * - 401/403/400: no se reintenta.
 * - 404: retroceso lento (30 s, 60 s, … hasta 5 min) para no martillar al servidor.
 * - 429: desde 10 s, hasta 60 s.
 * - Red / 5xx / otros: base·2^(n−1) con ±20 % de variación, tope 15 s.
 */
export function retryDelayMs(
  err: ApiClientError,
  retryCount: number,
  baseMs: number,
  random: () => number = Math.random,
): number | null {
  if (isFatalError(err)) return null;
  const n = Math.max(1, Math.floor(retryCount));
  const exp = 2 ** Math.min(n - 1, 10);
  if (err.code === "not_found") return Math.min(30_000 * exp, 300_000);
  if (err.code === "rate_limited") return Math.min(Math.max(10_000, baseMs) * exp, 60_000);
  const jitter = 0.8 + 0.4 * Math.min(1, Math.max(0, random()));
  return Math.round(Math.min(baseMs * exp, TRANSIENT_RETRY_CAP_MS) * jitter);
}

/* ───────────── Frescura ───────────── */

/** true si pasaron más de `thresholdMs` desde `refMs` (última respuesta exitosa o, sin ella, inicio del sondeo). */
export function isStale(refMs: number | null, nowMs: number, thresholdMs: number): boolean {
  if (refMs === null) return false;
  return nowMs - refMs > thresholdMs;
}

/** ms hasta que `isStale` pase a true; null si ya lo está o no hay referencia. */
export function msUntilStale(refMs: number | null, nowMs: number, thresholdMs: number): number | null {
  if (refMs === null || isStale(refMs, nowMs, thresholdMs)) return null;
  return refMs + thresholdMs - nowMs + 1;
}

export interface LivenessEntry {
  /** Date.now() de la última respuesta exitosa (incluidas las "sin cambios"). */
  lastOkAt: number | null;
  /** Date.now() de cuando se empezó a sondear esta clave (referencia si aún no hay respuesta). */
  since: number | null;
}

/**
 * Registro por clave de la última respuesta exitosa, compartido por todas las instancias del hook
 * con la misma clave (SWR deduplica: solo una de ellas ejecuta el fetcher).
 */
export interface LivenessStore {
  get(key: string): LivenessEntry;
  /** Marca el inicio del sondeo si aún no había referencia. */
  activate(key: string, atMs: number): void;
  markOk(key: string, atMs: number): void;
  subscribe(key: string, listener: () => void): () => void;
}

const EMPTY_ENTRY: LivenessEntry = Object.freeze({ lastOkAt: null, since: null });

export function createLivenessStore(): LivenessStore {
  const entries = new Map<string, LivenessEntry>();
  const listeners = new Map<string, Set<() => void>>();
  const notify = (key: string) => {
    const set = listeners.get(key);
    if (!set) return;
    for (const fn of [...set]) fn();
  };
  return {
    get: (key) => entries.get(key) ?? EMPTY_ENTRY,
    activate(key, atMs) {
      const cur = entries.get(key);
      if (cur?.lastOkAt != null) return;
      // Sin respuesta exitosa nunca: si nadie la está mirando, el sondeo empieza de nuevo ahora
      // (si no, volver a una clave que falló hace una hora la marcaría desactualizada al instante).
      if (cur?.since != null && (listeners.get(key)?.size ?? 0) > 0) return;
      entries.set(key, { lastOkAt: null, since: atMs });
    },
    markOk(key, atMs) {
      const cur = entries.get(key) ?? EMPTY_ENTRY;
      if (cur.lastOkAt !== null && cur.lastOkAt >= atMs) return;
      entries.set(key, { lastOkAt: atMs, since: cur.since ?? atMs });
      notify(key);
    },
    subscribe(key, listener) {
      let set = listeners.get(key);
      if (!set) {
        set = new Set();
        listeners.set(key, set);
      }
      set.add(listener);
      return () => {
        const s = listeners.get(key);
        if (!s) return;
        s.delete(listener);
        if (s.size === 0) listeners.delete(key);
      };
    },
  };
}

/** Referencia para medir la frescura: última respuesta exitosa o, si no hubo, el inicio del sondeo. */
export function staleReference(entry: LivenessEntry): number | null {
  return entry.lastOkAt ?? entry.since;
}

/* ───────────── Tiempo máximo por solicitud ───────────── */

/** Tiempo máximo de una solicitud de sondeo: sin esto, una solicitud colgada detiene el sondeo de SWR. */
export function requestTimeoutMs(intervalMs: number): number {
  return Math.max(8_000, Math.min(20_000, intervalMs * 3));
}

/**
 * Ejecuta `run` con una señal que se aborta a los `ms`. Si vence, rechaza con
 * `ApiClientError` "network" (mensaje para la persona), no con "aborted".
 */
export function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const ctrl = new AbortController();
  let timedOut = false;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
      reject(
        new ApiClientError(
          0,
          "network",
          "El servidor no responde. Revisa tu señal; seguimos intentando.",
        ),
      );
    }, ms);
    let pending: Promise<T>;
    try {
      pending = run(ctrl.signal);
    } catch (err) {
      // `run` que lanza de forma síncrona: no dejar el temporizador vivo.
      clearTimeout(timer);
      reject(err);
      return;
    }
    pending.then(
      (v) => {
        clearTimeout(timer);
        if (!timedOut) resolve(v);
      },
      (err: unknown) => {
        clearTimeout(timer);
        if (!timedOut) reject(err);
      },
    );
  });
}
