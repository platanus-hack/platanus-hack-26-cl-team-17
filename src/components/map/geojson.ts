/**
 * Geometrías GeoJSON puras para los mapas (sin maplibre ni DOM): se prueban con node:test.
 *
 * - Posiciones GeoJSON en [lng, lat].
 * - Anillos de polígono cerrados y en sentido antihorario (RFC 7946).
 * - La escena de la IA viene en metros locales (x Este, y Norte) respecto del incidente;
 *   los valores absurdos (NaN, a más de 5 km, dimensiones negativas) se descartan o acotan
 *   para que un error de la IA no rompa el mapa.
 */
import type { Feature, FeatureCollection, Geometry, LineString, Point, Polygon, Position } from "geojson";
import type { DroneMission, MediaFrame, PersonStatus, SceneModel } from "@/lib/domain";
import type { MediaView } from "@/lib/contract";
import {
  destination,
  distanceM,
  headingVector,
  isValidLatLng,
  normalizeDeg,
  toLatLng,
  type LatLng,
  type LocalXY,
} from "@/lib/geo";

/** [[oeste, sur], [este, norte]] */
export type Bounds = [[number, number], [number, number]];

/** Coordenadas locales más lejanas que esto se consideran un error de la escena. */
export const MAX_LOCAL_M = 5000;
export const RANGE_RINGS_M = [50, 100, 200] as const;
/** Campo de visión horizontal típico de la cámara principal de un teléfono. */
export const CAMERA_FOV_DEG = 60;

export const toPosition = (p: LatLng): Position => [p.lng, p.lat];

