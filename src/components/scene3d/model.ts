/**
 * Normalización defensiva del SceneModel que entrega la IA y derivación del
 * modelo de dibujo (estructuras, focos, personas, cámaras, drones, encuadre).
 *
 * Funciones puras: aceptan datos imperfectos (listas ausentes, ids vacíos o
 * repetidos, structure_id inexistente, pisos 0, dimensiones ≤ 0, NaN,
 * coordenadas enormes) y siempre devuelven valores seguros para dibujar.
 */
import {
  AccessPointKindSchema,
  ConfidenceSchema,
  ConstructionSchema,
  HazardKindSchema,
  HazardSeveritySchema,
  PersonStatusSchema,
  SmokeColorSchema,
  SmokeVolumeSchema,
  StructureKindSchema,
  StructureSideSchema,
  VehicleKindSchema,
  VehicleStateSchema,
  type AccessPointKind,
  type Confidence,
  type Construction,
  type DroneMission,
  type EvidenceRef,
  type HazardKind,
  type HazardSeverity,
  type MediaKind,
  type MediaSource,
  type MissionMode,
  type MissionStatus,
  type PersonStatus,
  type SceneModel,
  type SmokeColor,
  type StructureKind,
  type StructureSide,
  type VehicleKind,
  type VehicleState,
} from "@/lib/domain";
import type { MediaView } from "@/lib/contract";
import { isValidLatLng, normalizeDeg, toLocal, type LatLng } from "@/lib/geo";
import {
  boundsOf,
  clamp,
  clampInsideFootprint,
  footprintCorners,
  isInsideFootprint,
  nearestFacade,
  padBounds,
  pointOnFacade,
  unionBounds,
  type Bounds,
  type Footprint,
  type XY,
} from "./geometry";

/* ───────────────────────────── Límites ───────────────────────────── */

/** Coordenadas horizontales de la escena se acotan a ± este valor (m). */
export const COORD_LIMIT = 1000;
/** Altura máxima admitida (m). */
export const Z_LIMIT = 400;
/** Entidades más lejos que esto del foco no participan del encuadre inicial (sí se dibujan). */
export const FRAME_RADIUS = 180;
/** Medios con GPS a más de esta distancia del incidente no se dibujan como cámara. */
export const CAMERA_MAX_DISTANCE = 1500;

/* ───────────────────────────── Tipos ───────────────────────────── */

export type StructureRole = "involved" | "exposure" | "reference";
export type RoofKind = "flat" | "gable" | "unknown";
export type FireIntensity = "smoke_only" | "light" | "moderate" | "heavy";
export type PersonRisk = "critical" | "injured" | "other";

export interface NStructure {
  id: string;
  label: string;
  kind: StructureKind;
  role: StructureRole;
  x: number;
  y: number;
  width: number;
  depth: number;
  floors: number;
  floorHeight: number;
  /** Altura de muros (pisos × altura de piso). */
  height: number;
  roof: RoofKind;
  /** Altura de la cumbrera sobre los muros (0 si el techo es plano). */
  roofHeight: number;
  rotationDeg: number;
  construction: Construction;
  confidence: Confidence;
  notes: string;
  /** Valores que el visor tuvo que suponer porque el modelo no los entregó o eran inválidos. */
  assumed: { size: boolean; floors: boolean; floorHeight: boolean };
}

export interface NFire {
  id: string;
  structureId: string | null;
  floor: number;
  side: StructureSide;
  x: number;
  y: number;
  z: number;
  radius: number;
  intensity: FireIntensity;
  confidence: Confidence;
  note: string;
}

export interface NSmoke {
  id: string;
  x: number;
  y: number;
  z: number;
  driftDeg: number | null;
  volume: "light" | "moderate" | "heavy";
  color: SmokeColor;
}

export interface NPerson {
  id: string;
  status: PersonStatus;
  /** 0 = cantidad no determinada (nunca se interpreta como "nadie"). */
  count: number;
  structureId: string | null;
  floor: number;
  x: number;
  y: number;
  /** Altura de los pies sobre el suelo. */
  z: number;
  confidence: Confidence;
  note: string;
  evidence: EvidenceRef[];
  risk: PersonRisk;
}

export interface NVehicle {
  id: string;
  kind: VehicleKind;
  state: VehicleState;
  x: number;
  y: number;
  rotationDeg: number;
  length: number;
  width: number;
  height: number;
  entrapment: boolean;
  burning: boolean;
  note: string;
}

export interface NHazard {
  id: string;
  kind: HazardKind;
  x: number;
  y: number;
  z: number;
  radius: number;
  severity: HazardSeverity;
  note: string;
}

export interface NAccess {
  id: string;
  kind: AccessPointKind;
  x: number;
  y: number;
  label: string;
  note: string;
}

export interface NRoad {
  id: string;
  name: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width: number;
  blocked: boolean;
  length: number;
}

