"use client";
/**
 * Ubicación (Geolocation API) y rumbo de brújula (DeviceOrientation) del teléfono.
 * Importable en SSR/node: ningún global del navegador se toca al importar, solo dentro
 * de las funciones y siempre con `typeof` antes.
 */
import { useCallback, useEffect, useRef, useState } from "react";

// ───────────────────────────── Tipos y errores ─────────────────────────────

export interface GeoPosition {
  lat: number;
  lng: number;
  accuracy_m: number;
}

export type GeoErrorCode = "unsupported" | "denied" | "unavailable" | "timeout" | "insecure" | "aborted";

export const GEO_ERROR_MESSAGES: Readonly<Record<GeoErrorCode, string>> = {
  unsupported: "Tu navegador no permite obtener la ubicación. Prueba con otro navegador, como Chrome o Safari.",
  denied: "Bloqueaste el acceso a tu ubicación. Puedes activarlo en los ajustes del navegador.",
  unavailable: "No pudimos obtener tu ubicación. Revisa que el GPS esté activo.",
  timeout: "Se demoró demasiado en encontrar tu ubicación. Intenta de nuevo.",
  insecure:
    "Tu navegador solo entrega la ubicación en páginas seguras. Abre el enlace que empieza con https:// e intenta de nuevo.",
  aborted: "Se canceló la búsqueda de tu ubicación.",
};

export class GeoError extends Error {
  readonly code: GeoErrorCode;
  constructor(code: GeoErrorCode, message: string = GEO_ERROR_MESSAGES[code], options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GeoError";
    this.code = code;
  }
}

/** Códigos de `GeolocationPositionError` (iguales en todos los navegadores). */
export const POSITION_ERROR_CODES = { PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 } as const;

/**
 * Traduce un código de `GeolocationPositionError` a `GeoErrorCode`.
 * Chrome en http (no seguro) responde PERMISSION_DENIED con "Only secure origins are allowed":
 * eso es `insecure`, no un rechazo de la persona.
 */
export function geoErrorCodeFromPositionError(code: number, message?: string): GeoErrorCode {
  if (code === POSITION_ERROR_CODES.PERMISSION_DENIED) {
    return message && /secure origin|secure context/i.test(message) ? "insecure" : "denied";
  }
  if (code === POSITION_ERROR_CODES.TIMEOUT) return "timeout";
  return "unavailable";
}

function isPositionErrorLike(err: unknown): err is { code: number; message?: string } {
  return typeof err === "object" && err !== null && typeof (err as { code?: unknown }).code === "number";
}

/** Normaliza cualquier error (GeolocationPositionError, AbortError, GeoError) a `GeoError`. */
export function toGeoError(err: unknown): GeoError {
  if (err instanceof GeoError) return err;
  const name = typeof err === "object" && err !== null ? (err as { name?: unknown }).name : undefined;
  if (name === "AbortError") return new GeoError("aborted", undefined, { cause: err });
  if (name === "SecurityError") return new GeoError("insecure", undefined, { cause: err });
  if (isPositionErrorLike(err)) {
    const msg = typeof err.message === "string" ? err.message : undefined;
    return new GeoError(geoErrorCodeFromPositionError(err.code, msg), undefined, { cause: err });
  }
  return new GeoError("unavailable", undefined, { cause: err });
}

/** Convierte coordenadas del navegador; null si vienen inválidas (algunos emuladores entregan NaN). */
export function toGeoPosition(coords: {
  latitude: number;
  longitude: number;
  accuracy: number;
}): GeoPosition | null {
  const { latitude: lat, longitude: lng, accuracy } = coords;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return null;
  }
  if (!Number.isFinite(accuracy) || accuracy < 0) return null;
  return { lat, lng, accuracy_m: accuracy };
}

// ───────────────────────────── getPosition ─────────────────────────────

