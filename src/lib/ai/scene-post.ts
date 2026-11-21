/**
 * Post-proceso de la reconstrucción espacial (solo funciones puras).
 *
 * El pipeline pasa por `sanitizeScene` TODA escena, venga de Claude o del motor
 * de reglas, antes de guardarla. Garantiza que el visor 3D reciba números
 * finitos y acotados, ids únicos y referencias válidas, y que las cámaras con
 * GPS real queden donde dice el GPS (no donde las imaginó el modelo).
 *
 * Nunca lanza: lee la entrada de forma defensiva y devuelve un objeto nuevo.
 */
import {
  AccessPointKindSchema,
  ConfidenceSchema,
  ConstructionSchema,
  HazardKindSchema,
  HazardSeveritySchema,
  PersonStatusSchema,
  SceneModelAISchema,
  SmokeColorSchema,
  SmokeVolumeSchema,
  StructureKindSchema,
  StructureSideSchema,
  VehicleKindSchema,
  VehicleStateSchema,
  type Confidence,
  type EvidenceRef,
  type Media,
  type SceneModel,
} from "@/lib/domain";
import { isValidLatLng, normalizeDeg, toLocal } from "@/lib/geo";
import type { z } from "zod";

export interface SceneSanitizeContext {
  incident: { lat: number; lng: number };
  media: Media[];
}

/* ───────────────────────────── Límites ───────────────────────────── */

export const SCENE_BOUNDS = {
  /** Posiciones x/y en metros respecto del incidente. */
  POS_M: 500,
  Z_MIN: 0,
  Z_MAX: 200,
  STRUCTURE_SIDE_MIN: 2,
  STRUCTURE_SIDE_MAX: 200,
  FLOORS_MIN: 1,
  FLOORS_MAX: 60,
  FLOOR_HEIGHT_MIN: 2,
  FLOOR_HEIGHT_MAX: 6,
  FLOOR_HEIGHT_DEFAULT: 2.7,
  RADIUS_MIN: 0.5,
  RADIUS_MAX: 200,
  VEHICLE_LENGTH_MIN: 1,
  VEHICLE_LENGTH_MAX: 25,
  VEHICLE_WIDTH_MIN: 0.8,
  VEHICLE_WIDTH_MAX: 4,
  ROAD_WIDTH_MIN: 2,
  ROAD_WIDTH_MAX: 60,
  ROAD_WIDTH_DEFAULT: 7,
  PEOPLE_COUNT_MAX: 1000,
  /** Altura de una cámara de mano (vecino, bombero). */
  GROUND_CAMERA_Z: 1.5,
  /** Altura supuesta de un dron sin altitud informada. */
  DRONE_CAMERA_Z: 30,
} as const;

/* ───────────────────────────── Lectura defensiva ───────────────────────────── */

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Rec) : {};
}

function list(v: unknown): Rec[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is Rec => typeof x === "object" && x !== null && !Array.isArray(x));
}

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Número finito acotado; si no es finito, `def` (también acotado). */
function num(v: unknown, def: number, lo: number, hi: number): number {
  return clamp(isNum(v) ? v : def, lo, hi);
}

function int(v: unknown, def: number, lo: number, hi: number): number {
  return Math.round(num(v, def, lo, hi));
}

function pos(v: unknown, def = 0): number {
  return num(v, def, -SCENE_BOUNDS.POS_M, SCENE_BOUNDS.POS_M);
}

function height(v: unknown, def: number): number {
  return num(v, def, SCENE_BOUNDS.Z_MIN, SCENE_BOUNDS.Z_MAX);
}

function radius(v: unknown, def: number): number {
  return num(v, def, SCENE_BOUNDS.RADIUS_MIN, SCENE_BOUNDS.RADIUS_MAX);
}

/** Rumbo normalizado a [0, 360). */
function bearing(v: unknown, def = 0): number {
  return isNum(v) ? normalizeDeg(v) : def;
}

