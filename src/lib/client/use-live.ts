"use client";
/**
 * Hooks de datos en vivo (SWR) para el puesto de mando, el briefing en ruta y el estado de la
 * instancia. Importable en SSR: nada toca `window`/`document` al cargar el módulo; SWR sondea solo
 * en el navegador.
 *
 * Comportamiento común de los hooks con sondeo:
 * - Pausa con la pestaña oculta (`refreshWhenHidden: false`) y revalida al volver a ser visible o
 *   recuperar el foco (`revalidateOnFocus`, escucha `visibilitychange` y `focus`).
 * - Cada clave SWR incluye el id (y la clave de acceso en el briefing): al cambiar de incidente no
 *   se muestra nunca el snapshot de otro (`keepPreviousData: false`).
 * - Con `?rev=` la respuesta `{ unchanged: true }` devuelve el MISMO objeto anterior: no hay
 *   re-render ni cambia la identidad del snapshot (los hijos memorizados no se recalculan).
 * - `lastUpdatedAt` (Date.now() de la última respuesta exitosa, incluidas las "sin cambios") se lee
 *   al renderizar; como el hook no re-renderiza por respuestas sin cambios, una pantalla que muestre
 *   "Actualizado hace N s" debe llevar su propio reloj (p. ej. cada 1 s).
 * - `stale` sí re-renderiza al cambiar: un temporizador lo pasa a true justo al cumplirse el umbral
 *   aunque las solicitudes queden colgadas o fallen, y vuelve a false con la siguiente respuesta.
 * - Errores siempre como `ApiClientError`. 401/403/400 detienen el sondeo (hasta `refresh()` o
 *   volver a la pestaña); 404 reintenta con retroceso lento; red/5xx reintentan pronto (tope 15 s).
 * - Cada solicitud tiene tiempo máximo (`requestTimeoutMs`): una colgada se aborta como error de
 *   red y el sondeo sigue (si no, SWR esperaría para siempre esa promesa).
 */
import { useCallback, useEffect, useState } from "react";
import useSWR, { useSWRConfig, type Cache, type Revalidator, type RevalidatorOptions } from "swr";
import { api, ApiClientError } from "@/lib/client/api";
import type {
  BriefingSnapshot,
  IncidentListResponse,
  IncidentSnapshot,
  IncidentSummary,
  RuntimeMode,
  StaffPublic,
} from "@/lib/contract";
import {
  BRIEFING_INTERVAL_MS,
  DEFAULT_STALE_AFTER_MS,
  LIST_INTERVAL_MS,
  LIST_KEY,
  ME_KEY,
  MISSING_BRIEFING_KEY_ERROR,
  SNAPSHOT_INTERVAL_MS,
  STATUS_KEY,
  briefingKey,
  createLivenessStore,
  hasRev,
  isMissingBriefingKey,
  isStale,
  msUntilStale,
  pollWithRev,
  requestTimeoutMs,
  retryDelayMs,
  snapshotKey,
  staleReference,
  toApiClientError,
  withTimeout,
} from "@/lib/client/live-core";

export { LIST_KEY, ME_KEY, STATUS_KEY, briefingKey, snapshotKey } from "@/lib/client/live-core";

export interface LiveOptions {
  /** Intervalo de sondeo en ms (por defecto: lista 5 s, snapshot 2,5 s, briefing 4 s). */
  intervalMs?: number;
  /** ms sin respuesta exitosa para considerar los datos desactualizados (por defecto 15 s). */
  staleAfterMs?: number;
}

/** Recargar ya, saltándose el intervalo y la deduplicación. */
export type Refresh = () => Promise<void>;

interface LiveState<T> {
  data: T | null;
  error: ApiClientError | null;
  /** true solo mientras se carga por primera vez una clave sin datos. */
  isLoading: boolean;
  refresh: Refresh;
  lastUpdatedAt: number | null;
  stale: boolean;
}