export function featureCollection<G extends Geometry, P>(
  features: Feature<G, P>[],
): FeatureCollection<G, P> {
  return { type: "FeatureCollection", features };
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function clamp(v: unknown, min: number, max: number, fallback: number): number {
  if (!isNum(v) || v <= 0) return fallback;
  return Math.min(max, Math.max(min, v));
}

/** Rumbo válido normalizado a [0, 360) o null (la IA usa -1 para "desconocido"). */
export function validHeading(v: unknown): number | null {
  if (!isNum(v) || v < 0) return null;
  return normalizeDeg(v);
}

export function isLocalOk(x: unknown, y: unknown): boolean {
  return isNum(x) && isNum(y) && Math.abs(x) <= MAX_LOCAL_M && Math.abs(y) <= MAX_LOCAL_M;
}

function closeRing(points: Position[]): Position[] {
  return points.length ? [...points, [points[0][0], points[0][1]]] : points;
}

/* ───────────────────────────── Primitivas ───────────────────────────── */

/** Anillo cerrado (antihorario) de un círculo de `radiusM` metros. */
export function circleRing(center: LatLng, radiusM: number, steps = 64): Position[] {
  const n = Math.max(8, Math.round(steps));
  const pts: Position[] = [];
  for (let i = 0; i < n; i++) {
    // Rumbo decreciente = antihorario visto desde arriba.
    pts.push(toPosition(destination(center, 360 - (360 * i) / n, radiusM)));
  }
  return closeRing(pts);
}

export function circlePolygon<P>(
  center: LatLng,
  radiusM: number,
  properties: P,
  steps = 64,
): Feature<Polygon, P> {
  return { type: "Feature", properties, geometry: { type: "Polygon", coordinates: [circleRing(center, radiusM, steps)] } };
}

/**
 * Cono de visión de una cámara: vértice en la cámara, arco a `rangeM` metros
 * entre heading ± fov/2. Anillo antihorario: vértice → borde derecho → borde izquierdo → vértice.
 */
export function cameraConeRing(
  apex: LatLng,
  headingDeg: number,
  rangeM: number,
  fovDeg = CAMERA_FOV_DEG,
  steps = 12,
): Position[] {
  const half = Math.min(170, Math.max(5, fovDeg)) / 2;
  const n = Math.max(2, Math.round(steps));
  const pts: Position[] = [toPosition(apex)];
  for (let i = 0; i <= n; i++) {
    const bearing = headingDeg + half - (2 * half * i) / n;
    pts.push(toPosition(destination(apex, bearing, rangeM)));
  }
  return closeRing(pts);
}

/**
 * Rectángulo orientado en metros locales. `alongM` corre en la dirección `headingDeg`
 * (hacia donde "mira" el objeto) y `acrossM` perpendicular a ella.
 * Orden: frente-derecha, frente-izquierda, atrás-izquierda, atrás-derecha (antihorario).
 */
export function orientedRectLocal(
  center: LocalXY,
  alongM: number,
  acrossM: number,
  headingDeg: number,
): LocalXY[] {
  const f = headingVector(headingDeg);
  const r = headingVector(headingDeg + 90);
  const a = alongM / 2;
  const c = acrossM / 2;
  return [
    { x: center.x + f.x * a + r.x * c, y: center.y + f.y * a + r.y * c },
    { x: center.x + f.x * a - r.x * c, y: center.y + f.y * a - r.y * c },
    { x: center.x - f.x * a - r.x * c, y: center.y - f.y * a - r.y * c },
    { x: center.x - f.x * a + r.x * c, y: center.y - f.y * a + r.y * c },
  ];
}

export function orientedRectRing(
  origin: LatLng,
  center: LocalXY,
  alongM: number,
  acrossM: number,
  headingDeg: number,
): Position[] {
  return closeRing(
    orientedRectLocal(center, alongM, acrossM, headingDeg).map((p) => toPosition(toLatLng(origin, p))),
  );
}

/** Línea a partir de puntos lat/lng: descarta inválidos y repetidos consecutivos; null si quedan < 2. */
export function lineFromPoints(points: readonly LatLng[], closed = false): Position[] | null {
  const out: Position[] = [];
  for (const p of points) {
    if (!isValidLatLng(p.lat, p.lng)) continue;
    const last = out[out.length - 1];
    if (last && last[0] === p.lng && last[1] === p.lat) continue;
    out.push([p.lng, p.lat]);
  }
  if (out.length < 2) return null;
  if (closed && out.length > 2) out.push([out[0][0], out[0][1]]);
  return out;
}

/** Envolvente de puntos válidos; null si no hay ninguno. */
export function boundsOf(points: readonly LatLng[]): Bounds | null {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const p of points) {
    if (!isValidLatLng(p.lat, p.lng)) continue;
    w = Math.min(w, p.lng);
    e = Math.max(e, p.lng);
    s = Math.min(s, p.lat);
    n = Math.max(n, p.lat);
  }
  if (!Number.isFinite(w)) return null;
  return [
    [w, s],
    [e, n],
  ];
}

/** Los cuatro puntos cardinales a `radiusM` del centro (para incluir un radio en un encuadre). */
export function radiusPoints(center: LatLng, radiusM: number): LatLng[] {
  return [0, 90, 180, 270].map((b) => destination(center, b, radiusM));
}

/* ─────────────────────────────── Anillos ─────────────────────────────── */

export interface RingProps {
  radius_m: number;
}

export function rangeRings(
  center: LatLng,
  radii: readonly number[] = RANGE_RINGS_M,
): FeatureCollection<LineString, RingProps> {
  return featureCollection(
    radii.map((r) => ({
      type: "Feature" as const,
      properties: { radius_m: r },
      geometry: { type: "LineString" as const, coordinates: circleRing(center, r, 72) },
    })),
  );
}

/* ─────────────────────────────── Escena ─────────────────────────────── */

const AT_RISK: readonly PersonStatus[] = ["trapped", "at_window_or_balcony", "on_roof"];

export function isPersonAtRisk(status: PersonStatus): boolean {
  return AT_RISK.includes(status);
}

/** La escena tiene personas atrapadas, en ventana/balcón o en el techo. */
export function sceneHasPeopleAtRisk(scene: SceneModel | null | undefined): boolean {
  return !!scene?.people.some((p) => isPersonAtRisk(p.status));
}

type Structure = SceneModel["structures"][number];
type Road = SceneModel["roads"][number];
type Vehicle = SceneModel["vehicles"][number];