export interface NAnnotation {
  id: string;
  x: number;
  y: number;
  z: number;
  text: string;
}

export interface NCamera {
  /** Etiqueta del medio ("M2"); es también el id de selección. */
  mediaRef: string;
  x: number;
  y: number;
  z: number;
  facingDeg: number | null;
  confidence: Confidence;
  /** scene = posición estimada por la IA; gps = posición informada por el teléfono/dron. */
  origin: "scene" | "gps";
  mediaId: string | null;
  source: MediaSource | null;
  mediaKind: MediaKind | null;
  posterUrl: string | null;
}

export interface NDrone {
  id: string;
  label: string;
  status: MissionStatus;
  mode: MissionMode;
  x: number;
  y: number;
  z: number;
  headingDeg: number;
  /** Traza en ENU (x, y, z), submuestreada. */
  track: { x: number; y: number; z: number }[];
  batteryPct: number | null;
  speedMs: number | null;
  /** false si la misión terminó (aterrizada o abortada). */
  active: boolean;
  at: string | null;
}

export interface NormScene {
  description: string;
  streetAxisDeg: number | null;
  groundNotes: string;
  roads: NRoad[];
  structures: NStructure[];
  fires: NFire[];
  smokes: NSmoke[];
  people: NPerson[];
  vehicles: NVehicle[];
  hazards: NHazard[];
  access: NAccess[];
  cameras: NCamera[];
  annotations: NAnnotation[];
  uncertaintyNotes: string[];
  confidence: Confidence;
  /** Estructura principal (primera afectada, o la primera). */
  primaryId: string | null;
  /** Rumbo de la fachada principal para las vistas Frente/Posterior. */
  frontHeadingDeg: number;
  /** Centro táctico: estructura principal, primer foco o centroide. */
  focus: XY;
}

export interface SceneView {
  scene: NormScene;
  cameras: NCamera[];
  drones: NDrone[];
  /** Caja del contenido para el encuadre automático. */
  frame: Bounds;
  /** Caja de todo lo dibujable en el suelo (dimensiona suelo y grilla). */
  extent: Bounds;
}

/* ──────────────────────── Ayudantes defensivos ──────────────────────── */

type Loose = Record<string, unknown>;

function obj(v: unknown): Loose {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Loose) : {};
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function num(v: unknown, def: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : def;
}
function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}
function bool(v: unknown): boolean {
  return v === true;
}
function oneOf<T extends string>(v: unknown, options: readonly T[], def: T): T {
  return typeof v === "string" && (options as readonly string[]).includes(v) ? (v as T) : def;
}
function coord(v: unknown): number {
  return clamp(num(v, 0), -COORD_LIMIT, COORD_LIMIT);
}
function height(v: unknown, def = 0): number {
  return clamp(num(v, def), 0, Z_LIMIT);
}
function positive(v: unknown, def: number, min: number, max: number): { value: number; assumed: boolean } {
  const n = num(v, NaN);
  if (!(n > 0)) return { value: def, assumed: true };
  return { value: clamp(n, min, max), assumed: false };
}

/**
 * Ids únicos y no vacíos (las claves de React y la selección dependen de ello).
 * Un id explícito conserva su valor en su primera aparición; los generados nunca
 * toman un id explícito de otro elemento (así structure_id sigue apuntando bien).
 */
function assignIds(items: unknown[], prefix: string): string[] {
  const explicit = new Set(items.map((it) => str(obj(it).id)).filter(Boolean));
  const used = new Set<string>();
  const taken = (id: string) => used.has(id) || explicit.has(id);
  let n = 1;
  return items.map((it) => {
    const raw = str(obj(it).id);
    let id: string;
    if (raw && !used.has(raw)) {
      id = raw;
    } else if (raw) {
      let k = 2;
      while (taken(`${raw}·${k}`)) k++;
      id = `${raw}·${k}`;
    } else {
      while (taken(`${prefix}${n}`)) n++;
      id = `${prefix}${n}`;
    }
    used.add(id);
    return id;
  });
}

const CONFIDENCES = ConfidenceSchema.options;

/* ─────────────────────────── Valores por defecto ─────────────────────────── */

const STRUCTURE_DEFAULTS: Record<StructureKind, { w: number; d: number; floors: number }> = {
  house_1_story: { w: 8, d: 10, floors: 1 },
  house_2_story: { w: 8, d: 10, floors: 2 },
  apartment_building: { w: 20, d: 15, floors: 4 },
  commercial: { w: 12, d: 15, floors: 1 },
  industrial: { w: 30, d: 40, floors: 1 },
  warehouse: { w: 25, d: 35, floors: 1 },
  informal_settlement: { w: 6, d: 6, floors: 1 },
  other: { w: 10, d: 10, floors: 1 },
  unknown: { w: 8, d: 10, floors: 1 },
};

