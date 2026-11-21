"use client";

import { useCallback, useSyncExternalStore } from "react";
import { cn } from "@/lib/cn";
import { formatClock, formatDateTime, formatElapsed, timeAgo } from "@/lib/format";

/*
 * Reloj compartido: un único temporizador por intervalo para toda la página, expuesto con
 * useSyncExternalStore. El snapshot del servidor es null, así el HTML del servidor y la
 * hidratación coinciden y la hora real aparece justo después.
 */

interface Ticker {
  intervalMs: number;
  now: number;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setTimeout> | null;
}

const tickers = new Map<number, Ticker>();
let visibilityBound = false;

function ensureTicker(intervalMs: number): Ticker {
  let ticker = tickers.get(intervalMs);
  if (!ticker) {
    ticker = { intervalMs, now: Date.now(), listeners: new Set(), timer: null };
    tickers.set(intervalMs, ticker);
  }
  return ticker;
}

function emit(ticker: Ticker): void {
  ticker.now = Date.now();
  for (const listener of ticker.listeners) listener();
}

function schedule(ticker: Ticker): void {
  if (ticker.timer !== null) clearTimeout(ticker.timer);
  // Se alinea al siguiente múltiplo del intervalo (+4 ms) para que el segundo mostrado cambie a tiempo.
  const delay = ticker.intervalMs - (Date.now() % ticker.intervalMs) + 4;
  ticker.timer = setTimeout(() => {
    ticker.timer = null;
    emit(ticker);
    if (ticker.listeners.size > 0) schedule(ticker);
  }, delay);
}

// Los navegadores frenan los temporizadores en pestañas ocultas: al volver, se actualiza de inmediato.
function handleVisibility(): void {
  if (document.visibilityState !== "visible") return;
  for (const ticker of tickers.values()) {
    if (ticker.listeners.size === 0) continue;
    emit(ticker);
    schedule(ticker);
  }
}

function bindVisibility(): void {
  if (visibilityBound || typeof document === "undefined") return;
  document.addEventListener("visibilitychange", handleVisibility);
  visibilityBound = true;
}

function unbindVisibility(): void {
  if (!visibilityBound) return;
  document.removeEventListener("visibilitychange", handleVisibility);
  visibilityBound = false;
}

function subscribeTicker(intervalMs: number, listener: () => void): () => void {
  const ticker = ensureTicker(intervalMs);
  ticker.listeners.add(listener);
  if (ticker.listeners.size === 1) {
    // El snapshot pudo quedar viejo si el ticker se creó en un render descartado; React lo vuelve a leer tras suscribirse.
    ticker.now = Date.now();
    schedule(ticker);
    bindVisibility();
  }
  return () => {
    ticker.listeners.delete(listener);
    if (ticker.listeners.size > 0) return;
    if (ticker.timer !== null) clearTimeout(ticker.timer);
    ticker.timer = null;
    if (tickers.get(intervalMs) === ticker) tickers.delete(intervalMs);
    if (tickers.size === 0) unbindVisibility();
  };
}

function normalizeInterval(intervalMs: number): number {
  return Number.isFinite(intervalMs) && intervalMs > 0 ? Math.max(16, Math.round(intervalMs)) : 1000;
}

const noopUnsubscribe = () => {};
const noopSubscribe = () => noopUnsubscribe;
const getNullSnapshot = (): null => null;
const getTrue = () => true;
const getFalse = () => false;

/** null = sin suscripción (valor congelado); devuelve siempre null en ese caso. */
function useTicker(intervalMs: number | null): number | null {
  const ms = intervalMs === null ? null : normalizeInterval(intervalMs);
  const subscribe = useCallback(
    (listener: () => void) => (ms === null ? noopUnsubscribe : subscribeTicker(ms, listener)),
    [ms],
  );
  const getSnapshot = useCallback((): number | null => (ms === null ? null : ensureTicker(ms).now), [ms]);
  return useSyncExternalStore(subscribe, getSnapshot, getNullSnapshot);
}

/** true solo en el cliente después de hidratar; false en el servidor y durante la hidratación. */
function useHydrated(): boolean {
  return useSyncExternalStore(noopSubscribe, getTrue, getFalse);
}