export interface StructureProps {
  id: string;
  label: string;
  role: Structure["role"];
  low_confidence: boolean;
}

/** Planta de una estructura: `width_m` = fachada principal (perpendicular a rotation_deg), `depth_m` = fondo. */
export function structureFootprint(origin: LatLng, s: Structure): Feature<Polygon, StructureProps> | null {
  if (!isLocalOk(s.x, s.y)) return null;
  const width = clamp(s.width_m, 2, 500, 10);
  const depth = clamp(s.depth_m, 2, 500, 10);
  const heading = validHeading(s.rotation_deg) ?? 0;
  return {
    type: "Feature",
    properties: { id: s.id, label: s.label, role: s.role, low_confidence: s.confidence === "low" },
    geometry: {
      type: "Polygon",
      coordinates: [orientedRectRing(origin, { x: s.x, y: s.y }, depth, width, heading)],
    },
  };
}

/** Borde de la fachada principal (lado hacia donde mira rotation_deg). */
export function structureFacade(origin: LatLng, s: Structure): Feature<LineString, { id: string }> | null {
  if (!isLocalOk(s.x, s.y)) return null;
  const width = clamp(s.width_m, 2, 500, 10);
  const depth = clamp(s.depth_m, 2, 500, 10);
  const heading = validHeading(s.rotation_deg) ?? 0;
  const [frontRight, frontLeft] = orientedRectLocal({ x: s.x, y: s.y }, depth, width, heading);
  return {
    type: "Feature",
    properties: { id: s.id },
    geometry: {
      type: "LineString",
      coordinates: [toPosition(toLatLng(origin, frontLeft)), toPosition(toLatLng(origin, frontRight))],
    },
  };
}

export interface RoadProps {
  id: string;
  name: string;
  blocked: boolean;
}

export function roadPolygon(origin: LatLng, r: Road): Feature<Polygon, RoadProps> | null {
  if (!isLocalOk(r.x1, r.y1) || !isLocalOk(r.x2, r.y2)) return null;
  const dx = r.x2 - r.x1;
  const dy = r.y2 - r.y1;
  const length = Math.hypot(dx, dy);
  if (length < 1) return null;
  const heading = normalizeDeg((Math.atan2(dx, dy) * 180) / Math.PI);
  const center = { x: (r.x1 + r.x2) / 2, y: (r.y1 + r.y2) / 2 };
  return {
    type: "Feature",
    properties: { id: r.id, name: r.name, blocked: r.blocked },
    geometry: {
      type: "Polygon",
      coordinates: [orientedRectRing(origin, center, length, clamp(r.width_m, 2, 80, 7), heading)],
    },
  };
}

export type VehicleTone = "critical" | "accent" | "neutral";

export function vehicleTone(v: Pick<Vehicle, "entrapment_suspected" | "burning" | "state">): VehicleTone {
  if (v.entrapment_suspected) return "critical";
  if (v.burning || v.state === "burning") return "accent";
  return "neutral";
}

export interface VehicleProps {
  id: string;
  tone: VehicleTone;
}

/** Huella del vehículo: largo en la dirección rotation_deg (frente), ancho perpendicular. */
export function vehicleFootprint(origin: LatLng, v: Vehicle): Feature<Polygon, VehicleProps> | null {
  if (!isLocalOk(v.x, v.y)) return null;
  return {
    type: "Feature",
    properties: { id: v.id, tone: vehicleTone(v) },
    geometry: {
      type: "Polygon",
      coordinates: [
        orientedRectRing(
          origin,
          { x: v.x, y: v.y },
          clamp(v.length_m, 1, 30, 4.5),
          clamp(v.width_m, 0.5, 5, 1.8),
          validHeading(v.rotation_deg) ?? 0,
        ),
      ],
    },
  };
}

export interface FireProps {
  id: string;
  intensity: SceneModel["fire_zones"][number]["intensity"];
}

export interface HazardProps {
  id: string;
  severity: SceneModel["hazards"][number]["severity"];
}