/** Rumbo en [0, 360) o el centinela -1 ("desconocido"); no finito → -1. */
function bearingOrUnknown(v: unknown): number {
  if (!isNum(v) || v === -1) return -1;
  return normalizeDeg(v);
}

/** Eje de calle en [0, 180) o -1. */
function axisOrUnknown(v: unknown): number {
  if (!isNum(v) || v === -1) return -1;
  return ((v % 180) + 180) % 180;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function bool(v: unknown): boolean {
  return v === true;
}

function oneOf<S extends z.ZodType<string>>(schema: S, v: unknown, def: z.output<S>): z.output<S> {
  const r = schema.safeParse(typeof v === "string" ? v.trim() : v);
  return r.success ? r.data : def;
}

/* Enums definidos en línea dentro del esquema de escena. */
const StructureRoleGuard = SceneModelAISchema.shape.structures.element.shape.role;
const RoofGuard = SceneModelAISchema.shape.structures.element.shape.roof;
const FireIntensityGuard = SceneModelAISchema.shape.fire_zones.element.shape.intensity;

function confidence(v: unknown, def: Confidence = "low"): Confidence {
  return oneOf(ConfidenceSchema, v, def);
}

function evidence(v: unknown): EvidenceRef[] {
  return list(v)
    .map((e) => ({
      ref: str(e.ref),
      frame: int(e.frame, -1, -1, Number.MAX_SAFE_INTEGER),
      note: str(e.note),
    }))
    .filter((e) => e.ref !== "");
}

function stringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map(str).filter((s) => s !== "");
}

/**
 * Ids únicos y no vacíos por colección. El primer elemento con un id conserva
 * el suyo; los vacíos o repetidos reciben `<prefijo><n>` con el menor n libre.
 */
function assignIds(items: readonly Rec[], prefix: string): string[] {
  const used = new Set<string>();
  const kept: (string | null)[] = items.map((it) => {
    const id = str(it.id);
    if (id === "" || used.has(id)) return null;
    used.add(id);
    return id;
  });
  let n = 1;
  return kept.map((id) => {
    if (id !== null) return id;
    while (used.has(`${prefix}${n}`)) n++;
    const fresh = `${prefix}${n}`;
    used.add(fresh);
    return fresh;
  });
}

/* ───────────────────────────── Cámaras ───────────────────────────── */

type Camera = SceneModel["cameras"][number];

const normLabel = (s: string) => s.trim().toUpperCase();

interface GpsFix {
  x: number;
  y: number;
  /** null → usar la altura por defecto según la fuente. */
  z: number | null;
  heading: number | null;
  /** true si el punto quedaba fuera del área de la escena y se acercó al borde. */
  clipped: boolean;
}

/** Posición GPS del medio en coordenadas locales, o null si no tiene GPS usable. */
function gpsFix(incident: { lat: number; lng: number }, media: Media): GpsFix | null {
  let lat: number | null = null;
  let lng: number | null = null;
  let z: number | null = null;
  let heading: number | null = isNum(media.heading_deg) ? media.heading_deg : null;

  if (media.source === "drone" && Array.isArray(media.frames)) {
    // El dron se mueve: vale la posición del cuadro más reciente con GPS.
    const withGps = media.frames
      .filter((f) => f && isValidLatLng(f.lat, f.lng))
      .sort((a, b) => (isNum(b.t_s) ? b.t_s : 0) - (isNum(a.t_s) ? a.t_s : 0) || b.idx - a.idx);
    const last = withGps[0];
    if (last && last.lat !== null && last.lng !== null) {
      lat = last.lat;
      lng = last.lng;
      if (isNum(last.alt_m)) z = last.alt_m;
      if (isNum(last.heading_deg)) heading = last.heading_deg;
    }
  }
  if (lat === null || lng === null) {
    if (!isValidLatLng(media.lat, media.lng) || media.lat === null || media.lng === null) return null;
    lat = media.lat;
    lng = media.lng;
  }

  const p = toLocal(incident, { lat, lng });
  if (!isNum(p.x) || !isNum(p.y)) return null;
  // Fuera del área: se acerca en línea recta hacia el origen, conservando el rumbo.
  const m = Math.max(Math.abs(p.x), Math.abs(p.y));
  const s = m > SCENE_BOUNDS.POS_M ? SCENE_BOUNDS.POS_M / m : 1;
  return { x: p.x * s, y: p.y * s, z, heading, clipped: s < 1 };
}

