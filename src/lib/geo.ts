/**
 * Geodesia mínima para la escena local. Funciones puras, usables en servidor y cliente.
 *
 * Sistema local ENU (metros): origen en el incidente, x = Este, y = Norte.
 * Aproximación equirectangular: error < 0,1 % a escalas de un incidente (< 2 km).
 */
export interface LatLng {
  lat: number;
  lng: number;
}
export interface LocalXY {
  x: number;
  y: number;
}

const R = 6_371_000;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** Distancia en metros entre dos puntos (haversine). */
export function distanceM(a: LatLng, b: LatLng): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Rumbo inicial de `a` hacia `b` en grados (0 = Norte, horario). */
export function bearingDeg(a: LatLng, b: LatLng): number {
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x =
    Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
    Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return normalizeDeg(deg(Math.atan2(y, x)));
}

export function normalizeDeg(d: number): number {
  return ((d % 360) + 360) % 360;
}

/** lat/lng → metros locales respecto del origen. */
export function toLocal(origin: LatLng, p: LatLng): LocalXY {
  const x = rad(p.lng - origin.lng) * R * Math.cos(rad(origin.lat));
  const y = rad(p.lat - origin.lat) * R;
  return { x, y };
}

/** Metros locales → lat/lng. */
export function toLatLng(origin: LatLng, p: LocalXY): LatLng {
  const lat = origin.lat + deg(p.y / R);
  const lng = origin.lng + deg(p.x / (R * Math.cos(rad(origin.lat))));
  return { lat, lng };
}

/** Punto a `distM` metros de `origin` en el rumbo `bearing`. */
export function destination(origin: LatLng, bearing: number, distM: number): LatLng {
  return toLatLng(origin, {
    x: Math.sin(rad(bearing)) * distM,
    y: Math.cos(rad(bearing)) * distM,
  });
}

/** Vector unitario (x Este, y Norte) para un rumbo. */
export function headingVector(bearing: number): LocalXY {
  return { x: Math.sin(rad(bearing)), y: Math.cos(rad(bearing)) };
}

/** Waypoints de una órbita circular alrededor del centro. */
export function orbitWaypoints(
  center: LatLng,
  radiusM: number,
  altitudeM: number,
  points = 16,
): { lat: number; lng: number; alt_m: number }[] {
  return Array.from({ length: points }, (_, i) => {
    const p = destination(center, (360 / points) * i, radiusM);
    return { lat: p.lat, lng: p.lng, alt_m: altitudeM };
  });
}

/** Barrido en zigzag (cortacésped) sobre un cuadrado de lado 2·radio. */
export function gridWaypoints(
  center: LatLng,
  radiusM: number,
  altitudeM: number,
  lanes = 5,
): { lat: number; lng: number; alt_m: number }[] {
  const out: { lat: number; lng: number; alt_m: number }[] = [];
  for (let i = 0; i < lanes; i++) {
    const y = -radiusM + (2 * radiusM * i) / (lanes - 1);
    const xs = i % 2 === 0 ? [-radiusM, radiusM] : [radiusM, -radiusM];
    for (const x of xs) {
      const p = toLatLng(center, { x, y });
      out.push({ lat: p.lat, lng: p.lng, alt_m: altitudeM });
    }
  }
  return out;
}

/** Redondea coordenadas para exponerlas públicamente (~110 m con 3 decimales). */
export function roundCoord(v: number, decimals = 3): number {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}

const CARDINALS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;
export function cardinalOf(bearing: number): (typeof CARDINALS)[number] {
  return CARDINALS[Math.round(normalizeDeg(bearing) / 45) % 8];
}
export function bearingOfCardinal(c: string): number | null {
  const i = CARDINALS.indexOf(c as (typeof CARDINALS)[number]);
  return i < 0 ? null : i * 45;
}

/** Rumbo en texto para humanos: "NE (45°)". */
export function formatBearing(bearing: number): string {
  return `${cardinalOf(bearing)} (${Math.round(normalizeDeg(bearing))}°)`;
}

export function isValidLatLng(lat: unknown, lng: unknown): boolean {
  return (
    typeof lat === "number" &&
    typeof lng === "number" &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180 &&
    !(lat === 0 && lng === 0)
  );
}
