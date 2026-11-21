/**
 * Teselas vectoriales de OpenFreeMap (esquema OpenMapTiles) → entorno OSM en ENU.
 * Funciones puras e isomórficas (sin red): matemática de teselas, decodificación MVT y
 * conversión a coordenadas locales. La descarga está en ./index.ts.
 */
import { VectorTile, classifyRings } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import { toLocal, type LatLng } from "@/lib/geo";
import type { OsmBuilding, OsmContext, OsmRoad, OsmXY } from "./types";

export const OSM_ZOOM = 14;
const DEFAULT_HEIGHT = 6;
/** Distancia máxima (m) entre un tramo y su línea de nombre para heredar el nombre. */
const NAME_MATCH_M = 3;
/** Clases de "transportation" que no son vías (se descartan). */
const NON_ROAD_CLASSES = new Set(["rail", "transit", "ferry", "aerialway", "bus_guideway"]);

export interface TileId {
  z: number;
  x: number;
  y: number;
}

interface RawBuilding {
  id: string;
  rings: OsmXY[][];
  height: number;
  minHeight: number;
}
interface RawLine {
  id: string;
  cls: string;
  name: string | null;
  points: OsmXY[];
}

/** Tesela decodificada en coordenadas de tesela (0…extent, y hacia abajo). */
export interface RawTile {
  tile: TileId;
  extent: number;
  buildings: RawBuilding[];
  roads: RawLine[];
  names: RawLine[];
}

/* ───────────────────────────── Matemática de teselas ───────────────────────────── */

const RAD = Math.PI / 180;
const EARTH_R = 6_371_000;

function lngToTileX(lng: number, z: number): number {
  return ((lng + 180) / 360) * 2 ** z;
}
function latToTileY(lat: number, z: number): number {
  const s = Math.sin(lat * RAD);
  return ((1 - Math.log((1 + s) / (1 - s)) / (2 * Math.PI)) / 2) * 2 ** z;
}

/** Teselas que cubren el cuadrado de lado 2·radio centrado en `origin`. */
export function tilesCovering(origin: LatLng, radiusM: number, z = OSM_ZOOM): TileId[] {
  const dLat = radiusM / EARTH_R / RAD;
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

/** Punto de tesela → lat/lng (Web Mercator). */
export function tilePointToLatLng(tile: TileId, extent: number, px: number, py: number): LatLng {
  const n = 2 ** tile.z;
  const lng = ((tile.x + px / extent) / n) * 360 - 180;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (tile.y + py / extent)) / n))) / RAD;
  return { lat, lng };
}

/* ───────────────────────────── Decodificación ───────────────────────────── */

function heights(h: unknown, mh: unknown): { height: number; minHeight: number } {
  const hv = typeof h === "number" && Number.isFinite(h) && h > 0 ? h : DEFAULT_HEIGHT;
  const height = Math.min(300, Math.max(2.5, hv));
  const m = typeof mh === "number" && Number.isFinite(mh) && mh > 0 ? mh : 0;
  return { height, minHeight: m < height - 1 ? m : 0 };
}

function openRing(r: readonly OsmXY[]): OsmXY[] {
  const pts = r.map((p) => ({ x: p.x, y: p.y }));
  const a = pts[0];
  const b = pts[pts.length - 1];
  if (pts.length > 1 && a.x === b.x && a.y === b.y) pts.pop();
  return pts;
}

function ringCenter(r: readonly OsmXY[]): OsmXY {
  return { x: r.reduce((s, p) => s + p.x, 0) / r.length, y: r.reduce((s, p) => s + p.y, 0) / r.length };
}

/**
 * Decodifica una tesela MVT. Las teselas traen un margen repetido con la vecina: un
 * edificio se queda en la tesela que contiene su centro y un tramo de calle en la que
 * contiene su punto medio (así nada se duplica y los edificios del borde quedan enteros).
 */