export interface GetPositionOptions {
  /** Tiempo máximo por intento (ms). Por defecto 12 s. */
  timeoutMs?: number;
  /** Intentar primero con GPS (alta precisión). Por defecto true. */
  highAccuracy?: boolean;
  /** Antigüedad máxima aceptada de una posición en caché para el primer intento (ms). Por defecto 0. */
  maximumAgeMs?: number;
  signal?: AbortSignal;
}

export const DEFAULT_GEO_TIMEOUT_MS = 12_000;
/** En el intento de respaldo (baja precisión) aceptamos una posición de hasta 2 min. */
export const FALLBACK_MAX_AGE_MS = 120_000;
/**
 * Margen sobre `timeout` antes de rendirnos por nuestra cuenta: algunos navegadores nunca
 * llaman a ningún callback (p. ej. si la persona cierra el aviso de permiso sin responder).
 * El `timeout` nativo no cuenta el tiempo que el aviso de permiso está abierto, por eso el margen es amplio.
 */
export const WATCHDOG_GRACE_MS = 30_000;

/** Máximo de setTimeout (2^31 − 1 ms): un plazo mayor (o Infinity) se dispara casi de inmediato. */
export const MAX_TIMER_MS = 2_147_483_647;

/**
 * Normaliza un plazo en ms: NaN o ausente → `fallback`; luego acotado a [min, MAX_TIMER_MS].
 * Evita que Infinity desborde los temporizadores y que NaN llegue al navegador como 0 (timeout inmediato).
 */
export function clampDelayMs(value: number | undefined, fallback: number, min = 0): number {
  const v = value === undefined || Number.isNaN(value) ? fallback : value;
  return Math.min(MAX_TIMER_MS, Math.max(min, v));
}

/** Lo mínimo de `Geolocation` que usamos; permite probar la estrategia en node con un doble. */
export type GeolocationLike = Pick<Geolocation, "getCurrentPosition">;

function attemptPosition(
  geolocation: GeolocationLike,
  options: PositionOptions,
  watchdogMs: number,
  signal: AbortSignal | undefined,
): Promise<GeoPosition> {
  return new Promise<GeoPosition>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new GeoError("aborted"));
      return;
    }
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => finish(() => reject(new GeoError("aborted")));
    const watchdog = setTimeout(() => finish(() => reject(new GeoError("timeout"))), watchdogMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      geolocation.getCurrentPosition(
        (pos) =>
          finish(() => {
            const p = toGeoPosition(pos.coords);
            if (p) resolve(p);
            else reject(new GeoError("unavailable"));
          }),
        (err) => finish(() => reject(toGeoError(err))),
        options,
      );
    } catch (err) {
      finish(() => reject(toGeoError(err)));
    }
  });
}

/**
 * Estrategia con un `Geolocation` dado (exportada para pruebas): primero alta precisión;
 * si se agota el tiempo o no hay señal GPS, un único reintento con baja precisión
 * (Wi-Fi/antenas) aceptando una posición reciente en caché.
 */
export async function getPositionFrom(
  geolocation: GeolocationLike,
  opts: GetPositionOptions = {},
): Promise<GeoPosition> {
  const timeout = clampDelayMs(opts.timeoutMs, DEFAULT_GEO_TIMEOUT_MS, 1);
  const maximumAge = clampDelayMs(opts.maximumAgeMs, 0);
  const highAccuracy = opts.highAccuracy ?? true;
  const watchdogMs = Math.min(MAX_TIMER_MS, timeout + WATCHDOG_GRACE_MS);

  try {
    return await attemptPosition(
      geolocation,
      { enableHighAccuracy: highAccuracy, timeout, maximumAge },
      watchdogMs,
      opts.signal,
    );
  } catch (err) {
    const first = toGeoError(err);
    if (!highAccuracy || (first.code !== "timeout" && first.code !== "unavailable")) throw first;
    try {
      return await attemptPosition(
        geolocation,
        { enableHighAccuracy: false, timeout, maximumAge: Math.max(maximumAge, FALLBACK_MAX_AGE_MS) },
        watchdogMs,
        opts.signal,
      );
    } catch (err2) {
      throw toGeoError(err2);
    }
  }
}

