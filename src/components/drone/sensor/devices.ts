"use client";
/**
 * Sensores del teléfono para el modo sensor: cámara trasera, GPS continuo, brújula continua,
 * batería y pantalla encendida (Wake Lock). Cada hook expone el último valor en un ref
 * (para el ciclo de envío, sin re-render) y un estado para la interfaz.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { GEO_ERROR_MESSAGES, headingFromSample, requestCompassPermission, type OrientationSample } from "@/lib/client/geo";
import { cameraErrorMessage, type CompassReading, type GpsFix } from "./core";

const isSecure = () => typeof window !== "undefined" && window.isSecureContext;

/* ───────────── Cámara ───────────── */

export type CameraStatus = "off" | "starting" | "ready" | "error";

export interface CameraState {
  status: CameraStatus;
  error: string | null;
  /** false si el navegador entregó la cámara frontal (o no dijo cuál). */
  rear: boolean | null;
}

export function useCamera(videoRef: RefObject<HTMLVideoElement | null>) {
  const [state, setState] = useState<CameraState>({ status: "off", error: null, rear: null });
  const streamRef = useRef<MediaStream | null>(null);
  const readyRef = useRef(false);

  const stop = useCallback(() => {
    readyRef.current = false;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setState((s) => (s.status === "error" ? s : { status: "off", error: null, rear: s.rear }));
  }, [videoRef]);

  const start = useCallback(async (): Promise<boolean> => {
    if (streamRef.current) return true;
    setState({ status: "starting", error: null, rear: null });
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setState({ status: "error", error: cameraErrorMessage({ name: "unsupported" }, isSecure()), rear: null });
      return false;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      });
      streamRef.current = stream;
      const track = stream.getVideoTracks()[0];
      const facing = track?.getSettings().facingMode;
      track?.addEventListener("ended", () => {
        readyRef.current = false;
        streamRef.current = null;
        setState({ status: "error", error: "La cámara se apagó (otra aplicación o el sistema la tomó). Vuelve a encenderla.", rear: null });
      });
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        video.muted = true;
        video.playsInline = true;
        await video.play().catch(() => undefined);
      }
      readyRef.current = true;
      setState({ status: "ready", error: null, rear: facing === undefined ? null : facing === "environment" });
      return true;
    } catch (err) {
      setState({ status: "error", error: cameraErrorMessage(err, isSecure()), rear: null });
      return false;
    }
  }, [videoRef]);

  useEffect(() => () => streamRef.current?.getTracks().forEach((t) => t.stop()), []);

  return { state, start, stop, readyRef };
}

/* ───────────── GPS ───────────── */

export interface GpsState {
  fix: GpsFix | null;
  error: string | null;
  /** true si la persona bloqueó la ubicación (no se reintenta solo). */
  denied: boolean;
  watching: boolean;
}

const finiteOrNull = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? null : v);

export function useGpsWatch() {
  const [state, setState] = useState<GpsState>({ fix: null, error: null, denied: false, watching: false });
  const fixRef = useRef<GpsFix | null>(null);
  const watchRef = useRef<number | null>(null);

  const stop = useCallback(() => {
    if (watchRef.current !== null && typeof navigator !== "undefined") navigator.geolocation.clearWatch(watchRef.current);
    watchRef.current = null;
    setState((s) => ({ ...s, watching: false }));
  }, []);

  const start = useCallback(() => {
    if (watchRef.current !== null) return;
    if (!isSecure()) {
      setState((s) => ({ ...s, error: GEO_ERROR_MESSAGES.insecure }));
      return;
    }
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setState((s) => ({ ...s, error: GEO_ERROR_MESSAGES.unsupported }));
      return;
    }
    setState((s) => ({ ...s, error: null, denied: false, watching: true }));
    watchRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const c = pos.coords;
        if (!Number.isFinite(c.latitude) || !Number.isFinite(c.longitude)) return;
        const fix: GpsFix = {
          lat: c.latitude,
          lng: c.longitude,
          accuracy_m: Number.isFinite(c.accuracy) ? c.accuracy : 0,
          alt_m: finiteOrNull(c.altitude),
          speed_ms: finiteOrNull(c.speed),
          course_deg: finiteOrNull(c.heading),
          at: Date.now(),
        };
        fixRef.current = fix;
        setState({ fix, error: null, denied: false, watching: true });
      },
      (err) => {
        if (err.code === 1) {
          if (watchRef.current !== null) navigator.geolocation.clearWatch(watchRef.current);
          watchRef.current = null;
          setState((s) => ({ ...s, error: GEO_ERROR_MESSAGES.denied, denied: true, watching: false }));
          return;
        }
        // Señal débil o demora: se conserva la última posición y el navegador sigue intentando.
        setState((s) => ({ ...s, error: err.code === 3 ? GEO_ERROR_MESSAGES.timeout : GEO_ERROR_MESSAGES.unavailable }));
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20_000 },
    );
  }, []);

  useEffect(
    () => () => {
      if (watchRef.current !== null) navigator.geolocation.clearWatch(watchRef.current);
    },
    [],
  );

  return { state, start, stop, fixRef };
}