function defaultCameraZ(media: Media): number {
  return media.source === "drone" ? SCENE_BOUNDS.DRONE_CAMERA_Z : SCENE_BOUNDS.GROUND_CAMERA_Z;
}

function cameraFromGps(media: Media, fix: GpsFix, fallbackFacing: number): Camera {
  return {
    media_ref: media.label,
    x: fix.x,
    y: fix.y,
    z: height(fix.z ?? defaultCameraZ(media), defaultCameraZ(media)),
    facing_deg: fix.heading !== null ? normalizeDeg(fix.heading) : fallbackFacing,
    confidence: fix.clipped ? "low" : "high",
  };
}

function sanitizeCameras(raw: unknown, ctx: SceneSanitizeContext): Camera[] {
  const incident = rec(ctx.incident);
  const origin = isValidLatLng(incident.lat, incident.lng)
    ? { lat: incident.lat as number, lng: incident.lng as number }
    : null;

  const byLabel = new Map<string, Media>();
  for (const m of Array.isArray(ctx.media) ? ctx.media : []) {
    if (m && typeof m.label === "string" && m.label.trim() !== "" && !byLabel.has(normLabel(m.label))) {
      byLabel.set(normLabel(m.label), m);
    }
  }
  const fixes = new Map<string, GpsFix | null>();
  const fixOf = (key: string, media: Media) => {
    if (!fixes.has(key)) fixes.set(key, origin ? gpsFix(origin, media) : null);
    return fixes.get(key) ?? null;
  };

  const out: Camera[] = [];
  const seen = new Set<string>();
  for (const c of list(raw)) {
    const key = normLabel(str(c.media_ref));
    const media = byLabel.get(key);
    // Cámara de un medio que no existe → se elimina; una sola cámara por medio.
    if (!media || seen.has(key)) continue;
    seen.add(key);
    const modelFacing = bearingOrUnknown(c.facing_deg);
    const fix = fixOf(key, media);
    if (fix) {
      out.push(cameraFromGps(media, fix, modelFacing));
    } else {
      out.push({
        media_ref: media.label,
        x: pos(c.x),
        y: pos(c.y),
        z: height(c.z, defaultCameraZ(media)),
        facing_deg: isNum(media.heading_deg) ? normalizeDeg(media.heading_deg) : modelFacing,
        confidence: confidence(c.confidence),
      });
    }
  }
  // Medios con GPS que el modelo no dibujó.
  for (const [key, media] of byLabel) {
    if (seen.has(key)) continue;
    const fix = fixOf(key, media);
    if (fix) {
      seen.add(key);
      out.push(cameraFromGps(media, fix, -1));
    }
  }
  return out;
}

/* ───────────────────────────── Escena ───────────────────────────── */