/** Error de entorno (sin API o contexto no seguro), o null si se puede pedir la ubicación. */
function environmentError(): GeoError | null {
  if (typeof navigator === "undefined") return new GeoError("unsupported");
  // Antes que la existencia de la API: un navegador puede ocultarla en http, y el aviso útil es "usa https".
  if (typeof window !== "undefined" && window.isSecureContext === false) return new GeoError("insecure");
  if (!navigator.geolocation) return new GeoError("unsupported");
  return null;
}

/** Ubicación actual del dispositivo. Rechaza siempre con `GeoError`. */
export async function getPosition(opts: GetPositionOptions = {}): Promise<GeoPosition> {
  if (opts.signal?.aborted) throw new GeoError("aborted");
  const envErr = environmentError();
  if (envErr) throw envErr;
  return getPositionFrom(navigator.geolocation, opts);
}

// ───────────────────────────── watchPosition ─────────────────────────────

export interface WatchPositionOptions {
  highAccuracy?: boolean;
  maximumAgeMs?: number;
  /** Sin valor, el navegador espera indefinidamente cada lectura. */
  timeoutMs?: number;
}

/**
 * Sigue la ubicación. Devuelve una función para detener el seguimiento.
 * Los errores de entorno (sin API, no seguro) llegan a `onError` en una microtarea.
 */
export function watchPosition(
  onUpdate: (position: GeoPosition) => void,
  onError?: (error: GeoError) => void,
  opts: WatchPositionOptions = {},
): () => void {
  let stopped = false;
  const envErr = environmentError();
  if (envErr) {
    queueMicrotask(() => {
      if (!stopped) onError?.(envErr);
    });
    return () => {
      stopped = true;
    };
  }
  const options: PositionOptions = {
    enableHighAccuracy: opts.highAccuracy ?? true,
    maximumAge: clampDelayMs(opts.maximumAgeMs, 0),
  };
  if (opts.timeoutMs !== undefined && !Number.isNaN(opts.timeoutMs)) options.timeout = clampDelayMs(opts.timeoutMs, 0, 1);

  let id: number | null = null;
  try {
    id = navigator.geolocation.watchPosition(
      (pos) => {
        if (stopped) return;
        const p = toGeoPosition(pos.coords);
        if (p) onUpdate(p);
      },
      (err) => {
        if (!stopped) onError?.(toGeoError(err));
      },
      options,
    );
  } catch (err) {
    const geoErr = toGeoError(err);
    queueMicrotask(() => {
      if (!stopped) onError?.(geoErr);
    });
  }
  return () => {
    if (stopped) return;
    stopped = true;
    if (id !== null) navigator.geolocation.clearWatch(id);
  };
}

// ───────────────────────────── Permiso ─────────────────────────────

export type GeoPermission = "granted" | "denied" | "prompt" | "unknown";

export function normalizePermissionState(state: unknown): GeoPermission {
  return state === "granted" || state === "denied" || state === "prompt" ? state : "unknown";
}

/** `navigator.permissions.query` para geolocalización; null si no existe o falla (Safari antiguo lanza). */
export async function queryGeolocationPermission(): Promise<PermissionStatus | null> {
  if (typeof navigator === "undefined" || !navigator.permissions || typeof navigator.permissions.query !== "function") {
    return null;
  }
  try {
    return await navigator.permissions.query({ name: "geolocation" });
  } catch {
    return null;
  }
}

// ───────────────────────────── useGeolocation ─────────────────────────────

export type GeoStatus = "idle" | "locating" | "ready" | "error";