/* ───────────── Brújula ───────────── */

export type CompassStatus = "off" | "waiting" | "ok" | "unavailable";

/** Lecturas de orientación absolutas; la interfaz se actualiza a lo más 4 veces por segundo. */
export function useCompassWatch() {
  const [status, setStatus] = useState<CompassStatus>("off");
  const [deg, setDeg] = useState<number | null>(null);
  const readingRef = useRef<CompassReading | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  const stop = useCallback(() => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    setStatus("off");
  }, []);

  /** Llamar con el resultado de `requestCompassPermission()` pedido dentro del gesto (iOS). */
  const start = useCallback(async (permission: Promise<boolean>) => {
    if (cleanupRef.current) return;
    if (typeof window === "undefined" || typeof DeviceOrientationEvent === "undefined") {
      setStatus("unavailable");
      return;
    }
    if (!(await permission)) {
      setStatus("unavailable");
      return;
    }
    setStatus("waiting");
    let lastUi = 0;
    const onEvent = (ev: Event) => {
      const h = headingFromSample(ev as unknown as OrientationSample);
      if (h === null) return;
      const now = Date.now();
      readingRef.current = { deg: h, at: now };
      if (now - lastUi >= 250) {
        lastUi = now;
        setDeg(h);
        setStatus("ok");
      }
    };
    const types = ["deviceorientation"];
    if ("ondeviceorientationabsolute" in window) types.push("deviceorientationabsolute");
    for (const t of types) window.addEventListener(t, onEvent);
    // Sin lecturas absolutas en unos segundos: el equipo no tiene brújula (o está sin calibrar).
    const noData = window.setTimeout(() => {
      if (!readingRef.current) setStatus("unavailable");
    }, 4000);
    cleanupRef.current = () => {
      window.clearTimeout(noData);
      for (const t of types) window.removeEventListener(t, onEvent);
    };
  }, []);

  useEffect(() => () => cleanupRef.current?.(), []);

  return { status, deg, start, stop, readingRef };
}

export { requestCompassPermission };

/* ───────────── Batería ───────────── */

interface BatteryLike extends EventTarget {
  level: number;
}

export function useBatteryLevel() {
  const [pct, setPct] = useState<number | null>(null);
  const pctRef = useRef<number | null>(null);
  useEffect(() => {
    const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryLike> };
    if (typeof nav.getBattery !== "function") return;
    let battery: BatteryLike | null = null;
    let alive = true;
    const update = () => {
      if (!battery || !Number.isFinite(battery.level)) return;
      const v = Math.round(battery.level * 100);
      pctRef.current = v;
      setPct(v);
    };
    nav.getBattery().then(
      (b) => {
        if (!alive) return;
        battery = b;
        update();
        b.addEventListener("levelchange", update);
      },
      () => undefined,
    );
    return () => {
      alive = false;
      battery?.removeEventListener("levelchange", update);
    };
  }, []);
  return { pct, pctRef };
}

/* ───────────── Pantalla encendida ───────────── */

export type WakeLockStatus = "off" | "on" | "unsupported" | "failed";

/** Mantiene la pantalla encendida mientras `active`; la vuelve a pedir al regresar a la pestaña. */
export function useWakeLock(active: boolean): WakeLockStatus {
  const [status, setStatus] = useState<WakeLockStatus>("off");
  useEffect(() => {
    if (!active) return;
    if (typeof navigator === "undefined" || !("wakeLock" in navigator)) {
      queueMicrotask(() => setStatus("unsupported"));
      return;
    }
    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;
    const acquire = async () => {
      if (document.visibilityState !== "visible" || (sentinel && !sentinel.released)) return;
      try {
        const s = await navigator.wakeLock.request("screen");
        if (cancelled) {
          void s.release();
          return;
        }
        sentinel = s;
        setStatus("on");
        s.addEventListener("release", () => {
          if (!cancelled) setStatus("off");
        });
      } catch {
        if (!cancelled) setStatus("failed");
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") void acquire();
    };
    void acquire();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      void sentinel?.release().catch(() => undefined);
      setStatus("off");
    };
  }, [active]);
  return status;
}