/** Última respuesta exitosa por clave, compartida por todas las instancias del hook. */
const liveness = createLivenessStore();

interface RetryConfig {
  isVisible: () => boolean;
}

/** Política de reintentos sobre `retryDelayMs`; con la pestaña oculta espera a que vuelva el foco. */
function makeOnErrorRetry(baseMs: number, skipWhenHidden: boolean) {
  return (
    err: ApiClientError,
    _key: string,
    config: RetryConfig,
    revalidate: Revalidator,
    opts: Required<RevalidatorOptions>,
  ): void => {
    const delay = retryDelayMs(toApiClientError(err), opts.retryCount, baseMs);
    if (delay === null) return;
    setTimeout(() => {
      if (skipWhenHidden && !config.isVisible()) return;
      void revalidate(opts);
    }, delay);
  };
}

/**
 * SWR no sondea mientras hay un error, no reintenta si el error llega con la pestaña oculta, y su
 * revalidación al volver a la pestaña tiene un mínimo entre llamadas (5 s; 30 s en useMe). Sin esto,
 * un error con la pestaña oculta (o un reintento descartado por estarlo) podía dejar el hook detenido
 * hasta otro cambio de pestaña. Al volver a ser visible con un error pendiente, se reintenta una vez.
 */
function useRetryOnVisible(key: string | null, cache: Cache, mutate: () => Promise<unknown>): void {
  useEffect(() => {
    if (!key || typeof document === "undefined") return;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") return;
      if (cache.get(key)?.error === undefined) return;
      mutate().catch(() => {
        /* el error queda en el estado de SWR */
      });
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [key, cache, mutate]);
}

/**
 * Base de los hooks con sondeo. `load` recibe lo que hay en caché para la misma clave (para el rev),
 * debe llamar a `markOk` por cada respuesta exitosa y pasar `signal` a la API (tiempo máximo).
 */
function useLive<T>(
  swrKey: string | null,
  load: (cached: unknown, markOk: () => void, signal: AbortSignal) => Promise<T>,
  intervalMs: number,
  staleAfterMs: number,
): LiveState<T> {
  const { cache } = useSWRConfig();

  const { data, error, isLoading, mutate } = useSWR<T, ApiClientError>(
    swrKey,
    async (k: string) => {
      // Una revalidación rezagada de la clave anterior (p. ej. el rAF de montaje) llega con el
      // fetcher nuevo: no consultar el incidente actual bajo la clave de otro. Devolver lo que ya
      // hay en caché la deja igual (lanzar un error lo dejaría pegado en la clave anterior).
      if (k !== swrKey) return cache.get(k)?.data as T;
      try {
        const cached: unknown = cache.get(k)?.data;
        return await withTimeout(
          (signal) => load(cached, () => liveness.markOk(k, Date.now()), signal),
          requestTimeoutMs(intervalMs),
        );
      } catch (err) {
        throw toApiClientError(err);
      }
    },
    {
      refreshInterval: intervalMs,
      refreshWhenHidden: false,
      refreshWhenOffline: false,
      revalidateOnFocus: true,
      revalidateOnReconnect: true,
      keepPreviousData: false,
      dedupingInterval: Math.min(1_000, Math.floor(intervalMs / 2)),
      shouldRetryOnError: true,
      onErrorRetry: makeOnErrorRetry(intervalMs, true),
    },
  );

  const refresh = useCallback<Refresh>(async () => {
    await mutate();
  }, [mutate]);

  useRetryOnVisible(swrKey, cache, mutate);

  // Frescura: el estado se etiqueta con la clave para no arrastrar el valor de otro incidente.
  const [staleState, setStaleState] = useState<{ key: string | null; stale: boolean }>({
    key: null,
    stale: false,
  });

  useEffect(() => {
    if (!swrKey) return;
    liveness.activate(swrKey, Date.now());
    let timer: ReturnType<typeof setTimeout> | undefined;
    let current: boolean | null = null;
    let disposed = false;
    const check = () => {
      if (disposed) return;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      const now = Date.now();
      const ref = staleReference(liveness.get(swrKey));
      const next = isStale(ref, now, staleAfterMs);
      if (next !== current) {
        current = next;
        // Devolver el mismo objeto evita el re-render si ya mostraba ese valor.
        setStaleState((prev) =>
          prev.key === swrKey && prev.stale === next ? prev : { key: swrKey, stale: next },
        );
      }
      const wait = msUntilStale(ref, now, staleAfterMs);
      if (wait !== null) timer = setTimeout(check, wait);
    };
    const unsubscribe = liveness.subscribe(swrKey, check);
    timer = setTimeout(check, 0);
    return () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      unsubscribe();
    };
  }, [swrKey, staleAfterMs]);

  return {
    data: data ?? null,
    error: error ?? null,
    isLoading,
    refresh,
    lastUpdatedAt: swrKey ? liveness.get(swrKey).lastOkAt : null,
    stale: staleState.key === swrKey && swrKey !== null ? staleState.stale : false,
  };
}