function sanitizeOrThrow(scene: unknown, ctx: SceneSanitizeContext): SceneModel {
  const s = rec(scene);
  const ground = rec(s.ground);

  const rawRoads = list(s.roads);
  const roadIds = assignIds(rawRoads, "R");
  const roads: SceneModel["roads"] = rawRoads.map((r, i) => ({
    id: roadIds[i],
    name: str(r.name),
    x1: pos(r.x1),
    y1: pos(r.y1),
    x2: pos(r.x2),
    y2: pos(r.y2),
    width_m: num(r.width_m, SCENE_BOUNDS.ROAD_WIDTH_DEFAULT, SCENE_BOUNDS.ROAD_WIDTH_MIN, SCENE_BOUNDS.ROAD_WIDTH_MAX),
    blocked: bool(r.blocked),
  }));

  const rawStructures = list(s.structures);
  const structureIds = assignIds(rawStructures, "S");
  const structures: SceneModel["structures"] = rawStructures.map((r, i) => {
    const kind = oneOf(StructureKindSchema, r.kind, "unknown");
    return {
      id: structureIds[i],
      label: str(r.label),
      kind,
      role: oneOf(StructureRoleGuard, r.role, "reference"),
      x: pos(r.x),
      y: pos(r.y),
      width_m: num(r.width_m, 8, SCENE_BOUNDS.STRUCTURE_SIDE_MIN, SCENE_BOUNDS.STRUCTURE_SIDE_MAX),
      depth_m: num(r.depth_m, 10, SCENE_BOUNDS.STRUCTURE_SIDE_MIN, SCENE_BOUNDS.STRUCTURE_SIDE_MAX),
      floors: int(r.floors, kind === "house_2_story" ? 2 : 1, SCENE_BOUNDS.FLOORS_MIN, SCENE_BOUNDS.FLOORS_MAX),
      floor_height_m: num(
        r.floor_height_m,
        SCENE_BOUNDS.FLOOR_HEIGHT_DEFAULT,
        SCENE_BOUNDS.FLOOR_HEIGHT_MIN,
        SCENE_BOUNDS.FLOOR_HEIGHT_MAX,
      ),
      rotation_deg: bearing(r.rotation_deg),
      roof: oneOf(RoofGuard, r.roof, "unknown"),
      construction: oneOf(ConstructionSchema, r.construction, "unknown"),
      confidence: confidence(r.confidence),
      notes: str(r.notes),
    };
  });
  const structureById = new Map(structures.map((st) => [st.id, st]));
  const structureRef = (v: unknown) => {
    const id = str(v);
    return structureById.has(id) ? id : "";
  };
  /** Altura por defecto dentro de un piso (solo si el valor no es finito). */
  const floorZ = (structureId: string, floor: number, within: number) => {
    const fh = structureById.get(structureId)?.floor_height_m ?? SCENE_BOUNDS.FLOOR_HEIGHT_DEFAULT;
    return floor >= 1 ? (floor - 1) * fh + within * fh : within * 2;
  };

  const rawFires = list(s.fire_zones);
  const fireIds = assignIds(rawFires, "F");
  const fire_zones: SceneModel["fire_zones"] = rawFires.map((r, i) => {
    const structure_id = structureRef(r.structure_id);
    const floor = int(r.floor, structure_id ? 1 : 0, 0, SCENE_BOUNDS.FLOORS_MAX);
    return {
      id: fireIds[i],
      structure_id,
      floor,
      side: oneOf(StructureSideSchema, r.side, "unknown"),
      x: pos(r.x),
      y: pos(r.y),
      z: height(r.z, floorZ(structure_id, floor, 0.5)),
      radius_m: radius(r.radius_m, 3),
      intensity: oneOf(FireIntensityGuard, r.intensity, "moderate"),
      confidence: confidence(r.confidence),
      note: str(r.note),
    };
  });

  const rawSmoke = list(s.smoke_plumes);
  const smokeIds = assignIds(rawSmoke, "H");
  const smoke_plumes: SceneModel["smoke_plumes"] = rawSmoke.map((r, i) => ({
    id: smokeIds[i],
    x: pos(r.x),
    y: pos(r.y),
    z: height(r.z, 10),
    drift_deg: bearingOrUnknown(r.drift_deg),
    volume: oneOf(SmokeVolumeSchema, r.volume, "moderate"),
    color: oneOf(SmokeColorSchema, r.color, "unknown"),
  }));

  const rawPeople = list(s.people);
  const peopleIds = assignIds(rawPeople, "P");
  const people: SceneModel["people"] = rawPeople.map((r, i) => {
    const structure_id = structureRef(r.structure_id);
    const floor = int(r.floor, structure_id ? 1 : 0, 0, SCENE_BOUNDS.FLOORS_MAX);
    return {
      id: peopleIds[i],
      status: oneOf(PersonStatusSchema, r.status, "unknown"),
      count: int(r.count, 1, 1, SCENE_BOUNDS.PEOPLE_COUNT_MAX),
      structure_id,
      floor,
      x: pos(r.x),
      y: pos(r.y),
      z: height(r.z, floorZ(structure_id, floor, 0.4)),
      confidence: confidence(r.confidence),
      note: str(r.note),
      evidence: evidence(r.evidence),
    };
  });

  const rawVehicles = list(s.vehicles);
  const vehicleIds = assignIds(rawVehicles, "V");
  const vehicles: SceneModel["vehicles"] = rawVehicles.map((r, i) => ({
    id: vehicleIds[i],
    kind: oneOf(VehicleKindSchema, r.kind, "other"),
    state: oneOf(VehicleStateSchema, r.state, "unknown"),
    x: pos(r.x),
    y: pos(r.y),
    rotation_deg: bearing(r.rotation_deg),
    length_m: num(r.length_m, 4.5, SCENE_BOUNDS.VEHICLE_LENGTH_MIN, SCENE_BOUNDS.VEHICLE_LENGTH_MAX),
    width_m: num(r.width_m, 1.8, SCENE_BOUNDS.VEHICLE_WIDTH_MIN, SCENE_BOUNDS.VEHICLE_WIDTH_MAX),
    entrapment_suspected: bool(r.entrapment_suspected),
    burning: bool(r.burning),
    note: str(r.note),
  }));

  const rawHazards = list(s.hazards);
  const hazardIds = assignIds(rawHazards, "Z");
  const hazards: SceneModel["hazards"] = rawHazards.map((r, i) => ({
    id: hazardIds[i],
    kind: oneOf(HazardKindSchema, r.kind, "other"),
    x: pos(r.x),
    y: pos(r.y),
    z: height(r.z, 0),
    radius_m: radius(r.radius_m, 10),
    severity: oneOf(HazardSeveritySchema, r.severity, "medium"),
    note: str(r.note),
  }));

  const rawAccess = list(s.access_points);
  const accessIds = assignIds(rawAccess, "A");
  const access_points: SceneModel["access_points"] = rawAccess.map((r, i) => ({
    id: accessIds[i],
    kind: oneOf(AccessPointKindSchema, r.kind, "other"),
    x: pos(r.x),
    y: pos(r.y),
    label: str(r.label),
    note: str(r.note),
  }));

  const annotations: SceneModel["annotations"] = list(s.annotations).map((r) => ({
    x: pos(r.x),
    y: pos(r.y),
    z: height(r.z, 3),
    text: str(r.text),
  }));

  return {
    description: str(s.description),
    ground: { street_axis_deg: axisOrUnknown(ground.street_axis_deg), notes: str(ground.notes) },
    roads,
    structures,
    fire_zones,
    smoke_plumes,
    people,
    vehicles,
    hazards,
    access_points,
    cameras: sanitizeCameras(s.cameras, ctx),
    annotations,
    uncertainty_notes: stringList(s.uncertainty_notes),
    confidence: confidence(s.confidence),
  };
}

/**
 * Normaliza una escena (de cualquier motor) para guardarla y dibujarla.
 * Pura, nunca lanza y devuelve un objeto nuevo.
 */
export function sanitizeScene(scene: SceneModel, ctx: SceneSanitizeContext): SceneModel {
  try {
    return sanitizeOrThrow(scene, ctx);
  } catch {
    // Inalcanzable con la lectura defensiva; red de seguridad para no tumbar el pipeline.
    return sanitizeOrThrow({}, { incident: { lat: 0, lng: 0 }, media: [] });
  }
}
