/**
 * Entorno real (referencial): edificios y calles de OpenStreetMap alrededor del GPS del
 * incidente, tomados de las teselas vectoriales de OpenFreeMap. Funciones puras: teselas
 * que cubren un radio, tesela → ENU, recorte, exclusión de lo que ya infirió la IA y
 * mallas fusionadas. La descarga y decodificación están en surroundings-data.ts.
 */
import { ShapeUtils, Vector2 } from "three";
import { toLocal, type LatLng } from "@/lib/geo";
import { footprintCorners, type Footprint, type XY } from "./geometry";

/** Radio del entorno alrededor del incidente (m). */
export const SURROUNDINGS_RADIUS = 350;
/** Zoom de las teselas (máximo de OpenFreeMap; trae todos los edificios). */
export const SURROUNDINGS_ZOOM = 14;
/** Altura cuando OSM no la trae o es inválida (m). */
export const DEFAULT_BUILDING_HEIGHT = 6;
/** Margen alrededor de las estructuras inferidas para descartar edificios OSM superpuestos (m). */
export const EXCLUSION_MARGIN = 2;

export interface TileId {
  z: number;
  x: number;
  y: number;
}

/** Anillo en coordenadas de tesela (0…extent); `cut[i]` = el lado i→i+1 viene del recorte de la tesela. */
export interface TileRing {
  pts: XY[];
  cut: boolean[];
}

/** Edificio en coordenadas de tesela: anillo exterior y agujeros. */
export interface TileBuilding {
  rings: TileRing[];
  height: number;
  minHeight: number;
}

/** Contenido útil de una tesela ya decodificada (coordenadas de tesela). */
export interface TileContent {
  tile: TileId;
  extent: number;
  buildings: TileBuilding[];
  /** Polilíneas de calles. */
  roads: XY[][];
}

/** Edificio en ENU (m): `outer` antihorario, `holes` horarios; `cut` como en TileRing. */
export interface EnvBuilding {
  outer: XY[];
  outerCut: boolean[];
  holes: XY[][];
  holesCut: boolean[][];
  height: number;
  minHeight: number;
  /** Centro aproximado (promedio de vértices del exterior). */
  center: XY;
}

export interface Surroundings {
  buildings: EnvBuilding[];
  /** Segmentos de calle en ENU: [x1, y1, x2, y2] planos. */
  roadSegments: number[];
}

export const EMPTY_SURROUNDINGS: Surroundings = { buildings: [], roadSegments: [] };

/* ───────────────────────────── Teselas ───────────────────────────── */

const RAD = Math.PI / 180;
const EARTH_R = 6_371_000;

function lngToTileX(lng: number, z: number): number {
  return ((lng + 180) / 360) * 2 ** z;
}
function latToTileY(lat: number, z: number): number {
  const s = Math.sin(lat * RAD);
  return ((1 - Math.log((1 + s) / (1 - s)) / (2 * Math.PI)) / 2) * 2 ** z;
}

/** Teselas (z fijo) que cubren el cuadrado de lado 2·radio centrado en `origin`. */
export function tilesCovering(origin: LatLng, radiusM = SURROUNDINGS_RADIUS, z = SURROUNDINGS_ZOOM): TileId[] {
  const dLat = (radiusM / EARTH_R) / RAD;
  const dLng = dLat / Math.max(0.01, Math.cos(origin.lat * RAD));
  const n = 2 ** z;
  const x0 = Math.floor(lngToTileX(origin.lng - dLng, z));
  const x1 = Math.floor(lngToTileX(origin.lng + dLng, z));
  const y0 = Math.floor(latToTileY(Math.min(85, origin.lat + dLat), z));
  const y1 = Math.floor(latToTileY(Math.max(-85, origin.lat - dLat), z));
  const out: TileId[] = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push({ z, x: ((x % n) + n) % n, y });
  return out;
}

/** Punto de tesela (px, py en 0…extent, y hacia abajo) → lat/lng (Web Mercator). */
export function tilePointToLatLng(tile: TileId, extent: number, px: number, py: number): LatLng {
  const n = 2 ** tile.z;
  const lng = ((tile.x + px / extent) / n) * 360 - 180;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (tile.y + py / extent)) / n))) / RAD;
  return { lat, lng };
}

/** Punto de tesela → ENU (m) respecto de `origin`. */
export function tilePointToLocal(origin: LatLng, tile: TileId, extent: number, px: number, py: number): XY {
  return toLocal(origin, tilePointToLatLng(tile, extent, px, py));
}

/* ───────────────────────────── Recorte a la tesela ───────────────────────────── */

/**
 * Recorta un anillo al cuadrado [0, extent] (Sutherland–Hodgman). Las teselas traen un
 * margen repetido con la vecina: sin recortar, los edificios del borde se duplicarían.
 * Los lados creados por el recorte quedan marcados en `cut` (no se dibujan como muro).
 */