export interface UseGeolocationOptions {
  /** Tras la primera ubicación, seguir actualizándola mientras el componente esté montado. */
  watch?: boolean;
  /** Pedir la ubicación al montar (muestra el aviso de permiso de inmediato si aún no se ha dado). */
  auto?: boolean;
}

export interface UseGeolocationResult {
  position: GeoPosition | null;
  error: GeoError | null;
  status: GeoStatus;
  /** Pide la ubicación; nunca rechaza (null si falló, el detalle queda en `error`). */
  request: () => Promise<GeoPosition | null>;
  permission: GeoPermission;
}

export function useGeolocation(opts: UseGeolocationOptions = {}): UseGeolocationResult {
  const watch = opts.watch ?? false;
  const auto = opts.auto ?? false;

  const [position, setPosition] = useState<GeoPosition | null>(null);
  const [error, setError] = useState<GeoError | null>(null);
  const [status, setStatus] = useState<GeoStatus>(auto ? "locating" : "idle");
  const [permission, setPermission] = useState<GeoPermission>("unknown");

  const inflightRef = useRef<Promise<GeoPosition | null> | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  // Ejecuta la búsqueda; solo cambia estado en callbacks asíncronos.
  const run = useCallback((): Promise<GeoPosition | null> => {
    if (inflightRef.current) return inflightRef.current;
    const controller = new AbortController();
    controllerRef.current = controller;
    const promise: Promise<GeoPosition | null> = getPosition({ signal: controller.signal })
      .then(
        (pos) => {
          if (controller.signal.aborted) return null;
          setPosition(pos);
          setError(null);
          setStatus("ready");
          setPermission("granted");
          return pos;
        },
        (err: unknown) => {
          if (controller.signal.aborted) return null;
          const geoErr = toGeoError(err);
          setError(geoErr);
          setStatus("error");
          if (geoErr.code === "denied") setPermission("denied");
          return null;
        },
      )
      .finally(() => {
        if (inflightRef.current === promise) inflightRef.current = null;
        if (controllerRef.current === controller) controllerRef.current = null;
      });
    inflightRef.current = promise;
    return promise;
  }, []);

  const request = useCallback((): Promise<GeoPosition | null> => {
    setStatus("locating");
    setError(null);
    return run();
  }, [run]);

  // Al desmontar (y en el doble montaje de Strict Mode) se cancela la búsqueda en curso.
  useEffect(
    () => () => {
      controllerRef.current?.abort();
      controllerRef.current = null;
      inflightRef.current = null;
    },
    [],
  );

  useEffect(() => {
    if (auto) void run();
  }, [auto, run]);

  // Estado del permiso, con aviso de cambios si el navegador los emite.
  useEffect(() => {
    let cancelled = false;
    let permStatus: PermissionStatus | null = null;
    const onChange = () => {
      if (permStatus) setPermission(normalizePermissionState(permStatus.state));
    };
    void queryGeolocationPermission().then((s) => {
      if (cancelled || !s) return;
      permStatus = s;
      setPermission(normalizePermissionState(s.state));
      try {
        s.addEventListener("change", onChange);
      } catch {
        // Algunos navegadores entregan el estado pero no emiten cambios.
      }
    });
    return () => {
      cancelled = true;
      try {
        permStatus?.removeEventListener("change", onChange);
      } catch {
        // idem
      }
    };
  }, []);

  // Seguimiento continuo una vez que hay una primera ubicación.
  const ready = status === "ready";
  useEffect(() => {
    if (!watch || !ready) return;
    return watchPosition(
      (pos) => setPosition(pos),
      (err) => {
        // Cortes de señal momentáneos: se conserva la última ubicación conocida.
        if (err.code === "timeout" || err.code === "unavailable") return;
        setError(err);
        setStatus("error");
        if (err.code === "denied") setPermission("denied");
      },
    );
  }, [watch, ready]);

  return { position, error, status, request, permission };
}

// ───────────────────────────── Brújula ─────────────────────────────

