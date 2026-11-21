"use client";
/** Hooks de cliente del visor; todos son seguros en SSR (devuelven valores neutros en el servidor). */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type RefObject } from "react";
import type { DroneMission, Incident, SceneModel } from "@/lib/domain";
import type { MediaView } from "@/lib/contract";
import {
  composeView,
  deriveCameras,
  deriveDrones,
  hashString,
  mediaKey,
  missionsKey,
  normalizeScene,
  type SceneView,
} from "./model";
import type { SceneSelection } from "./types";

const noopSubscribe = () => () => {};

/* ───────────── WebGL ───────────── */

let webglCache: boolean | undefined;

export function detectWebGL(): boolean {
  if (webglCache !== undefined) return webglCache;
  try {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    webglCache = !!ctx;
    // Libera el contexto de prueba (los navegadores limitan cuántos hay vivos).
    const lose = ctx?.getExtension("WEBGL_lose_context");
    lose?.loseContext();
  } catch {
    webglCache = false;
  }
  return webglCache;
}

/** null en el servidor y durante la hidratación; luego true/false. */
export function useWebGLSupport(): boolean | null {
  return useSyncExternalStore<boolean | null>(noopSubscribe, detectWebGL, () => null);
}

/* ───────────── Movimiento reducido ───────────── */

const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeReduced(cb: () => void) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const mq = window.matchMedia(REDUCED_QUERY);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}

export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReduced,
    () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(REDUCED_QUERY).matches,
    () => false,
  );
}

/* ───────────── Visibilidad de la página ───────────── */

function subscribeVisibility(cb: () => void) {
  document.addEventListener("visibilitychange", cb);
  return () => document.removeEventListener("visibilitychange", cb);
}

export function usePageVisible(): boolean {
  return useSyncExternalStore(
    subscribeVisibility,
    () => document.visibilityState !== "hidden",
    () => true,
  );
}

/* ───────────── Elemento en pantalla ───────────── */

export function useInView(ref: RefObject<Element | null>): boolean {
  const [inView, setInView] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      const e = entries[entries.length - 1];
      if (e) setInView(e.isIntersecting);
    });
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return inView;
}

/**
 * En pantalla y visible: además del IntersectionObserver revisa cada segundo si un
 * ancestro lo ocultó con `visibility: hidden` (p. ej. una pestaña inactiva del mando).
 */
export function useOnScreen(ref: RefObject<Element | null>): boolean {
  const inView = useInView(ref);
  const [shown, setShown] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof el.checkVisibility !== "function") return;
    const id = setInterval(() => {
      const v = el.checkVisibility({ visibilityProperty: true });
      setShown((prev) => (prev === v ? prev : v));
    }, 1000);
    return () => clearInterval(id);
  }, [ref]);
  return inView && shown;
}

/* ───────────── Tamaño de un elemento ───────────── */

export function useElementSize(ref: RefObject<Element | null>, fallback: { width: number; height: number }) {
  const [size, setSize] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[entries.length - 1]?.contentRect;
      if (r && r.width > 0 && r.height > 0) {
        setSize((prev) =>
          Math.abs(prev.width - r.width) < 1 && Math.abs(prev.height - r.height) < 1
            ? prev
            : { width: r.width, height: r.height },
        );
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

/* ───────────── Reloj compartido ───────────── */

let nowValue = 0;
const nowListeners = new Set<() => void>();
let nowTimer: ReturnType<typeof setInterval> | null = null;

function subscribeNow(cb: () => void) {
  nowListeners.add(cb);
  if (nowTimer === null) {
    nowValue = Date.now();
    nowTimer = setInterval(() => {
      nowValue = Date.now();
      nowListeners.forEach((l) => l());
    }, 10_000);
  }
  return () => {
    nowListeners.delete(cb);
    if (nowListeners.size === 0 && nowTimer !== null) {
      clearInterval(nowTimer);
      nowTimer = null;
    }
  };
}

function getNow() {
  // Valor cacheado: useSyncExternalStore exige el mismo resultado entre llamadas seguidas.
  const t = Date.now();
  if (nowTimer === null && t - nowValue > 10_000) nowValue = t;
  return nowValue;
}

/** Hora actual (ms) que avanza cada 10 s; null en el servidor (evita desajustes de hidratación). */
export function useNow(): number | null {
  return useSyncExternalStore<number | null>(subscribeNow, getNow, () => null);
}

/* ───────────── Valor recalculado solo si cambia la clave ───────────── */

/**
 * Recalcula `compute()` solo cuando cambia `key` (patrón de estado derivado de React).
 * Así un sondeo que trae el mismo contenido con otra referencia no reconstruye la escena.
 */
export function useStableByKey<T>(key: string, compute: () => T): T {
  const [box, setBox] = useState(() => ({ key, value: compute() }));
  if (box.key !== key) {
    const next = { key, value: compute() };
    setBox(next);
    return next.value;
  }
  return box.value;
}

/* ───────────── Modelo de dibujo desde las props ───────────── */

/**
 * Normaliza y deriva el modelo de dibujo. Solo se reconstruye si cambia el
 * contenido (updatedAt + huella de la escena), los medios con posición o las misiones.
 */
export function useSceneView(
  scene: SceneModel | null,
  updatedAt: string | null,
  incident: Pick<Incident, "lat" | "lng">,
  media: readonly MediaView[],
  missions: readonly DroneMission[],
): SceneView | null {
  const sceneJson = useMemo(() => (scene ? JSON.stringify(scene) : ""), [scene]);
  const sceneKey = scene ? `${updatedAt ?? ""}#${hashString(sceneJson)}` : "none";
  const norm = useStableByKey(sceneKey, () => (scene ? normalizeScene(scene) : null));

  const lat = incident.lat;
  const lng = incident.lng;
  const camKey = `${sceneKey}|${lat},${lng}|${mediaKey(media)}`;
  const cameras = useStableByKey(camKey, () => (norm ? deriveCameras(norm, media, { lat, lng }) : []));
  const droneKey = `${lat},${lng}|${missionsKey(missions)}`;
  const drones = useStableByKey(droneKey, () => deriveDrones(missions, { lat, lng }));

  return useMemo(() => (norm ? composeView(norm, cameras, drones) : null), [norm, cameras, drones]);
}

/* ───────────── Selección controlada o no controlada ───────────── */

export function useSelection(
  selection: SceneSelection | null | undefined,
  onSelect: ((sel: SceneSelection | null) => void) | undefined,
): [SceneSelection | null, (sel: SceneSelection | null) => void] {
  const [internal, setInternal] = useState<SceneSelection | null>(null);
  const controlled = selection !== undefined;
  const current = controlled ? selection : internal;
  const select = useCallback(
    (sel: SceneSelection | null) => {
      if (!controlled) setInternal(sel);
      onSelect?.(sel);
    },
    [controlled, onSelect],
  );
  return [current, select];
}