/* ───────────── Lista de incidentes (puesto de mando) ───────────── */

export interface IncidentListState {
  /** null hasta la primera respuesta. */
  incidents: IncidentSummary[] | null;
  mode: RuntimeMode | null;
  error: ApiClientError | null;
  isLoading: boolean;
  refresh: Refresh;
  lastUpdatedAt: number | null;
  stale: boolean;
}

/** Sondea `GET /api/incidents` cada ~5 s. */
export function useIncidentList(options: LiveOptions = {}): IncidentListState {
  const live = useLive<IncidentListResponse>(
    LIST_KEY,
    async (_cached, markOk, signal) => {
      const res = await api.incidents.list({ signal });
      markOk();
      return res;
    },
    options.intervalMs ?? LIST_INTERVAL_MS,
    options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS,
  );
  return {
    incidents: live.data?.incidents ?? null,
    mode: live.data?.mode ?? null,
    error: live.error,
    isLoading: live.isLoading,
    refresh: live.refresh,
    lastUpdatedAt: live.lastUpdatedAt,
    stale: live.stale,
  };
}

/* ───────────── Snapshot de un incidente ───────────── */

export interface IncidentSnapshotState {
  /** null sin id o hasta la primera respuesta; nunca el de otro incidente. */
  snapshot: IncidentSnapshot | null;
  error: ApiClientError | null;
  isLoading: boolean;
  refresh: Refresh;
  lastUpdatedAt: number | null;
  stale: boolean;
}

/** Sondea `GET /api/incidents/[id]?rev=` cada ~2,5 s; id null no sondea. */
export function useIncidentSnapshot(
  id: string | null,
  options: LiveOptions = {},
): IncidentSnapshotState {
  const key = snapshotKey(id);
  const live = useLive<IncidentSnapshot>(
    key,
    (cached, markOk, signal) => {
      const incidentId = (id ?? "").trim();
      const prev = hasRev(cached) ? (cached as IncidentSnapshot) : null;
      return pollWithRev(prev, (rev) => api.incidents.get(incidentId, rev, { signal }), markOk);
    },
    options.intervalMs ?? SNAPSHOT_INTERVAL_MS,
    options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS,
  );
  return {
    snapshot: live.data,
    error: live.error,
    isLoading: live.isLoading,
    refresh: live.refresh,
    lastUpdatedAt: live.lastUpdatedAt,
    stale: live.stale,
  };
}

/* ───────────── Briefing en ruta ───────────── */

export interface BriefingState {
  /** null sin id/clave o hasta la primera respuesta. */
  briefing: BriefingSnapshot | null;
  /**
   * 401/403 → enlace inválido o vencido; 404 → emergencia no encontrada (ver `error.code`).
   * Con id pero sin clave no se consulta y llega un 401 "unauthorized" sintético.
   */
  error: ApiClientError | null;
  isLoading: boolean;
  refresh: Refresh;
  lastUpdatedAt: number | null;
  stale: boolean;
}

