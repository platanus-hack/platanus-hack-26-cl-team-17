/**
 * Entorno real de OpenStreetMap (edificios y ejes de calles) alrededor de un punto,
 * desde las teselas vectoriales de OpenFreeMap. Isomórfico: Node (servidor) y navegador.
 *
 * Caché en memoria por tesela; si la red falla o tarda más que `timeoutMs`, devuelve
 * null (nunca lanza).
 */
import type { IncidentType, Media, SceneModel } from "@/lib/domain";
import { isValidLatLng, type LatLng } from "@/lib/geo";
import { anchorModeFor, anchorScene, type AnchorAdjustment, type FixedCamera } from "./anchor";
import { decodeTile, tilesCovering, tilesToContext, type RawTile, type TileId } from "./tiles";
import type { OsmContext } from "./types";

export type { OsmBuilding, OsmContext, OsmRoad, OsmXY } from "./types";
export { ANCHOR_NOTE_PREFIX, ANCHOR_WARNING_PREFIX, type AnchorAdjustment, type FixedCamera } from "./anchor";

const TILEJSON_URL = "https://tiles.openfreemap.org/planet";
/** Tiempo máximo de cada descarga (aunque quien la pidió ya no espere). */
const REQUEST_TIMEOUT_MS = 8_000;
const DEFAULT_TIMEOUT_MS = 4_000;
const MAX_CACHED_TILES = 48;

let templatePromise: Promise<string> | null = null;
const tileCache = new Map<string, Promise<RawTile>>();

function tileTemplate(): Promise<string> {
  templatePromise ??= fetch(TILEJSON_URL, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
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

function loadTile(tile: TileId): Promise<RawTile> {
  const key = `${tile.z}/${tile.x}/${tile.y}`;
  const hit = tileCache.get(key);
  if (hit) return hit;
  const p = tileTemplate()
    .then((tpl) =>
      fetch(tpl.replace("{z}", String(tile.z)).replace("{x}", String(tile.x)).replace("{y}", String(tile.y)), {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }),
    )
    .then((r) => {
      if (!r.ok) throw new Error(`Tesela ${key}: ${r.status}`);
      return r.arrayBuffer();
    })
    .then((ab) => decodeTile(tile, new Uint8Array(ab)));
  // Un fallo no queda en caché: se reintenta en la próxima llamada.
  p.catch(() => tileCache.delete(key));
  tileCache.set(key, p);
  while (tileCache.size > MAX_CACHED_TILES) {
    const oldest = tileCache.keys().next().value;
    if (oldest === undefined) break;
    tileCache.delete(oldest);
  }
  return p;
}

/**
 * Edificios y calles de OSM en ENU (m) respecto de `origin`, dentro de `radiusM`.
 * null si no hay datos (sin red, tiempo agotado, abortado u origen inválido).
 */
export async function fetchOsmContext(
  origin: LatLng,
  radiusM = 350,
  opts?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<OsmContext | null> {
  if (!isValidLatLng(origin?.lat, origin?.lng) || Math.abs(origin.lat) > 85) return null;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const stop = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
      if (opts?.signal) {
        if (opts.signal.aborted) resolve(null);
        onAbort = () => resolve(null);
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }
    });
    const work = Promise.all(tilesCovering(origin, radiusM).map(loadTile)).then((tiles) =>
      tilesToContext(origin, tiles, radiusM),
    );
    work.catch(() => undefined);
    return await Promise.race([work, stop]);
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) opts?.signal?.removeEventListener("abort", onAbort);
  }
}

type GpsMedia = Pick<Media, "label" | "source" | "lat" | "lng" | "accuracy_m"> & { frames?: Media["frames"] };

/**
 * Cámaras de la escena ubicadas por GPS (las que sanitizeScene fijó con confianza alta a
 * partir de un medio con GPS): el anclaje no las mueve y no puede contradecirlas.
 */
export function gpsCameras(scene: SceneModel, media: readonly GpsMedia[]): FixedCamera[] {
  const out: FixedCamera[] = [];
  for (const m of media ?? []) {
    if (!m || typeof m.label !== "string") continue;
    const hasGps =
      isValidLatLng(m.lat, m.lng) || (Array.isArray(m.frames) && m.frames.some((f) => f && isValidLatLng(f.lat, f.lng)));
    if (!hasGps) continue;
    const cam = scene.cameras.find((c) => c.media_ref.trim().toUpperCase() === m.label.trim().toUpperCase());
    if (!cam || cam.confidence !== "high") continue;
    const acc = typeof m.accuracy_m === "number" && Number.isFinite(m.accuracy_m) && m.accuracy_m >= 0 ? m.accuracy_m : m.source === "drone" ? 5 : 15;
    out.push({ media_ref: cam.media_ref, tolerance_m: Math.min(80, acc + 10) });
  }
  return out;
}

/**
 * Descarga el entorno OSM y ancla la escena (ver ./anchor). Nunca lanza ni espera más de
 * `timeoutMs`: sin red, sin datos o ante cualquier error devuelve la escena tal cual.
 * `media` (con GPS) fija sus cámaras; `previous` es la escena guardada antes de la fusión.
 */
export async function anchorSceneToOsm(
  scene: SceneModel,
  incident: { lat: number; lng: number; type: IncidentType },
  opts?: {
    timeoutMs?: number;
    signal?: AbortSignal;
    media?: readonly GpsMedia[];
    fixedCameras?: readonly FixedCamera[];
    previous?: SceneModel | null;
  },
): Promise<{ scene: SceneModel; adjustment: AnchorAdjustment | null; warning?: string | null }> {
  try {
    if (!scene || !anchorModeFor(incident.type, scene)) return { scene, adjustment: null };
    const ctx = await fetchOsmContext({ lat: incident.lat, lng: incident.lng }, 350, opts);
    const fixedCameras = opts?.fixedCameras ?? (opts?.media ? gpsCameras(scene, opts.media) : []);
    return anchorScene(scene, incident.type, ctx, { fixedCameras, previous: opts?.previous ?? null });
  } catch (err) {
    console.error("[osm] no se pudo anclar la escena", err);
    return { scene, adjustment: null };
  }
}

/** Tipos de incidente que pueden anclarse (el resto no necesita el mapa). */
const ANCHORABLE: ReadonlySet<IncidentType> = new Set(["vehicle_collision", "vehicle_fire", "structure_fire", "unknown"]);

/**
 * Empieza a descargar (y deja en caché) el entorno de un incidente, sin esperar el
 * resultado: así el anclaje posterior no suma latencia. Nunca lanza.
 */
export function prefetchOsmContext(incident: { lat: number; lng: number; type?: IncidentType }, timeoutMs = 25_000): void {
  if (incident.type && !ANCHORABLE.has(incident.type)) return;
  void fetchOsmContext({ lat: incident.lat, lng: incident.lng }, 350, { timeoutMs }).catch(() => undefined);
}
