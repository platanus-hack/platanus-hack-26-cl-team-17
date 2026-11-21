/**
 * Geometría pura de la escena (sin three.js): mapeo de coordenadas, plantas
 * orientadas, cajas envolventes y encuadre de cámara.
 *
 * Escena ENU en metros (x Este, y Norte, z altura) → three.js (Y arriba):
 *   three.x = x · three.y = z · three.z = -y   (Norte hacia -Z)
 * Rumbos: 0 = Norte, sentido horario.
 */
import { headingVector, normalizeDeg } from "@/lib/geo";

export type Vec3 = [number, number, number];
export interface XY {
  x: number;
  y: number;
}

const RAD = Math.PI / 180;

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/** ENU → three.js. */
export function toThree(x: number, y: number, z = 0): Vec3 {
  return [x, z, -y];
}

/** three.js → ENU. */
export function fromThree(v: Vec3): { x: number; y: number; z: number } {
  return { x: v[0], y: -v[2], z: v[1] };
}

/** Rotación en Y (rad) que lleva el eje local +Z de un objeto al rumbo dado. */
export function yawForHeading(headingDeg: number): number {
  return Math.PI - normalizeDeg(headingDeg) * RAD;
}

/** Vector unitario three.js (y = 0) de un rumbo. */
export function headingToThree(headingDeg: number): Vec3 {
  const h = headingVector(headingDeg);
  return [h.x, 0, -h.y];
}

/** Rumbo (0 = N, horario) de un vector ENU. */
export function headingOf(dx: number, dy: number): number {
  return normalizeDeg(Math.atan2(dx, dy) / RAD);
}

/* ─────────────── Plantas orientadas (estructuras, vehículos) ─────────────── */

/**
 * Planta rectangular. `rotationDeg` = rumbo hacia el que mira el frente;
 * `width` corre a lo largo del frente y `depth` hacia atrás.
 * Ejes locales: u = hacia la derecha vista desde la calle (rumbo − 90°), v = hacia el frente.
 * En three.js el eje local +X coincide con u y +Z con v usando `yawForHeading`.
 */
export interface Footprint {
  x: number;
  y: number;
  width: number;
  depth: number;
  rotationDeg: number;
}

export function footprintAxes(rotationDeg: number): { right: XY; front: XY } {
  return { right: headingVector(rotationDeg - 90), front: headingVector(rotationDeg) };
}

export function localToWorld(fp: Footprint, u: number, v: number): XY {
  const { right, front } = footprintAxes(fp.rotationDeg);
  return { x: fp.x + u * right.x + v * front.x, y: fp.y + u * right.y + v * front.y };
}

export function worldToLocal(fp: Footprint, x: number, y: number): { u: number; v: number } {
  const { right, front } = footprintAxes(fp.rotationDeg);
  const dx = x - fp.x;
  const dy = y - fp.y;
  return { u: dx * right.x + dy * right.y, v: dx * front.x + dy * front.y };
}

/** Esquinas: frente-izquierda, frente-derecha, atrás-derecha, atrás-izquierda. */
export function footprintCorners(fp: Footprint): [XY, XY, XY, XY] {
  const hw = fp.width / 2;
  const hd = fp.depth / 2;
  return [
    localToWorld(fp, -hw, hd),
    localToWorld(fp, hw, hd),
    localToWorld(fp, hw, -hd),
    localToWorld(fp, -hw, -hd),
  ];
}

export function isInsideFootprint(fp: Footprint, x: number, y: number, margin = 0): boolean {
  const { u, v } = worldToLocal(fp, x, y);
  return Math.abs(u) <= fp.width / 2 + margin && Math.abs(v) <= fp.depth / 2 + margin;
}

export type FacadeSide = "front" | "rear" | "left" | "right";

/**
 * Punto sobre una fachada: conserva la coordenada a lo largo de la fachada de (x, y)
 * (acotada al largo del muro) y lo apoya sobre el muro, desplazado `outward` metros hacia afuera.
 */