export const VEHICLE_DIMENSIONS: Record<VehicleKind, { l: number; w: number; h: number }> = {
  car: { l: 4.5, w: 1.8, h: 1.5 },
  suv_pickup: { l: 5.0, w: 1.9, h: 1.8 },
  van: { l: 5.2, w: 2.0, h: 2.3 },
  truck: { l: 9.0, w: 2.5, h: 3.4 },
  bus: { l: 12.0, w: 2.55, h: 3.2 },
  motorcycle: { l: 2.1, w: 0.8, h: 1.2 },
  bicycle: { l: 1.8, w: 0.6, h: 1.1 },
  trailer: { l: 7.0, w: 2.5, h: 2.8 },
  other: { l: 4.5, w: 2.0, h: 2.0 },
};

const FIRE_RADIUS: Record<FireIntensity, number> = { smoke_only: 3, light: 1.5, moderate: 2.5, heavy: 4 };
const HAZARD_RADIUS: Record<HazardSeverity, number> = { low: 5, medium: 10, high: 20 };

const CRITICAL_STATUSES: readonly PersonStatus[] = ["trapped", "at_window_or_balcony", "on_roof"];

export function personRisk(status: PersonStatus): PersonRisk {
  if (CRITICAL_STATUSES.includes(status)) return "critical";
  if (status === "injured") return "injured";
  return "other";
}

export function footprintOf(s: Pick<NStructure, "x" | "y" | "width" | "depth" | "rotationDeg">): Footprint {
  return { x: s.x, y: s.y, width: s.width, depth: s.depth, rotationDeg: s.rotationDeg };
}

/* ─────────────────────────── Normalización ─────────────────────────── */

type RawStructure = NStructure & { roleValid: boolean };

function normalizeStructures(raw: unknown[]): RawStructure[] {
  const ids = assignIds(raw, "S");
  return raw.map((item, i) => {
    const r = obj(item);
    const kind = oneOf(r.kind, StructureKindSchema.options, "unknown");
    const def = STRUCTURE_DEFAULTS[kind];
    const w = positive(r.width_m, def.w, 2, 300);
    const d = positive(r.depth_m, def.d, 2, 300);
    const floorsRaw = Math.round(num(r.floors, 0));
    const floorsAssumed = !(floorsRaw >= 1);
    const floors = floorsAssumed ? def.floors : Math.min(floorsRaw, 60);
    const fhRaw = num(r.floor_height_m, NaN);
    const floorHeightAssumed = !(fhRaw > 0);
    const floorHeight = floorHeightAssumed ? 2.7 : clamp(fhRaw, 2.2, 8);
    const roof = oneOf(r.roof, ["flat", "gable", "unknown"] as const, "unknown");
    const wallHeight = floors * floorHeight;
    const roofHeight = roof === "gable" ? clamp(Math.min(w.value, d.value) * 0.3, 1, 5) : 0;
    return {
      id: ids[i],
      label: str(r.label),
      kind,
      // Rol inválido: se decide después según si tiene un foco asociado.
      role: oneOf(r.role, ["involved", "exposure", "reference"] as const, "reference"),
      x: coord(r.x),
      y: coord(r.y),
      width: w.value,
      depth: d.value,
      floors,
      floorHeight,
      height: wallHeight,
      roof,
      roofHeight,
      rotationDeg: normalizeDeg(num(r.rotation_deg, 0)),
      construction: oneOf(r.construction, ConstructionSchema.options, "unknown"),
      confidence: oneOf(r.confidence, CONFIDENCES, "low"),
      notes: str(r.notes),
      assumed: { size: w.assumed || d.assumed, floors: floorsAssumed, floorHeight: floorHeightAssumed },
      roleValid: typeof r.role === "string" && ["involved", "exposure", "reference"].includes(r.role),
    };
  });
}

function placeFire(
  r: Loose,
  s: NStructure | undefined,
  floorIn: number,
  side: StructureSide,
  radius: number,
): { x: number; y: number; z: number; floor: number } {
  const rx = num(r.x, NaN);
  const ry = num(r.y, NaN);
  if (!s) {
    return { x: coord(r.x), y: coord(r.y), z: height(r.z, radius * 0.6), floor: Math.max(0, floorIn) };
  }
  const fp = footprintOf(s);
  const hasXY = Number.isFinite(rx) && Number.isFinite(ry);
  const px = hasXY ? clamp(rx, -COORD_LIMIT, COORD_LIMIT) : s.x;
  const py = hasXY ? clamp(ry, -COORD_LIMIT, COORD_LIMIT) : s.y;
  const floor = floorIn >= 1 ? Math.min(floorIn, s.floors) : 0;
  const topZ = s.height + s.roofHeight;
  let z = floor >= 1 ? (floor - 0.5) * s.floorHeight : clamp(num(r.z, s.height / 2), 0.5, topZ);
  let xy: XY;
  switch (side) {
    case "front":
    case "rear":
    case "left":
    case "right":
      xy = pointOnFacade(fp, side, px, py, 0.2);
      break;
    case "roof":
      xy = clampInsideFootprint(fp, px, py, 1);
      z = s.height + s.roofHeight * 0.5;
      return { ...xy, z, floor: s.floors };
    case "interior":
      xy = clampInsideFootprint(fp, px, py, 1);
      break;
    case "whole_floor":
      xy = { x: s.x, y: s.y };
      break;
    default:
      xy = hasXY && isInsideFootprint(fp, px, py, 2) ? clampInsideFootprint(fp, px, py, 0.5) : { x: s.x, y: s.y };
  }
  z = clamp(z, 0.3, topZ);
  return { ...xy, z, floor };
}