/** Extensiones de Safari iOS sobre DeviceOrientationEvent. */
interface WebkitDeviceOrientationEvent extends DeviceOrientationEvent {
  /** Grados desde el norte magnético, en sentido horario. */
  readonly webkitCompassHeading?: number;
  /** Error estimado en grados; negativo = brújula sin calibrar / lectura inválida. */
  readonly webkitCompassAccuracy?: number;
}

interface DeviceOrientationEventStatic {
  /** Solo iOS 13+: debe llamarse dentro de un gesto de la persona (click/touchend). */
  requestPermission?: () => Promise<PermissionState | "granted" | "denied">;
}

/** Normaliza un ángulo a [0, 360). */
export function normalizeHeading(deg: number): number {
  const r = deg % 360;
  const n = r < 0 ? r + 360 : r;
  return n === 360 || Object.is(n, -0) ? 0 : n;
}

/** Rumbo (horario desde el norte) del borde superior del teléfono a partir de `alpha` absoluto. */
export function headingFromAlpha(alpha: number): number {
  return normalizeHeading(360 - alpha);
}

/**
 * Rumbo hacia donde apunta la cámara trasera (eje −z del dispositivo), a partir de los ángulos
 * absolutos alpha/beta/gamma (fórmula del ejemplo de la especificación W3C DeviceOrientation).
 * Necesario porque con el teléfono en horizontal (apaisado) `360 − alpha` se equivoca en ~90°.
 * Con el teléfono casi plano la cámara apunta al suelo: se usa el borde superior (`headingFromAlpha`).
 */
export function headingFromOrientation(alpha: number, beta: number | null, gamma: number | null): number {
  const rad = Math.PI / 180;
  const a = alpha * rad;
  const b = (beta ?? 0) * rad;
  const g = (gamma ?? 0) * rad;
  const east = -Math.cos(a) * Math.sin(g) - Math.sin(a) * Math.sin(b) * Math.cos(g);
  const north = -Math.sin(a) * Math.sin(g) + Math.cos(a) * Math.sin(b) * Math.cos(g);
  // Componente horizontal del eje de la cámara: < 0,34 ≈ menos de 20° de inclinación respecto del plano.
  if (Math.hypot(east, north) < 0.34) return headingFromAlpha(alpha);
  return normalizeHeading(Math.atan2(east, north) / rad);
}

/** Campos de un evento de orientación que usamos (permite probar con objetos simples). */
export interface OrientationSample {
  alpha: number | null;
  beta: number | null;
  gamma: number | null;
  absolute: boolean;
  webkitCompassHeading?: number;
  webkitCompassAccuracy?: number;
}

/** Rumbo de una lectura, o null si no es absoluta/válida. */
export function headingFromSample(s: OrientationSample): number | null {
  if (typeof s.webkitCompassHeading === "number" && Number.isFinite(s.webkitCompassHeading)) {
    if (typeof s.webkitCompassAccuracy === "number" && s.webkitCompassAccuracy < 0) return null;
    return normalizeHeading(s.webkitCompassHeading);
  }
  if (!s.absolute || s.alpha === null || !Number.isFinite(s.alpha)) return null;
  return headingFromOrientation(s.alpha, s.beta, s.gamma);
}

/**
 * Media circular de ángulos en grados (350° y 10° → 0°, no 180°).
 * null si no hay ángulos o se anulan entre sí (p. ej. 0° y 180°).
 */
export function circularMeanDeg(angles: readonly number[]): number | null {
  if (angles.length === 0) return null;
  let x = 0;
  let y = 0;
  for (const deg of angles) {
    const r = (deg * Math.PI) / 180;
    x += Math.cos(r);
    y += Math.sin(r);
  }
  if (Math.hypot(x, y) / angles.length < 1e-6) return null;
  return normalizeHeading((Math.atan2(y, x) * 180) / Math.PI);
}