/**
 * Sondea `GET /api/briefing/[id]?k=&rev=` cada ~4 s; sin id o sin clave no sondea.
 * En /en-ruta usa `{ staleAfterMs: 20_000 }`.
 */
export function useBriefing(
  id: string | null,
  key: string | null,
  options: LiveOptions = {},
): BriefingState {
  const swrKey = briefingKey(id, key);
  const live = useLive<BriefingSnapshot>(
    swrKey,
    (cached, markOk, signal) => {
      const incidentId = (id ?? "").trim();
      const shareKey = (key ?? "").trim();
      const prev = hasRev(cached) ? (cached as BriefingSnapshot) : null;
      return pollWithRev(
        prev,
        (rev) => api.briefing.get(incidentId, shareKey, rev, { signal }),
        markOk,
      );
    },
    options.intervalMs ?? BRIEFING_INTERVAL_MS,
    options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS,
  );
  return {
    briefing: live.data,
    error: live.error ?? (isMissingBriefingKey(id, key) ? MISSING_BRIEFING_KEY_ERROR : null),
    isLoading: live.isLoading,
    refresh: live.refresh,
    lastUpdatedAt: live.lastUpdatedAt,
    stale: live.stale,
  };
}

/* ───────────── Estado de la instancia y sesión ───────────── */

export interface RuntimeModeState {
  mode: RuntimeMode | null;
  error: ApiClientError | null;
  isLoading: boolean;
}

/** `GET /api/status` una vez por sesión de navegador (no cambia mientras corre la instancia). */
export function useRuntimeMode(): RuntimeModeState {
  const { data, error, isLoading } = useSWR<{ mode: RuntimeMode }, ApiClientError>(
    STATUS_KEY,
    async () => {
      try {
        return await withTimeout((signal) => api.status({ signal }), 15_000);
      } catch (err) {
        throw toApiClientError(err);
      }
    },
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: true,
      revalidateIfStale: false,
      dedupingInterval: 60_000,
      shouldRetryOnError: true,
      onErrorRetry: makeOnErrorRetry(5_000, false),
    },
  );
  return { mode: data?.mode ?? null, error: error ?? null, isLoading };
}

export interface MeState {
  /** null sin sesión (o en modo abierto si el servidor no entrega sesión de demostración). */
  staff: StaffPublic | null;
  mode: RuntimeMode | null;
  error: ApiClientError | null;
  isLoading: boolean;
  /** Llamar tras iniciar o cerrar sesión (o usar `mutate(ME_KEY)`). */
  refresh: Refresh;
}

/** `GET /api/auth/me`; revalida al volver a la pestaña (la sesión puede haber vencido). */
export function useMe(): MeState {
  const { cache } = useSWRConfig();
  const { data, error, isLoading, mutate } = useSWR<
    { staff: StaffPublic | null; mode: RuntimeMode },
    ApiClientError
  >(
    ME_KEY,
    async () => {
      try {
        return await withTimeout((signal) => api.auth.me({ signal }), 15_000);
      } catch (err) {
        throw toApiClientError(err);
      }
    },
    {
      revalidateOnFocus: true,
      focusThrottleInterval: 30_000,
      dedupingInterval: 5_000,
      shouldRetryOnError: true,
      onErrorRetry: makeOnErrorRetry(5_000, true),
    },
  );
  const refresh = useCallback<Refresh>(async () => {
    await mutate();
  }, [mutate]);
  useRetryOnVisible(ME_KEY, cache, mutate);
  return {
    staff: data?.staff ?? null,
    mode: data?.mode ?? null,
    error: error ?? null,
    isLoading,
    refresh,
  };
}