export function pointOnFacade(fp: Footprint, side: FacadeSide, x: number, y: number, outward = 0): XY {
  const { u, v } = worldToLocal(fp, x, y);
  const hw = fp.width / 2;
  const hd = fp.depth / 2;
  const mu = Math.max(0, hw - 0.5);
  const mv = Math.max(0, hd - 0.5);
  switch (side) {
    case "front":
      return localToWorld(fp, clamp(u, -mu, mu), hd + outward);
    case "rear":
      return localToWorld(fp, clamp(u, -mu, mu), -hd - outward);
    case "right":
      return localToWorld(fp, hw + outward, clamp(v, -mv, mv));
    case "left":
      return localToWorld(fp, -hw - outward, clamp(v, -mv, mv));
  }
}

/** Fachada más cercana a un punto (para personas en ventanas). */
export function nearestFacade(fp: Footprint, x: number, y: number): FacadeSide {
  const { u, v } = worldToLocal(fp, x, y);
  const hw = fp.width / 2;
  const hd = fp.depth / 2;
  const d: [FacadeSide, number][] = [
    ["front", Math.abs(hd - v)],
    ["rear", Math.abs(-hd - v)],
    ["right", Math.abs(hw - u)],
    ["left", Math.abs(-hw - u)],
  ];
  d.sort((a, b) => a[1] - b[1]);
  return d[0][0];
}

/** Punto (x, y) acotado al interior de la planta, con margen interior. */
export function clampInsideFootprint(fp: Footprint, x: number, y: number, inset = 0.5): XY {
  const { u, v } = worldToLocal(fp, x, y);
  const mu = Math.max(0, fp.width / 2 - inset);
  const mv = Math.max(0, fp.depth / 2 - inset);
  return localToWorld(fp, clamp(u, -mu, mu), clamp(v, -mv, mv));
}

/* ─────────────────────────── Cajas envolventes ─────────────────────────── */

export interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

export function boundsOf(points: readonly { x: number; y: number; z?: number }[]): Bounds | null {
  if (points.length === 0) return null;
  const b: Bounds = {
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
    minZ: 0,
    maxZ: 0,
  };
  for (const p of points) {
    b.minX = Math.min(b.minX, p.x);
    b.maxX = Math.max(b.maxX, p.x);
    b.minY = Math.min(b.minY, p.y);
    b.maxY = Math.max(b.maxY, p.y);
    const z = p.z ?? 0;
    b.minZ = Math.min(b.minZ, z);
    b.maxZ = Math.max(b.maxZ, z);
  }
  return b;
}

/** Agrega margen y asegura una semiextensión horizontal mínima. */
export function padBounds(b: Bounds, pad: number, minHalf: number): Bounds {
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const hx = Math.max(minHalf, (b.maxX - b.minX) / 2 + pad);
  const hy = Math.max(minHalf, (b.maxY - b.minY) / 2 + pad);
  return { minX: cx - hx, maxX: cx + hx, minY: cy - hy, maxY: cy + hy, minZ: b.minZ, maxZ: b.maxZ };
}

export function unionBounds(a: Bounds, b: Bounds): Bounds {
  return {
    minX: Math.min(a.minX, b.minX),
    maxX: Math.max(a.maxX, b.maxX),
    minY: Math.min(a.minY, b.minY),
    maxY: Math.max(a.maxY, b.maxY),
    minZ: Math.min(a.minZ, b.minZ),
    maxZ: Math.max(a.maxZ, b.maxZ),
  };
}

export function boundsCenter(b: Bounds): { x: number; y: number; z: number } {
  return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2, z: (b.minZ + b.maxZ) / 2 };
}

