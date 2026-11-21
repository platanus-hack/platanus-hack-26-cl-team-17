"use client";
/**
 * Descarga y decodifica (en el navegador) las teselas vectoriales de OpenFreeMap que
 * cubren el entorno del incidente. Caché en memoria por tesela; si falla la red, el
 * visor sigue igual, sin entorno.
 */
import { useEffect, useMemo, useState } from "react";
import { VectorTile, classifyRings } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import type { LatLng } from "@/lib/geo";
import {
  EMPTY_SURROUNDINGS,
  buildingHeights,
  clipRingToTile,
  excludeInferred,
  tilesCovering,
  tilesToSurroundings,
  type Surroundings,
  type TileBuilding,
  type TileContent,
  type TileId,
} from "./surroundings";
import type { XY } from "./geometry";
import { footprintOf, type NStructure } from "./model";

const TILEJSON_URL = "https://tiles.openfreemap.org/planet";
/** Clases de la capa "transportation" que se dibujan (sin senderos, rieles ni ferris). */
const ROAD_CLASSES = new Set(["motorway", "trunk", "primary", "secondary", "tertiary", "minor", "service", "busway"]);

let templatePromise: Promise<string> | null = null;
const tileCache = new Map<string, Promise<TileContent>>();

function tileTemplate(): Promise<string> {
  templatePromise ??= fetch(TILEJSON_URL)
    .then((r) => {
      if (!r.ok) throw new Error(`TileJSON ${r.status}`);
      return r.json() as Promise<{ tiles?: unknown }>;
    })
    .then((j) => {
      const t = Array.isArray(j.tiles) ? j.tiles[0] : null;
      if (typeof t !== "string") throw new Error("TileJSON sin teselas");
      return t;
    })
    .catch((e: unknown) => {
      templatePromise = null;
      throw e;
    });
  return templatePromise;
}

/** Decodifica una tesela MVT: edificios (recortados a la tesela) y calles. */
export function decodeTile(tile: TileId, buf: Uint8Array): TileContent {
  const vt = new VectorTile(new PbfReader(buf));
  const buildings: TileBuilding[] = [];
  let extent = 4096;
  const bl = vt.layers.building;
  if (bl) {
    extent = bl.extent;
    for (let i = 0; i < bl.length; i++) {
      const f = bl.feature(i);
      if (f.type !== 3) continue;
      const { height, minHeight } = buildingHeights(f.properties.render_height, f.properties.render_min_height);
      // Un rasgo puede traer muchos edificios (multipolígono agrupado por altura).
      for (const poly of classifyRings(f.loadGeometry())) {
        const rings = poly.map((r) => clipRingToTile(r, extent));
        if (!rings[0]) continue;
        buildings.push({ rings: rings.filter((r) => r !== null), height, minHeight });
      }
    }
  }
  const roads: XY[][] = [];
  const tl = vt.layers.transportation;
  if (tl) {
    const scale = extent / tl.extent;
    for (let i = 0; i < tl.length; i++) {
      const f = tl.feature(i);
      if (f.type !== 2 || !ROAD_CLASSES.has(String(f.properties.class))) continue;
      for (const line of f.loadGeometry()) roads.push(line.map((p) => ({ x: p.x * scale, y: p.y * scale })));
    }
  }
  return { tile, extent, buildings, roads };
}

function loadTile(tile: TileId): Promise<TileContent> {
  const key = `${tile.z}/${tile.x}/${tile.y}`;
  let p = tileCache.get(key);
  if (!p) {
    p = tileTemplate()
      .then((tpl) => fetch(tpl.replace("{z}", String(tile.z)).replace("{x}", String(tile.x)).replace("{y}", String(tile.y))))
      .then((r) => {
        if (!r.ok) throw new Error(`Tesela ${key}: ${r.status}`);
        return r.arrayBuffer();
      })
      .then((ab) => decodeTile(tile, new Uint8Array(ab)));
    // Un fallo no queda en caché: se reintenta en el próximo montaje.
    p.catch(() => tileCache.delete(key));
    tileCache.set(key, p);
  }
  return p;
}

export type SurroundingsStatus = "off" | "loading" | "ready" | "error";

export interface SurroundingsState {
  status: SurroundingsStatus;
  data: Surroundings;
}

function validOrigin(o: LatLng | null): o is LatLng {
  return !!o && Number.isFinite(o.lat) && Number.isFinite(o.lng) && Math.abs(o.lat) <= 85 && !(o.lat === 0 && o.lng === 0);
}

/** Entorno OSM (edificios y calles en ENU) alrededor de `origin`; `enabled` = capa encendida. */
export function useSurroundings(origin: LatLng | null, enabled: boolean): SurroundingsState {
  const lat = origin?.lat ?? NaN;
  const lng = origin?.lng ?? NaN;
  const key = `${lat},${lng}`;
  const [result, setResult] = useState<{ key: string; status: "ready" | "error"; data: Surroundings } | null>(null);
  const ok = enabled && validOrigin({ lat, lng });

  useEffect(() => {
    if (!ok || result?.key === key) return;
    let alive = true;
    const o = { lat, lng };
    Promise.all(tilesCovering(o).map(loadTile))
      .then((tiles) => {
        if (alive) setResult({ key, status: "ready", data: tilesToSurroundings(o, tiles) });
      })
      .catch(() => {
        if (alive) setResult({ key, status: "error", data: EMPTY_SURROUNDINGS });
      });
    return () => {
      alive = false;
    };
  }, [ok, key, lat, lng, result?.key]);

  return useMemo<SurroundingsState>(() => {
    if (!ok) return { status: "off", data: EMPTY_SURROUNDINGS };
    if (!result || result.key !== key) return { status: "loading", data: EMPTY_SURROUNDINGS };
    return { status: result.status, data: result.data };
  }, [ok, result, key]);
}

/** Entorno listo para dibujar: sin los edificios OSM que ya representa la escena inferida. */
export function useSceneSurroundings(origin: LatLng | null, structures: readonly NStructure[] | undefined, enabled: boolean): SurroundingsState {
  const raw = useSurroundings(origin, enabled);
  return useMemo<SurroundingsState>(() => {
    if (raw.status !== "ready" || !structures) return raw;
    const buildings = excludeInferred(raw.data.buildings, structures.map(footprintOf));
    return { status: raw.status, data: { buildings, roadSegments: raw.data.roadSegments } };
  }, [raw, structures]);
}