export function clipRingToTile(ring: readonly XY[], extent: number): TileRing | null {
  let pts = ring.slice();
  if (pts.length > 1 && pts[0].x === pts[pts.length - 1].x && pts[0].y === pts[pts.length - 1].y) pts.pop();
  const edges: [(p: XY) => boolean, (a: XY, b: XY) => XY][] = [
    [(p) => p.x >= 0, (a, b) => ({ x: 0, y: a.y + ((b.y - a.y) * (0 - a.x)) / (b.x - a.x) })],
    [(p) => p.x <= extent, (a, b) => ({ x: extent, y: a.y + ((b.y - a.y) * (extent - a.x)) / (b.x - a.x) })],
    [(p) => p.y >= 0, (a, b) => ({ x: a.x + ((b.x - a.x) * (0 - a.y)) / (b.y - a.y), y: 0 })],
    [(p) => p.y <= extent, (a, b) => ({ x: a.x + ((b.x - a.x) * (extent - a.y)) / (b.y - a.y), y: extent })],
  ];
  for (const [inside, cross] of edges) {
    if (pts.length === 0) break;
    const next: XY[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i + pts.length - 1) % pts.length];
      const b = pts[i];
      const ia = inside(a);
      const ib = inside(b);
      if (ib) {
        if (!ia) next.push(cross(a, b));
        next.push(b);
      } else if (ia) {
        next.push(cross(a, b));
      }
    }
    pts = next;
  }
  if (pts.length < 3) return null;
  const onSameBorder = (a: XY, b: XY) =>
    (a.x === 0 && b.x === 0) || (a.x === extent && b.x === extent) || (a.y === 0 && b.y === 0) || (a.y === extent && b.y === extent);
  const cut = pts.map((p, i) => onSameBorder(p, pts[(i + 1) % pts.length]));
  return { pts, cut };
}

/** Altura útil desde render_height / render_min_height de OpenMapTiles. */
export function buildingHeights(renderHeight: unknown, renderMinHeight: unknown): { height: number; minHeight: number } {
  const h = typeof renderHeight === "number" && Number.isFinite(renderHeight) && renderHeight > 0 ? renderHeight : DEFAULT_BUILDING_HEIGHT;
  const height = Math.min(300, Math.max(2.5, h));
  const m = typeof renderMinHeight === "number" && Number.isFinite(renderMinHeight) && renderMinHeight > 0 ? renderMinHeight : 0;
  return { height, minHeight: m < height - 1 ? m : 0 };
}

/* ───────────────────────────── Polígonos ───────────────────────────── */