/** Lado del suelo cuadrado (múltiplo de 10 m) centrado en `center` que cubre `b` con margen. */
export function groundSize(b: Bounds, center: XY, margin = 30, min = 120, max = 1200): number {
  const half = Math.max(
    Math.abs(b.minX - center.x),
    Math.abs(b.maxX - center.x),
    Math.abs(b.minY - center.y),
    Math.abs(b.maxY - center.y),
  );
  const size = Math.ceil(((half + margin) * 2) / 20) * 20;
  return clamp(size, min, max);
}

/* ─────────────────────────────── Encuadre ─────────────────────────────── */

export type ViewPreset = "iso" | "top" | "front" | "rear";

export const VIEW_PRESETS: { key: ViewPreset; label: string }[] = [
  { key: "iso", label: "Isométrica" },
  { key: "top", label: "Planta" },
  { key: "front", label: "Frente" },
  { key: "rear", label: "Posterior" },
];

/** Desde dónde mira la cámara: rumbo desde el centro hacia la cámara y elevación. */
export function viewAngles(preset: ViewPreset, frontHeadingDeg: number): { azimuthDeg: number; elevationDeg: number } {
  switch (preset) {
    case "iso":
      return { azimuthDeg: normalizeDeg(frontHeadingDeg + 35), elevationDeg: 38 };
    case "top":
      // Cámara casi vertical, apenas desplazada al sur: el Norte queda arriba en pantalla.
      return { azimuthDeg: 180, elevationDeg: 89.9 };
    case "front":
      return { azimuthDeg: normalizeDeg(frontHeadingDeg), elevationDeg: 14 };
    case "rear":
      return { azimuthDeg: normalizeDeg(frontHeadingDeg + 180), elevationDeg: 18 };
  }
}

export interface CameraFit {
  position: Vec3;
  target: Vec3;
  distance: number;
}

/**
 * Posición de cámara (three.js) que encuadra `b` desde la vista pedida.
 * `aspect` = ancho / alto del lienzo; `fovDeg` = campo vertical.
 */
export function fitView(
  b: Bounds,
  preset: ViewPreset,
  frontHeadingDeg: number,
  aspect: number,
  fovDeg = 45,
): CameraFit {
  const c = boundsCenter(b);
  for (const v of [c.x, c.y, c.z]) if (!Number.isFinite(v)) return { position: [60, 50, 60], target: [0, 0, 0], distance: 95 };
  const hx = (b.maxX - b.minX) / 2;
  const hy = (b.maxY - b.minY) / 2;
  const hz = (b.maxZ - b.minZ) / 2;
  const safeAspect = Number.isFinite(aspect) && aspect > 0.1 ? Math.min(aspect, 10) : 1.5;
  const vfov = clamp(fovDeg, 10, 120) * RAD;
  const hfov = 2 * Math.atan(Math.tan(vfov / 2) * safeAspect);
  const fit = Math.min(vfov, hfov);
  // En planta solo importa la extensión horizontal; en el resto, la esfera envolvente.
  const radius = preset === "top" ? Math.max(8, Math.hypot(hx, hy) * 0.82) : Math.max(8, Math.hypot(hx, hy, hz));
  const distance = clamp((radius / Math.sin(fit / 2)) * 1.04, 10, 4000);
  const { azimuthDeg, elevationDeg } = viewAngles(preset, Number.isFinite(frontHeadingDeg) ? frontHeadingDeg : 180);
  const az = azimuthDeg * RAD;
  const el = elevationDeg * RAD;
  const tz = clamp(c.z * 0.6, 0, 20);
  const target = toThree(c.x, c.y, tz);
  const position = toThree(
    c.x + distance * Math.cos(el) * Math.sin(az),
    c.y + distance * Math.cos(el) * Math.cos(az),
    tz + distance * Math.sin(el),
  );
  return { position, target, distance };
}

/** Largo "redondo" para una barra de escala de ~`targetPx` píxeles. */
export function niceScaleLength(metersPerPixel: number, targetPx = 90): number {
  const want = metersPerPixel * targetPx;
  const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000];
  let best = steps[0];
  for (const s of steps) if (s <= want) best = s;
  return best;
}