function placePerson(
  r: Loose,
  s: NStructure | undefined,
  status: PersonStatus,
  floorIn: number,
): { x: number; y: number; z: number; floor: number } {
  const x = coord(r.x);
  const y = coord(r.y);
  if (!s) return { x, y, z: height(r.z, 0), floor: Math.max(0, floorIn) };
  const fp = footprintOf(s);
  const hasXY = Number.isFinite(num(r.x, NaN)) && Number.isFinite(num(r.y, NaN));
  if (status === "on_roof") {
    const xy = hasXY ? clampInsideFootprint(fp, x, y, 0.8) : { x: s.x, y: s.y };
    return { ...xy, z: s.height + s.roofHeight * 0.5, floor: s.floors };
  }
  const floor = floorIn >= 1 ? Math.min(floorIn, s.floors) : 0;
  const z = floor >= 1 ? (floor - 1) * s.floorHeight + 0.05 : clamp(num(r.z, 0), 0, s.height);
  if (status === "at_window_or_balcony") {
    const px = hasXY ? x : s.x;
    const py = hasXY ? y : s.y;
    const side = hasXY ? nearestFacade(fp, px, py) : "front";
    return { ...pointOnFacade(fp, side, px, py, 0.5), z, floor };
  }
  if (status === "trapped") {
    const xy = hasXY && isInsideFootprint(fp, x, y, 3) ? clampInsideFootprint(fp, x, y, 0.6) : { x: s.x, y: s.y };
    return { ...xy, z, floor };
  }
  return { x: hasXY ? x : s.x, y: hasXY ? y : s.y, z, floor };
}

function normalizeEvidence(raw: unknown): EvidenceRef[] {
  const out: EvidenceRef[] = [];
  for (const item of arr(raw)) {
    const r = obj(item);
    const ref = str(r.ref);
    if (!ref) continue;
    out.push({ ref, frame: Math.round(num(r.frame, -1)), note: str(r.note) });
  }
  return out;
}