export interface SceneOverlays {
  roads: FeatureCollection<Polygon, RoadProps>;
  structures: FeatureCollection<Polygon, StructureProps>;
  facades: FeatureCollection<LineString, { id: string }>;
  vehicles: FeatureCollection<Polygon, VehicleProps>;
  fires: FeatureCollection<Polygon, FireProps>;
  hazards: FeatureCollection<Polygon, HazardProps>;
}

const notNull = <T>(v: T | null): v is T => v !== null;

/** Convierte la escena local de la IA en colecciones GeoJSON listas para las fuentes del mapa. */
export function sceneOverlays(origin: LatLng, scene: SceneModel | null | undefined): SceneOverlays {
  if (!scene || !isValidLatLng(origin.lat, origin.lng)) {
    return {
      roads: featureCollection([]),
      structures: featureCollection([]),
      facades: featureCollection([]),
      vehicles: featureCollection([]),
      fires: featureCollection([]),
      hazards: featureCollection([]),
    };
  }
  const local = (x: number, y: number) => toLatLng(origin, { x, y });
  return {
    roads: featureCollection(scene.roads.map((r) => roadPolygon(origin, r)).filter(notNull)),
    structures: featureCollection(scene.structures.map((s) => structureFootprint(origin, s)).filter(notNull)),
    facades: featureCollection(scene.structures.map((s) => structureFacade(origin, s)).filter(notNull)),
    vehicles: featureCollection(scene.vehicles.map((v) => vehicleFootprint(origin, v)).filter(notNull)),
    fires: featureCollection(
      scene.fire_zones
        .filter((f) => isLocalOk(f.x, f.y))
        .map((f) => circlePolygon(local(f.x, f.y), clamp(f.radius_m, 1, 500, 4), { id: f.id, intensity: f.intensity }, 40)),
    ),
    hazards: featureCollection(
      scene.hazards
        .filter((h) => isLocalOk(h.x, h.y))
        .map((h) => circlePolygon(local(h.x, h.y), clamp(h.radius_m, 2, 2000, 10), { id: h.id, severity: h.severity }, 48)),
    ),
  };
}

/* ─────────────────────────────── Cámaras ─────────────────────────────── */

export type CameraMediaInput = Pick<MediaView, "id" | "label" | "source" | "kind" | "lat" | "lng" | "heading_deg"> & {
  frames: readonly Pick<MediaFrame, "lat" | "lng" | "heading_deg">[];
};

export interface CameraPlacement {
  mediaId: string;
  label: string;
  source: MediaView["source"];
  kind: MediaView["kind"];
  position: LatLng;
  /** Rumbo de la cámara o null si se desconoce (sin cono). */
  heading: number | null;
  /** La posición la estimó la IA (el medio no traía GPS). */
  estimatedPosition: boolean;
  /** El rumbo lo estimó la IA (el teléfono no entregó brújula). */
  estimatedHeading: boolean;
  /** Distancia al incidente, en metros. */
  distanceM: number;
}

const labelNumber = (label: string): number => {
  const m = /\d+/.exec(label);
  return m ? Number(m[0]) : Number.MAX_SAFE_INTEGER;
};

/**
 * Dónde dibujar la cámara de cada medio. Prioridad: GPS del medio → último cuadro
 * con posición (dron) → posición estimada por la IA en la escena. Sin ninguna, no se dibuja.
 */