export function decodeTile(tile: TileId, buf: Uint8Array): RawTile {
  const vt = new VectorTile(new PbfReader(buf));
  const out: RawTile = { tile, extent: 4096, buildings: [], roads: [], names: [] };
  const inTile = (p: OsmXY, extent: number) => p.x >= 0 && p.x < extent && p.y >= 0 && p.y < extent;

  const bl = vt.layers.building;
  if (bl) {
    out.extent = bl.extent;
    for (let i = 0; i < bl.length; i++) {
      const f = bl.feature(i);
      if (f.type !== 3) continue;
      const { height, minHeight } = heights(f.properties.render_height, f.properties.render_min_height);
      // Un rasgo puede agrupar varios edificios (multipolígono).
      classifyRings(f.loadGeometry()).forEach((poly, k) => {
        const rings = poly.map(openRing).filter((r) => r.length >= 3);
        if (!rings[0] || !inTile(ringCenter(rings[0]), bl.extent)) return;
        out.buildings.push({ id: `${f.id ?? `t${tile.x}.${tile.y}.${i}`}:${k}`, rings, height, minHeight });
      });
    }
  }

  const readLines = (layerName: string, target: RawLine[], withName: boolean) => {
    const l = vt.layers[layerName];
    if (!l) return;
    const scale = out.extent / l.extent;
    for (let i = 0; i < l.length; i++) {
      const f = l.feature(i);
      if (f.type !== 2) continue;
      const cls = String(f.properties.class ?? "");
      if (NON_ROAD_CLASSES.has(cls)) continue;
      const rawName = withName ? f.properties.name : null;
      const name = typeof rawName === "string" && rawName.trim() ? rawName.trim() : null;
      f.loadGeometry().forEach((line, k) => {
        // Tramos contiguos cuyo punto medio cae dentro de la tesela.
        let run: OsmXY[] = [];
        let part = 0;
        const flush = () => {
          if (run.length >= 2) target.push({ id: `${f.id ?? `t${tile.x}.${tile.y}.${i}`}:${k}.${part++}`, cls, name, points: run });
          run = [];
        };
        for (let j = 0; j + 1 < line.length; j++) {
          const a = { x: line[j].x * scale, y: line[j].y * scale };
          const b = { x: line[j + 1].x * scale, y: line[j + 1].y * scale };
          if (!inTile({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, out.extent)) {
            flush();
            continue;
          }
          if (run.length === 0) run.push(a);
          run.push(b);
        }
        flush();
      });
    }
  };
  readLines("transportation", out.roads, false);
  // Los nombres vienen en otra capa (líneas fusionadas); se cruzan por cercanía en ENU.
  readLines("transportation_name", out.names, true);
  return out;
}

/* ───────────────────────────── A coordenadas locales ───────────────────────────── */

function distPointSegment(p: OsmXY, a: OsmXY, b: OsmXY): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function distToLine(p: OsmXY, pts: readonly OsmXY[]): number {
  let d = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) d = Math.min(d, distPointSegment(p, pts[i], pts[i + 1]));
  return d;
}

/** Teselas decodificadas → edificios y vías en ENU dentro de `radiusM` del origen. */
export function tilesToContext(origin: LatLng, tiles: readonly RawTile[], radiusM: number): OsmContext {
  const buildings: OsmBuilding[] = [];
  const roads: OsmRoad[] = [];
  const names: RawLine[] = [];
  for (const t of tiles) {
    const conv = (p: OsmXY) => toLocal(origin, tilePointToLatLng(t.tile, t.extent, p.x, p.y));
    for (const b of t.buildings) {
      const rings = b.rings.map((r) => r.map(conv));
      const c = ringCenter(rings[0]);
      if (Math.hypot(c.x, c.y) > radiusM) continue;
      buildings.push({ id: b.id, rings, height: b.height, minHeight: b.minHeight });
    }
    const near = (pts: OsmXY[]) => pts.some((p) => Math.hypot(p.x, p.y) <= radiusM);
    for (const r of t.roads) {
      const points = r.points.map(conv);
      if (near(points)) roads.push({ id: r.id, cls: r.cls, name: null, points });
    }
    for (const n of t.names) {
      const points = n.points.map(conv);
      if (near(points)) names.push({ ...n, points });
    }
  }
  // Nombre: la línea de nombre de la misma clase que pasa por el medio del tramo.
  for (const r of roads) {
    const mid = r.points[Math.floor(r.points.length / 2)];
    const prev = r.points[Math.floor(r.points.length / 2) - 1] ?? r.points[1];
    const probe = { x: (mid.x + prev.x) / 2, y: (mid.y + prev.y) / 2 };
    let best: { name: string; d: number } | null = null;
    for (const n of names) {
      if (!n.name || n.cls !== r.cls) continue;
      const d = distToLine(probe, n.points);
      if (d <= NAME_MATCH_M && (!best || d < best.d)) best = { name: n.name, d };
    }
    r.name = best?.name ?? null;
  }
  return { buildings, roads };
}