/** Normaliza un SceneModel (o algo con su forma) a valores seguros para dibujar. */
export function normalizeScene(input: SceneModel | null | undefined): NormScene {
  const root = obj(input);
  const ground = obj(root.ground);

  const structuresRaw = normalizeStructures(arr(root.structures));
  const byId = new Map(structuresRaw.map((s) => [s.id, s]));

  const fireList = arr(root.fire_zones);
  const fireIds = assignIds(fireList, "F");
  const fires: NFire[] = fireList.map((item, i) => {
    const r = obj(item);
    const sid = str(r.structure_id);
    const s = sid ? byId.get(sid) : undefined;
    const intensity = oneOf(r.intensity, ["smoke_only", "light", "moderate", "heavy"] as const, "moderate");
    const side = oneOf(r.side, StructureSideSchema.options, "unknown");
    const radius = positive(r.radius_m, FIRE_RADIUS[intensity], 0.5, 25).value;
    const placed = placeFire(r, s, Math.round(num(r.floor, 0)), side, radius);
    return {
      id: fireIds[i],
      structureId: s ? s.id : null,
      floor: placed.floor,
      side,
      x: placed.x,
      y: placed.y,
      z: placed.z,
      radius,
      intensity,
      confidence: oneOf(r.confidence, CONFIDENCES, "low"),
      note: str(r.note),
    };
  });

  // Rol ausente o inválido: "involved" si tiene fuego asociado.
  const structures: NStructure[] = structuresRaw.map(({ roleValid, ...s }) => {
    if (!roleValid && fires.some((f) => f.structureId === s.id && f.intensity !== "smoke_only")) {
      return { ...s, role: "involved" as const };
    }
    return s;
  });
  const structById = new Map(structures.map((s) => [s.id, s]));

  const smokeList = arr(root.smoke_plumes);
  const smokeIds = assignIds(smokeList, "H");
  const smokes: NSmoke[] = [];
  smokeList.forEach((item, i) => {
    const r = obj(item);
    const volume = oneOf(r.volume, SmokeVolumeSchema.options, "moderate");
    const id = smokeIds[i];
    if (volume === "none") return;
    const drift = num(r.drift_deg, -1);
    const color = oneOf(r.color, SmokeColorSchema.options, "gray");
    smokes.push({
      id,
      x: coord(r.x),
      y: coord(r.y),
      z: height(r.z, 0),
      driftDeg: drift < 0 ? null : normalizeDeg(drift),
      volume,
      color: color === "none" || color === "unknown" ? "gray" : color,
    });
  });

  const personList = arr(root.people);
  const personIds = assignIds(personList, "P");
  const people: NPerson[] = personList.map((item, i) => {
    const r = obj(item);
    const status = oneOf(r.status, PersonStatusSchema.options, "unknown");
    const sid = str(r.structure_id);
    const s = sid ? structById.get(sid) : undefined;
    const count = Math.round(num(r.count, 0));
    const placed = placePerson(r, s, status, Math.round(num(r.floor, 0)));
    return {
      id: personIds[i],
      status,
      count: count >= 1 ? Math.min(count, 999) : 0,
      structureId: s ? s.id : null,
      floor: placed.floor,
      x: placed.x,
      y: placed.y,
      z: placed.z,
      confidence: oneOf(r.confidence, CONFIDENCES, "low"),
      note: str(r.note),
      evidence: normalizeEvidence(r.evidence),
      risk: personRisk(status),
    };
  });

  const vehicleList = arr(root.vehicles);
  const vehicleIds = assignIds(vehicleList, "V");
  const vehicles: NVehicle[] = vehicleList.map((item, i) => {
    const r = obj(item);
    const kind = oneOf(r.kind, VehicleKindSchema.options, "other");
    const state = oneOf(r.state, VehicleStateSchema.options, "unknown");
    const dim = VEHICLE_DIMENSIONS[kind];
    return {
      id: vehicleIds[i],
      kind,
      state,
      x: coord(r.x),
      y: coord(r.y),
      rotationDeg: normalizeDeg(num(r.rotation_deg, 0)),
      length: positive(r.length_m, dim.l, 0.8, 30).value,
      width: positive(r.width_m, dim.w, 0.4, 4).value,
      height: dim.h,
      entrapment: bool(r.entrapment_suspected),
      burning: bool(r.burning) || state === "burning",
      note: str(r.note),
    };
  });

  const hazardList = arr(root.hazards);
  const hazardIds = assignIds(hazardList, "Z");
  const hazards: NHazard[] = hazardList.map((item, i) => {
    const r = obj(item);
    const severity = oneOf(r.severity, HazardSeveritySchema.options, "medium");
    return {
      id: hazardIds[i],
      kind: oneOf(r.kind, HazardKindSchema.options, "other"),
      x: coord(r.x),
      y: coord(r.y),
      z: height(r.z, 0),
      radius: positive(r.radius_m, HAZARD_RADIUS[severity], 1, 300).value,
      severity,
      note: str(r.note),
    };
  });

  const accessList = arr(root.access_points);
  const accessIds = assignIds(accessList, "A");
  const access: NAccess[] = accessList.map((item, i) => {
    const r = obj(item);
    return {
      id: accessIds[i],
      kind: oneOf(r.kind, AccessPointKindSchema.options, "other"),
      x: coord(r.x),
      y: coord(r.y),
      label: str(r.label),
      note: str(r.note),
    };
  });

  const roadList = arr(root.roads);
  const roadIds = assignIds(roadList, "R");
  const roads: NRoad[] = [];
  roadList.forEach((item, i) => {
    const r = obj(item);
    const id = roadIds[i];
    const x1 = coord(r.x1);
    const y1 = coord(r.y1);
    const x2 = coord(r.x2);
    const y2 = coord(r.y2);
    const length = Math.hypot(x2 - x1, y2 - y1);
    if (!(length >= 0.5)) return;
    roads.push({
      id,
      name: str(r.name),
      x1,
      y1,
      x2,
      y2,
      width: positive(r.width_m, 7, 2, 80).value,
      blocked: bool(r.blocked),
      length,
    });
  });

  const cameras: NCamera[] = [];
  const seenCam = new Set<string>();
  for (const item of arr(root.cameras)) {
    const r = obj(item);
    const ref = str(r.media_ref);
    if (!ref || seenCam.has(ref)) continue;
    seenCam.add(ref);
    const facing = num(r.facing_deg, -1);
    cameras.push({
      mediaRef: ref,
      x: coord(r.x),
      y: coord(r.y),
      z: height(r.z, 1.6),
      facingDeg: facing < 0 ? null : normalizeDeg(facing),
      confidence: oneOf(r.confidence, CONFIDENCES, "low"),
      origin: "scene",
      mediaId: null,
      source: null,
      mediaKind: null,
      posterUrl: null,
    });
  }

  const annotations: NAnnotation[] = [];
  arr(root.annotations).forEach((item, i) => {
    const r = obj(item);
    const text = str(r.text);
    if (!text) return;
    annotations.push({ id: `N${i + 1}`, x: coord(r.x), y: coord(r.y), z: height(r.z, 0), text });
  });

  const uncertaintyNotes = arr(root.uncertainty_notes).map(str).filter(Boolean);
  const axis = num(ground.street_axis_deg, -1);

  const primary = structures.find((s) => s.role === "involved") ?? structures[0] ?? null;
  let focus: XY;
  if (primary) focus = { x: primary.x, y: primary.y };
  else if (fires[0]) focus = { x: fires[0].x, y: fires[0].y };
  else {
    const pts = [...people, ...vehicles, ...hazards, ...access];
    focus = pts.length
      ? { x: pts.reduce((a, p) => a + p.x, 0) / pts.length, y: pts.reduce((a, p) => a + p.y, 0) / pts.length }
      : { x: 0, y: 0 };
  }

  return {
    description: str(root.description),
    streetAxisDeg: axis < 0 ? null : normalizeDeg(axis) % 180,
    groundNotes: str(ground.notes),
    roads,
    structures,
    fires,
    smokes,
    people,
    vehicles,
    hazards,
    access,
    cameras,
    annotations,
    uncertaintyNotes,
    confidence: oneOf(root.confidence, CONFIDENCES, "low"),
    primaryId: primary ? primary.id : null,
    // Sin estructura: vista "Frente" desde el sur mirando al norte.
    frontHeadingDeg: primary ? primary.rotationDeg : 180,
    focus,
  };
}