export function cameraPlacements(
  origin: LatLng,
  media: readonly CameraMediaInput[],
  scene: SceneModel | null | undefined,
): CameraPlacement[] {
  const sceneCams = new Map((scene?.cameras ?? []).map((c) => [c.media_ref, c]));
  const out: CameraPlacement[] = [];
  for (const m of media) {
    const sc = sceneCams.get(m.label);
    let position: LatLng | null = null;
    let heading: number | null = null;
    let estimatedPosition = false;
    if (isValidLatLng(m.lat, m.lng)) {
      position = { lat: m.lat as number, lng: m.lng as number };
      heading = validHeading(m.heading_deg);
    } else {
      const frame = [...m.frames].reverse().find((f) => isValidLatLng(f.lat, f.lng));
      if (frame) {
        position = { lat: frame.lat as number, lng: frame.lng as number };
        heading = validHeading(frame.heading_deg);
      } else if (sc && isLocalOk(sc.x, sc.y) && isValidLatLng(origin.lat, origin.lng)) {
        position = toLatLng(origin, { x: sc.x, y: sc.y });
        estimatedPosition = true;
      }
    }
    if (!position) continue;
    let estimatedHeading = false;
    if (heading === null && sc) {
      heading = validHeading(sc.facing_deg);
      estimatedHeading = heading !== null;
    }
    out.push({
      mediaId: m.id,
      label: m.label,
      source: m.source,
      kind: m.kind,
      position,
      heading,
      estimatedPosition,
      estimatedHeading,
      distanceM: isValidLatLng(origin.lat, origin.lng) ? distanceM(origin, position) : 0,
    });
  }
  return out.sort((a, b) => labelNumber(a.label) - labelNumber(b.label) || a.label.localeCompare(b.label));
}

/** Alcance del cono: un poco más allá del incidente, acotado para que se lea en el mapa. */
export function coneRangeM(distanceToIncidentM: number): number {
  if (!isNum(distanceToIncidentM) || distanceToIncidentM < 5) return 60;
  return Math.min(250, Math.max(40, distanceToIncidentM * 1.2));
}

export interface ConeProps {
  label: string;
  estimated: boolean;
}

export function cameraCones(placements: readonly CameraPlacement[]): FeatureCollection<Polygon, ConeProps> {
  return featureCollection(
    placements
      .filter((p) => p.heading !== null)
      .map((p) => ({
        type: "Feature" as const,
        properties: { label: p.label, estimated: p.estimatedPosition || p.estimatedHeading },
        geometry: {
          type: "Polygon" as const,
          coordinates: [cameraConeRing(p.position, p.heading as number, coneRangeM(p.distanceM))],
        },
      })),
  );
}

/* ──────────────────────────────── Drones ──────────────────────────────── */

export type DroneMissionInput = Pick<
  DroneMission,
  "id" | "label" | "status" | "pattern" | "waypoints" | "track" | "last" | "home_lat" | "home_lng"
>;

export function isMissionActive(status: DroneMission["status"]): boolean {
  return status !== "landed" && status !== "aborted";
}

export interface DroneLineProps {
  label: string;
  active: boolean;
}

export interface DroneOverlays {
  /** Traza recorrida (telemetría). */
  tracks: FeatureCollection<LineString, DroneLineProps>;
  /** Ruta planificada (waypoints), tenue. */
  routes: FeatureCollection<LineString, DroneLineProps>;
  waypoints: FeatureCollection<Point, DroneLineProps>;
}

export function droneOverlays(missions: readonly DroneMissionInput[]): DroneOverlays {
  const tracks: Feature<LineString, DroneLineProps>[] = [];
  const routes: Feature<LineString, DroneLineProps>[] = [];
  const waypoints: Feature<Point, DroneLineProps>[] = [];
  for (const m of missions) {
    const props = { label: m.label, active: isMissionActive(m.status) };
    // La posición actual cierra la traza; si ya es el último punto, lineFromPoints la deduplica.
    const track = lineFromPoints(m.last ? [...m.track, m.last] : m.track);
    if (track) tracks.push({ type: "Feature", properties: props, geometry: { type: "LineString", coordinates: track } });
    const route = lineFromPoints(m.waypoints, m.pattern === "orbit");
    if (route) routes.push({ type: "Feature", properties: props, geometry: { type: "LineString", coordinates: route } });
    for (const w of m.waypoints) {
      if (!isValidLatLng(w.lat, w.lng)) continue;
      waypoints.push({ type: "Feature", properties: props, geometry: { type: "Point", coordinates: [w.lng, w.lat] } });
    }
  }
  return { tracks: featureCollection(tracks), routes: featureCollection(routes), waypoints: featureCollection(waypoints) };
}