function parseTime(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function isoDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `PT${h}H${m}M${s}S`;
}

const PLACEHOLDER_LONG = "--:--:--";
const PLACEHOLDER_SHORT = "--:--";

/** Hora actual (ms) actualizada cada `intervalMs`; null en el servidor y al hidratar. Un temporizador compartido por intervalo. */
export function useNow(intervalMs = 1000): number | null {
  return useTicker(intervalMs);
}

/** Props de `LiveClock`. */
export interface LiveClockProps {
  /** Muestra segundos (por defecto sí). */
  seconds?: boolean;
  className?: string;
}

/** Reloj en vivo HH:MM(:SS), 24 h es-CL; muestra "--:--:--" hasta montar para no desajustar la hidratación. */
export function LiveClock({ seconds = true, className }: LiveClockProps) {
  const now = useNow(1000);
  const text = now === null ? (seconds ? PLACEHOLDER_LONG : PLACEHOLDER_SHORT) : formatClock(now, { seconds });
  return (
    <time
      dateTime={now === null ? undefined : new Date(now).toISOString()}
      className={cn("font-mono tabular whitespace-nowrap", className)}
    >
      {text}
    </time>
  );
}

/** Props de `Elapsed`. */
export interface ElapsedProps {
  /** Inicio (ISO). */
  since: string;
  /** Fin (ISO); si viene, el cronómetro queda detenido (p. ej. incidente cerrado). */
  until?: string | null;
  className?: string;
  title?: string;
}

/** Cronómetro "HH:MM:SS" desde `since` (las horas pueden pasar de 99); detenido si hay `until`. */
export function Elapsed({ since, until, className, title }: ElapsedProps) {
  const frozen = until !== undefined && until !== null && until !== "";
  const now = useTicker(frozen ? null : 1000);
  const hydrated = useHydrated();
  const sinceMs = parseTime(since);
  const untilMs = frozen ? parseTime(until) : null;

  // Detenido: la diferencia no depende de la zona horaria, se puede mostrar ya en el servidor.
  let text = PLACEHOLDER_LONG;
  let durationMs: number | null = null;
  if (sinceMs !== null) {
    if (frozen && untilMs !== null) {
      text = formatElapsed(since, until);
      durationMs = untilMs - sinceMs;
    } else if (!frozen && now !== null) {
      text = formatElapsed(since, now);
      durationMs = now - sinceMs;
    }
  }

  let autoTitle: string | undefined;
  if (hydrated && sinceMs !== null) {
    autoTitle =
      frozen && untilMs !== null
        ? `Desde ${formatDateTime(since)} hasta ${formatDateTime(until)}`
        : `Desde ${formatDateTime(since)}`;
  }

  return (
    <time
      dateTime={durationMs === null ? undefined : isoDuration(durationMs)}
      title={title ?? autoTitle}
      className={cn("font-mono tabular whitespace-nowrap", className)}
    >
      {text}
    </time>
  );
}

/** Props de `TimeAgo`. */
export interface TimeAgoProps {
  iso: string;
  className?: string;
}

const TIME_AGO_MS = 15_000;

/** Tiempo relativo ("hace 2 min") que se actualiza cada 15 s; antes de montar muestra la hora absoluta. */
export function TimeAgo({ iso, className }: TimeAgoProps) {
  const now = useNow(TIME_AGO_MS);
  const ms = parseTime(iso);

  if (ms === null) {
    return <span className={cn("text-faint", className)}>—</span>;
  }

  // El reloj compartido puede ir hasta 15 s atrasado: algo recién creado no debe leerse como futuro.
  const effectiveNow = now !== null && ms > now && ms - now < TIME_AGO_MS ? ms : now;
  const text = effectiveNow === null ? formatClock(iso) : timeAgo(iso, effectiveNow);

  return (
    <time
      dateTime={iso}
      title={now === null ? undefined : formatDateTime(iso)}
      // La hora absoluta depende de la zona del servidor; se reemplaza por la relativa tras hidratar.
      suppressHydrationWarning
      className={cn("whitespace-nowrap", className)}
    >
      {text}
    </time>
  );
}