/* ───────────────────── Cámaras de los medios y drones ───────────────────── */

export type MediaLike = Pick<
  MediaView,
  "id" | "label" | "source" | "kind" | "lat" | "lng" | "heading_deg" | "accuracy_m" | "frames"
> & { urls?: Partial<MediaView["urls"]> | null };

function posterOf(m: MediaLike): string | null {
  const u = m.urls;
  if (!u) return null;
  if (typeof u.poster === "string" && u.poster) return u.poster;
  const f = Array.isArray(u.frames) ? u.frames[0] : undefined;
  return f && typeof f.url === "string" ? f.url : null;
}

function gpsConfidence(accuracy: number | null): Confidence {
  if (accuracy === null || !Number.isFinite(accuracy)) return "low";
  if (accuracy <= 15) return "high";
  if (accuracy <= 50) return "medium";
  return "low";
}

/**
 * Cámaras para dibujar: las que estimó la IA (enriquecidas con el medio) y, para
 * medios con GPS que la escena no trae, una cámara en su posición GPS real.
 */
export function deriveCameras(scene: NormScene, media: readonly MediaLike[], origin: LatLng | null): NCamera[] {
  const byLabel = new Map<string, MediaLike>();
  for (const m of media) if (m && typeof m.label === "string" && m.label) byLabel.set(m.label, m);
  const out: NCamera[] = scene.cameras.map((c) => {
    const m = byLabel.get(c.mediaRef);
    return m
      ? { ...c, mediaId: m.id, source: m.source, mediaKind: m.kind, posterUrl: posterOf(m) }
      : c;
  });
  const have = new Set(out.map((c) => c.mediaRef));
  const originOk = origin !== null && isValidLatLng(origin.lat, origin.lng);
  if (!originOk) return out;
  for (const m of media) {
    if (!m || !m.label || have.has(m.label)) continue;
    let lat = m.lat;
    let lng = m.lng;
    let z = 1.6;
    let heading = m.heading_deg;
    const frames = Array.isArray(m.frames) ? m.frames : [];
    if (!isValidLatLng(lat, lng)) {
      const f = frames.find((fr) => isValidLatLng(fr.lat, fr.lng));
      if (!f) continue;
      lat = f.lat;
      lng = f.lng;
      z = height(f.alt_m, 1.6);
      heading = f.heading_deg ?? heading;
    } else if (m.source === "drone") {
      const f = frames.find((fr) => typeof fr.alt_m === "number");
      if (f) z = height(f.alt_m, 30);
    }
    const p = toLocal(origin, { lat: lat as number, lng: lng as number });
    if (!(Math.hypot(p.x, p.y) <= CAMERA_MAX_DISTANCE)) continue;
    have.add(m.label);
    out.push({
      mediaRef: m.label,
      x: clamp(p.x, -COORD_LIMIT, COORD_LIMIT),
      y: clamp(p.y, -COORD_LIMIT, COORD_LIMIT),
      z,
      facingDeg: typeof heading === "number" && Number.isFinite(heading) ? normalizeDeg(heading) : null,
      confidence: gpsConfidence(m.accuracy_m),
      origin: "gps",
      mediaId: m.id,
      source: m.source,
      mediaKind: m.kind,
      posterUrl: posterOf(m),
    });
  }
  return out;
}