export function signedArea(pts: readonly XY[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

export function pointInPolygon(p: XY, poly: readonly XY[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function segmentsCross(a: XY, b: XY, c: XY, d: XY): boolean {
  const o = (p: XY, q: XY, r: XY) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = o(c, d, a);
  const d2 = o(c, d, b);
  const d3 = o(a, b, c);
  const d4 = o(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** true si dos polígonos simples se tocan (uno dentro del otro o bordes que se cruzan). */
export function polygonsOverlap(a: readonly XY[], b: readonly XY[]): boolean {
  if (a.length < 3 || b.length < 3) return false;
  if (a.some((p) => pointInPolygon(p, b)) || b.some((p) => pointInPolygon(p, a))) return true;
  for (let i = 0; i < a.length; i++) {
    const p = a[i];
    const q = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j++) if (segmentsCross(p, q, b[j], b[(j + 1) % b.length])) return true;
  }
  return false;
}

function withOrientation(pts: XY[], cut: boolean[], ccw: boolean): { pts: XY[]; cut: boolean[] } {
  if (signedArea(pts) > 0 === ccw) return { pts, cut };
  // Al invertir, el lado i→i+1 pasa a ser (n-2-i)→(n-1-i).
  const n = pts.length;
  return { pts: pts.slice().reverse(), cut: cut.map((_, i) => cut[(2 * n - 2 - i) % n]) };
}

/**
 * Teselas decodificadas → edificios y calles en ENU, dentro de `radiusM` del origen.
 * Un edificio entra si su centro cae dentro del radio.
 */
export function tilesToSurroundings(origin: LatLng, tiles: readonly TileContent[], radiusM = SURROUNDINGS_RADIUS): Surroundings {
  const buildings: EnvBuilding[] = [];
  const roadSegments: number[] = [];
  for (const t of tiles) {
    const conv = (p: XY) => tilePointToLocal(origin, t.tile, t.extent, p.x, p.y);
    for (const b of t.buildings) {
      const [outerRing, ...holeRings] = b.rings;
      if (!outerRing || outerRing.pts.length < 3) continue;
      const outerLocal = outerRing.pts.map(conv);
      const center = {
        x: outerLocal.reduce((s, p) => s + p.x, 0) / outerLocal.length,
        y: outerLocal.reduce((s, p) => s + p.y, 0) / outerLocal.length,
      };
      if (Math.hypot(center.x, center.y) > radiusM) continue;
      if (Math.abs(signedArea(outerLocal)) < 1) continue;
      const outer = withOrientation(outerLocal, outerRing.cut, true);
      const holes = holeRings.filter((r) => r.pts.length >= 3).map((r) => withOrientation(r.pts.map(conv), r.cut, false));
      buildings.push({
        outer: outer.pts,
        outerCut: outer.cut,
        holes: holes.map((h) => h.pts),
        holesCut: holes.map((h) => h.cut),
        height: b.height,
        minHeight: b.minHeight,
        center,
      });
    }
    const inTile = (p: XY) => p.x >= 0 && p.x <= t.extent && p.y >= 0 && p.y <= t.extent;
    for (const line of t.roads) {
      for (let i = 0; i + 1 < line.length; i++) {
        const a = line[i];
        const b = line[i + 1];
        // Margen compartido con la tesela vecina: el tramo se queda en la tesela de su punto medio.
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        if (!inTile(mid) || mid.x === t.extent || mid.y === t.extent) continue;
        const pa = conv(a);
        const pb = conv(b);
        if (Math.hypot(pa.x, pa.y) > radiusM && Math.hypot(pb.x, pb.y) > radiusM) continue;
        roadSegments.push(pa.x, pa.y, pb.x, pb.y);
      }
    }
  }
  return { buildings, roadSegments };
}

/* ───────────────────────────── Exclusión ───────────────────────────── */

/**
 * Quita los edificios OSM que se superponen con las estructuras inferidas por la IA
 * (con margen) o que contienen el origen del incidente: la estructura analizada no se
 * duplica ni queda tapada por su versión de OSM.
 */
export function excludeInferred(
  buildings: readonly EnvBuilding[],
  structures: readonly Footprint[],
  margin = EXCLUSION_MARGIN,
  origin: XY = { x: 0, y: 0 },
): EnvBuilding[] {
  const zones = structures
    .filter((s) => s.width > 0 && s.depth > 0)
    .map((s) => footprintCorners({ ...s, width: s.width + 2 * margin, depth: s.depth + 2 * margin }));
  return buildings.filter((b) => !pointInPolygon(origin, b.outer) && !zones.some((z) => polygonsOverlap(b.outer, z)));
}

/* ───────────────────────────── Mallas ───────────────────────────── */

export interface SurroundingsMesh {
  /** Triángulos no indexados (three.js: x Este, y altura, z −Norte). */
  positions: Float32Array;
  /** Contorno superior de cada edificio (pares de vértices). */
  edges: Float32Array;
}

/**
 * Extruye y fusiona todos los edificios en una sola malla: muros hacia afuera (sin los
 * lados de recorte de tesela) y techo triangulado con agujeros. Sin piso (va sobre el suelo).
 */
export function buildSurroundingsMesh(buildings: readonly EnvBuilding[]): SurroundingsMesh {
  const tri: number[] = [];
  const edges: number[] = [];
  const wall = (ring: readonly XY[], cut: readonly boolean[], h0: number, h1: number) => {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      if (cut[i]) continue;
      // Con el anillo antihorario (agujeros horarios) la normal de (A0, B0, B1) apunta hacia afuera.
      tri.push(a.x, h0, -a.y, b.x, h0, -b.y, b.x, h1, -b.y);
      tri.push(a.x, h0, -a.y, b.x, h1, -b.y, a.x, h1, -a.y);
      edges.push(a.x, h1, -a.y, b.x, h1, -b.y);
    }
  };
  for (const b of buildings) {
    const h0 = b.minHeight;
    const h1 = b.height;
    wall(b.outer, b.outerCut, h0, h1);
    b.holes.forEach((h, i) => wall(h, b.holesCut[i] ?? [], h0, h1));
    const contour = b.outer.map((p) => new Vector2(p.x, p.y));
    const holes = b.holes.map((h) => h.map((p) => new Vector2(p.x, p.y)));
    const all = [...contour, ...holes.flat()];
    let faces: number[][];
    try {
      faces = ShapeUtils.triangulateShape(contour, holes);
    } catch {
      continue;
    }
    for (const [i, j, k] of faces) {
      const p = all[i];
      let q = all[j];
      let r = all[k];
      if (!p || !q || !r) continue;
      // Techo hacia arriba: triángulo antihorario en ENU.
      if ((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x) < 0) [q, r] = [r, q];
      tri.push(p.x, h1, -p.y, q.x, h1, -q.y, r.x, h1, -r.y);
    }
  }
  return { positions: new Float32Array(tri), edges: new Float32Array(edges) };
}

/** Segmentos de calle → posiciones three.js para lineSegments, a la altura `y`. */
export function roadPositions(segments: readonly number[], y: number): Float32Array {
  const out = new Float32Array((segments.length / 4) * 6);
  for (let i = 0, k = 0; i + 3 < segments.length; i += 4) {
    out[k++] = segments[i];
    out[k++] = y;
    out[k++] = -segments[i + 1];
    out[k++] = segments[i + 2];
    out[k++] = y;
    out[k++] = -segments[i + 3];
  }
  return out;
}

/** Trazado SVG (planta, y hacia abajo = Sur) de un edificio con sus agujeros. */
export function buildingPath(b: EnvBuilding): string {
  const ring = (pts: readonly XY[]) =>
    pts.map((p, i) => `${i ? "L" : "M"}${Math.round(p.x * 10) / 10} ${Math.round(-p.y * 10) / 10}`).join("") + "Z";
  return [b.outer, ...b.holes].map(ring).join("");
}