export interface CompassOptions {
  /** Espera máxima por lecturas (ms). Por defecto 1500. */
  timeoutMs?: number;
  /** Lecturas a promediar antes de responder. Por defecto 3. */
  samples?: number;
  signal?: AbortSignal;
}

export const DEFAULT_COMPASS_TIMEOUT_MS = 1500;
export const DEFAULT_COMPASS_SAMPLES = 3;

/**
 * Escucha eventos de orientación en `target` hasta juntar `samples` lecturas válidas o agotar
 * el tiempo, y responde con su media circular (o null). Exportada para pruebas.
 */
export function collectHeading(
  target: Pick<EventTarget, "addEventListener" | "removeEventListener">,
  eventTypes: readonly string[],
  opts: CompassOptions = {},
): Promise<number | null> {
  const timeoutMs = clampDelayMs(opts.timeoutMs, DEFAULT_COMPASS_TIMEOUT_MS);
  const samples = Math.floor(opts.samples ?? DEFAULT_COMPASS_SAMPLES);
  const wanted = Number.isNaN(samples) ? DEFAULT_COMPASS_SAMPLES : Math.max(1, samples);
  const signal = opts.signal;
  return new Promise<number | null>((resolve) => {
    if (signal?.aborted || eventTypes.length === 0) {
      resolve(null);
      return;
    }
    const readings: number[] = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      for (const t of eventTypes) target.removeEventListener(t, onEvent);
      signal?.removeEventListener("abort", onAbort);
      resolve(circularMeanDeg(readings));
    };
    const onAbort = () => {
      readings.length = 0;
      finish();
    };
    const onEvent = (ev: Event) => {
      const heading = headingFromSample(ev as WebkitDeviceOrientationEvent);
      if (heading === null) return;
      readings.push(heading);
      if (readings.length >= wanted) finish();
    };
    // Al agotar el tiempo se responde con lo que haya (aunque sea una sola lectura).
    const timer = setTimeout(finish, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    for (const t of eventTypes) target.addEventListener(t, onEvent);
  });
}

/**
 * Pide permiso de sensores de orientación (solo iOS 13+; en el resto responde true sin preguntar).
 * DEBE llamarse sincrónicamente dentro de un gesto (onClick/onTouchEnd), antes de cualquier `await`;
 * si no, iOS lo rechaza. Útil para pedirlo temprano (p. ej. al tocar "Grabar") y leer después.
 */
export async function requestCompassPermission(): Promise<boolean> {
  if (typeof window === "undefined" || typeof DeviceOrientationEvent === "undefined") return false;
  const ctor = DeviceOrientationEvent as unknown as DeviceOrientationEventStatic;
  if (typeof ctor.requestPermission !== "function") return true;
  try {
    return (await ctor.requestPermission()) === "granted";
  } catch {
    return false;
  }
}

/**
 * Rumbo de brújula en grados (0 = norte, horario), o null si el dispositivo no lo entrega,
 * se negó el permiso o no llegó una lectura a tiempo.
 * - iOS: pide permiso (DeviceOrientationEvent.requestPermission) y usa `webkitCompassHeading`.
 *   Llamar DIRECTAMENTE desde el gesto de la persona, sin un `await` previo en el handler.
 * - Android/Chrome: `deviceorientationabsolute` (solo lecturas con `absolute = true`).
 * Promedia unas pocas lecturas (media circular) para suavizar el ruido.
 */
export async function getCompassHeading(opts: CompassOptions = {}): Promise<number | null> {
  if (typeof window === "undefined" || typeof DeviceOrientationEvent === "undefined") return null;
  // Primera instrucción: requestPermission debe ocurrir sincrónicamente dentro del gesto.
  const granted = await requestCompassPermission();
  if (!granted) return null;
  const types: string[] = ["deviceorientation"];
  if ("ondeviceorientationabsolute" in window) types.push("deviceorientationabsolute");
  return collectHeading(window, types, opts);
}