export type MissionLike = Pick<DroneMission, "id" | "label" | "status" | "mode" | "last" | "track">;

const MAX_TRACK_POINTS = 240;

/** Drones con traza y posición actual en coordenadas locales. */
export function deriveDrones(missions: readonly MissionLike[], origin: LatLng | null): NDrone[] {
  if (!origin || !isValidLatLng(origin.lat, origin.lng)) return [];
  const out: NDrone[] = [];
  missions.forEach((m, i) => {
    if (!m) return;
    const pts = (Array.isArray(m.track) ? m.track : []).filter((p) => p && isValidLatLng(p.lat, p.lng));
    const last = m.last && isValidLatLng(m.last.lat, m.last.lng) ? m.last : pts[pts.length - 1];
    if (!last) return;
    const step = Math.max(1, Math.ceil(pts.length / MAX_TRACK_POINTS));
    const sampled = pts.filter((_, k) => k % step === 0 || k === pts.length - 1);
    const local = (p: { lat: number; lng: number; alt_m: number }) => {
      const xy = toLocal(origin, p);
      return {
        x: clamp(xy.x, -3 * COORD_LIMIT, 3 * COORD_LIMIT),
        y: clamp(xy.y, -3 * COORD_LIMIT, 3 * COORD_LIMIT),
        z: height(p.alt_m, 0),
      };
    };
    const cur = local(last);
    out.push({
      id: m.id || `D${i + 1}`,
      label: m.label || `D${i + 1}`,
      status: m.status,
      mode: m.mode,
      ...cur,
      headingDeg: normalizeDeg(num(last.heading_deg, 0)),
      track: sampled.map(local),
      batteryPct: typeof last.battery_pct === "number" ? last.battery_pct : null,
      speedMs: typeof last.speed_ms === "number" ? last.speed_ms : null,
      active: m.status !== "landed" && m.status !== "aborted",
      at: typeof last.at === "string" ? last.at : null,
    });
  });
  return out;
}

/* ─────────────────────────────── Encuadre ─────────────────────────────── */

type P3 = { x: number; y: number; z?: number };

function contentPoints(scene: NormScene, cameras: readonly NCamera[]): P3[] {
  const pts: P3[] = [];
  for (const s of scene.structures) {
    for (const c of footprintCorners(footprintOf(s))) pts.push({ ...c, z: s.height + s.roofHeight });
  }
  for (const f of scene.fires) {
    pts.push({ x: f.x - f.radius, y: f.y - f.radius, z: f.z + f.radius });
    pts.push({ x: f.x + f.radius, y: f.y + f.radius, z: f.z });
  }
  for (const p of scene.people) pts.push({ x: p.x, y: p.y, z: p.z + 2 });
  for (const v of scene.vehicles) {
    const r = Math.max(v.length, v.width) / 2;
    pts.push({ x: v.x - r, y: v.y - r }, { x: v.x + r, y: v.y + r, z: v.height });
  }
  for (const h of scene.hazards) {
    const r = Math.min(h.radius, 12);
    pts.push({ x: h.x - r, y: h.y - r, z: h.z }, { x: h.x + r, y: h.y + r });
  }
  for (const a of scene.access) pts.push(a);
  for (const s of scene.smokes) pts.push(s);
  for (const n of scene.annotations) pts.push(n);
  for (const c of cameras) pts.push(c);
  return pts;
}

/**
 * Caja para el encuadre automático: contenido de la escena dentro de
 * FRAME_RADIUS del foco (los valores atípicos no alejan la cámara).
 */
export function frameBounds(scene: NormScene, cameras: readonly NCamera[], drones: readonly NDrone[]): Bounds {
  const near = (p: P3) => Math.hypot(p.x - scene.focus.x, p.y - scene.focus.y) <= FRAME_RADIUS;
  let pts = contentPoints(scene, cameras).filter(near);
  if (pts.length === 0) {
    const roadPts = scene.roads.map((r) => ({ x: (r.x1 + r.x2) / 2, y: (r.y1 + r.y2) / 2 }));
    pts = [...roadPts, ...drones.map((d) => ({ x: d.x, y: d.y }))].filter(near);
  }
  const b = boundsOf(pts) ?? {
    minX: scene.focus.x,
    maxX: scene.focus.x,
    minY: scene.focus.y,
    maxY: scene.focus.y,
    minZ: 0,
    maxZ: 0,
  };
  return padBounds(b, 6, 15);
}

