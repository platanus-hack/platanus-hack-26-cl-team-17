"use client";
/**
 * Ruta de llegada por calles: el primer tramo de la ruta del modelo (desde donde viene la
 * unidad hasta el acceso sugerido) se pide a OSRM, el enrutador público de OpenStreetMap.
 * Si no responde, queda la línea recta del modelo. Entrega también el tiempo estimado.
 */
import { useEffect, useMemo, useState } from "react";
import type { LngLat, MapPin } from "./model";

interface StreetRoute {
  key: string;
  coords: LngLat[];
  durationS: number;
}

const cache = new Map<string, StreetRoute>();

function keyOf(a: LngLat, b: LngLat): string {
  return [a, b].map(([x, y]) => `${x.toFixed(5)},${y.toFixed(5)}`).join(";");
}

export function useStreetRoute(route: readonly LngLat[]): { route: LngLat[]; durationS: number | null } {
  const key = route.length >= 2 ? keyOf(route[0], route[1]) : "";
  const [fetched, setFetched] = useState<StreetRoute | null>(null);

  useEffect(() => {
    if (!key || cache.has(key)) return;
    const ctrl = new AbortController();
    const t = window.setTimeout(() => ctrl.abort(), 8000);
    fetch(`https://router.project-osrm.org/route/v1/driving/${key}?overview=full&geometries=geojson`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { routes?: { geometry: { coordinates: LngLat[] }; duration: number }[] } | null) => {
        const best = data?.routes?.[0];
        if (!best || best.geometry.coordinates.length < 2) return;
        const value = { key, coords: best.geometry.coordinates, durationS: best.duration };
        cache.set(key, value);
        setFetched(value);
      })
      .catch(() => undefined)
      .finally(() => window.clearTimeout(t));
    return () => {
      ctrl.abort();
      window.clearTimeout(t);
    };
  }, [key]);

  const found = cache.get(key) ?? (fetched?.key === key ? fetched : null);
  return useMemo(
    () => (found ? { route: [...found.coords, ...route.slice(1)], durationS: found.durationS } : { route: [...route], durationS: null }),
    [found, route],
  );
}

/** Punto a una fracción `f` (0–1) del largo de la ruta. */
export function pointAlong(route: readonly LngLat[], f: number): LngLat {
  if (route.length === 0) return [0, 0];
  if (route.length === 1) return route[0];
  const seg: number[] = [];
  let total = 0;
  for (let i = 1; i < route.length; i++) {
    const [ax, ay] = route[i - 1];
    const [bx, by] = route[i];
    const d = Math.hypot((bx - ax) * Math.cos((ay * Math.PI) / 180), by - ay);
    seg.push(d);
    total += d;
  }
  let left = Math.max(0, Math.min(1, f)) * total;
  for (let i = 0; i < seg.length; i++) {
    if (left <= seg[i] || i === seg.length - 1) {
      const k = seg[i] ? Math.min(1, left / seg[i]) : 0;
      const [ax, ay] = route[i];
      const [bx, by] = route[i + 1];
      return [ax + (bx - ax) * k, ay + (by - ay) * k];
    }
    left -= seg[i];
  }
  return route[route.length - 1];
}

/** Unidades en camino sobre la ruta por calles, con minutos estimados al lugar. */
export function placeUnitsOnRoute(pins: readonly MapPin[], route: readonly LngLat[], durationS: number | null): MapPin[] {
  let i = 0;
  return pins.map((p) => {
    if (p.kind !== "unit" || p.sub !== "en camino") return p;
    const f = Math.max(0.1, 0.45 - i * 0.2);
    i++;
    const min = durationS ? Math.max(1, Math.round((durationS * (1 - f)) / 60)) : null;
    return { ...p, at: pointAlong(route, f), sub: min ? `en camino · ${min} min` : p.sub };
  });
}