/** Caja de todo lo que se dibuja sobre el suelo (calles acotadas a ±400 m del foco). */
export function extentBounds(scene: NormScene, cameras: readonly NCamera[], frame: Bounds): Bounds {
  const lim = 400;
  const cl = (v: number, c: number) => clamp(v, c - lim, c + lim);
  const pts: P3[] = [];
  for (const r of scene.roads) {
    pts.push({ x: cl(r.x1, scene.focus.x), y: cl(r.y1, scene.focus.y) });
    pts.push({ x: cl(r.x2, scene.focus.x), y: cl(r.y2, scene.focus.y) });
  }
  for (const p of contentPoints(scene, cameras)) pts.push({ x: cl(p.x, scene.focus.x), y: cl(p.y, scene.focus.y) });
  const b = boundsOf(pts);
  return b ? unionBounds(frame, b) : frame;
}

/** Arma el modelo de dibujo completo. */
export function buildSceneView(
  scene: NormScene,
  media: readonly MediaLike[],
  missions: readonly MissionLike[],
  origin: LatLng | null,
): SceneView {
  const cameras = deriveCameras(scene, media, origin);
  const drones = deriveDrones(missions, origin);
  return composeView(scene, cameras, drones);
}

export function composeView(scene: NormScene, cameras: NCamera[], drones: NDrone[]): SceneView {
  const frame = frameBounds(scene, cameras, drones);
  return { scene, cameras, drones, frame, extent: extentBounds(scene, cameras, frame) };
}

/* ───────────────────────────── Búsqueda ───────────────────────────── */

export type EntityRef =
  | { kind: "structure"; item: NStructure }
  | { kind: "fire"; item: NFire }
  | { kind: "smoke"; item: NSmoke }
  | { kind: "person"; item: NPerson }
  | { kind: "vehicle"; item: NVehicle }
  | { kind: "hazard"; item: NHazard }
  | { kind: "access"; item: NAccess }
  | { kind: "road"; item: NRoad }
  | { kind: "camera"; item: NCamera }
  | { kind: "drone"; item: NDrone };

/** Encuentra la entidad seleccionada en el modelo (null si ya no existe). */
export function findEntity(view: SceneView, sel: { kind: EntityRef["kind"]; id: string } | null | undefined): EntityRef | null {
  if (!sel) return null;
  const s = view.scene;
  switch (sel.kind) {
    case "structure": {
      const item = s.structures.find((e) => e.id === sel.id);
      return item ? { kind: "structure", item } : null;
    }
    case "fire": {
      const item = s.fires.find((e) => e.id === sel.id);
      return item ? { kind: "fire", item } : null;
    }
    case "smoke": {
      const item = s.smokes.find((e) => e.id === sel.id);
      return item ? { kind: "smoke", item } : null;
    }
    case "person": {
      const item = s.people.find((e) => e.id === sel.id);
      return item ? { kind: "person", item } : null;
    }
    case "vehicle": {
      const item = s.vehicles.find((e) => e.id === sel.id);
      return item ? { kind: "vehicle", item } : null;
    }
    case "hazard": {
      const item = s.hazards.find((e) => e.id === sel.id);
      return item ? { kind: "hazard", item } : null;
    }
    case "access": {
      const item = s.access.find((e) => e.id === sel.id);
      return item ? { kind: "access", item } : null;
    }
    case "road": {
      const item = s.roads.find((e) => e.id === sel.id);
      return item ? { kind: "road", item } : null;
    }
    case "camera": {
      const item = view.cameras.find((e) => e.mediaRef === sel.id);
      return item ? { kind: "camera", item } : null;
    }
    case "drone": {
      const item = view.drones.find((e) => e.id === sel.id);
      return item ? { kind: "drone", item } : null;
    }
  }
}

/** true si la escena tiene algo animable (fuego, humo, personas en riesgo, atrapamiento). */
export function hasAnimatedContent(view: SceneView): boolean {
  const s = view.scene;
  return (
    s.fires.length > 0 ||
    s.smokes.length > 0 ||
    s.people.some((p) => p.risk === "critical") ||
    s.vehicles.some((v) => v.entrapment || v.burning)
  );
}

/* ───────────────────────────── Claves estables ───────────────────────────── */

/** Hash FNV-1a de 32 bits en base 36 (para detectar cambios de contenido baratos). */
export function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** Clave de los datos de medios que afectan a las cámaras. */
export function mediaKey(media: readonly MediaLike[]): string {
  return media
    .map((m) =>
      [m.id, m.label, m.source, m.kind, m.lat, m.lng, m.heading_deg, m.accuracy_m, posterOf(m), m.frames?.length ?? 0].join(
        ",",
      ),
    )
    .join(";");
}

/** Clave de los datos de misiones que afectan a los drones. */
export function missionsKey(missions: readonly MissionLike[]): string {
  return missions
    .map((m) => [m.id, m.label, m.status, m.mode, m.last?.at, m.last?.lat, m.last?.lng, m.last?.alt_m, m.track?.length ?? 0].join(","))
    .join(";");
}
