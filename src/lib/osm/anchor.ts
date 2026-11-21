/**
 * Anclaje de la escena inferida al entorno real de OpenStreetMap (función pura).
 *
 * El origen de la escena suele ser el GPS del teléfono que grabó (error de 5–20 m), así
 * que la IA puede dejar un choque entre dos edificios o una casa sobre la calle. Aquí se
 * corrige con un movimiento RÍGIDO de toda la escena (traslación + giro opcional):
 *  - Tránsito / vehículo: los vehículos van al eje de la calle vehicular más cercana
 *    (o a la intersección, si la escena habla de un cruce) y nunca dentro de un edificio.
 *  - Incendio estructural: la estructura involucrada calza con su huella OSM.
 * Idempotente: si la escena ya calza, no cambia nada; la nota de ajuste se reemplaza.
 */
import type { IncidentType, SceneModel } from "@/lib/domain";
import type { OsmBuilding, OsmContext, OsmRoad, OsmXY } from "./types";

/** Prefijo fijo de la nota de ajuste (se reemplaza en cada fusión, no se acumula). */
export const ANCHOR_NOTE_PREFIX = "Ubicación ajustada al mapa real (OpenStreetMap):";

export interface AnchorAdjustment {
  /** Desplazamiento del punto de anclaje (m, Este / Norte). */
  dx: number;
  dy: number;
  /** Giro horario aplicado a toda la escena (grados). */
  rotation_deg: number;
  /** Explicación en español (la misma que queda en uncertainty_notes). */
  reason: string;
  /** Nombre de la calle, cruce o huella a la que se ancló; null si no tiene nombre. */
  target: string | null;
}

export interface AnchorResult {
  scene: SceneModel;
  adjustment: AnchorAdjustment | null;
  /** Aviso (ya agregado a uncertainty_notes) cuando la escena no calza y no se movió. */
  warning?: string | null;
}

/** Cámara con GPS propio: no se mueve con la escena y limita cuánto puede moverse el resto. */
export interface FixedCamera {
  media_ref: string;
  /** Lo máximo (m) que la escena puede moverse respecto de esta cámara (precisión GPS + holgura). */
  tolerance_m: number;
}

export interface AnchorOptions {
  /** Desplazamiento máximo para escenas de tránsito cuando la calle de la escena coincide por nombre (m). */
  maxShiftM?: number;
  /** Distancia máxima de la estructura a su huella OSM (m). */
  maxStructureDistM?: number;
  /** Cámaras ubicadas por GPS (quedan donde están). */
  fixedCameras?: readonly FixedCamera[];
  /** Escena guardada antes de esta fusión: para conservar la nota de ajuste si la IA la omitió. */
  previous?: SceneModel | null;
}

/** Prefijo del aviso cuando la escena no calza con el mapa y no se movió (también se reemplaza). */
export const ANCHOR_WARNING_PREFIX = "Ubicación por verificar (OpenStreetMap):";

const DEFAULT_MAX_SHIFT = 80;
/** Sin coincidencia de nombre, solo se corrige el error típico del GPS (m). */
const NO_NAME_MAX_SHIFT = 30;
/** Radio en que se buscan en OSM las calles nombradas en la escena (m). */
const NAME_SEARCH_M = 200;
/** Ancho de calzada (m) desde el que la calle de la escena no puede ser un pasaje. */
const WIDE_ROAD_M = 10;
/** El anclaje anterior se considera vigente si el punto de anclaje se movió menos que esto (m). */
const CARRY_NOTE_M = 3;
const DEFAULT_MAX_STRUCTURE_DIST = 50;
/** Holgura sobre media calzada para considerar que un punto está sobre la calle (m). */
const ROAD_TOLERANCE = 1.5;
/** Por debajo de esto se considera que la estructura ya calza. */
const FIT_SHIFT_M = 1.5;
const FIT_ROT_DEG = 3;
/** Ángulo mínimo entre dos vías para hablar de cruce. */
const MIN_CROSS_DEG = 30;

/** Media calzada típica por clase de OpenMapTiles (m). Solo estas clases son vehiculares. */
const HALF_WIDTH: Record<string, number> = {
  motorway: 9,
  trunk: 8,
  primary: 7,
  secondary: 6,
  tertiary: 5.5,
  minor: 4,
  service: 3,
  busway: 3.5,
};
/** Penalización (m) al elegir calle: un choque es menos probable en un pasaje de servicio. */
const CLASS_PENALTY: Record<string, number> = { service: 10, busway: 6, minor: 3 };

/* ───────────────────────────── Geometría ───────────────────────────── */

const RAD = Math.PI / 180;
const r2 = (v: number) => Math.round(v * 100) / 100;
const norm360 = (d: number) => ((d % 360) + 360) % 360;
/** Lleva un ángulo a [-90, 90): diferencia entre ejes sin sentido. */
const wrap180 = (d: number) => ((((d + 90) % 180) + 180) % 180) - 90;
/** Lleva un ángulo a [-45, 45): diferencia entre rectángulos. */
const wrap90 = (d: number) => ((((d + 45) % 90) + 90) % 90) - 45;
const bearingOf = (a: OsmXY, b: OsmXY) => norm360(Math.atan2(b.x - a.x, b.y - a.y) / RAD);
const dist = (a: OsmXY, b: OsmXY) => Math.hypot(a.x - b.x, a.y - b.y);

function closestOnSegment(p: OsmXY, a: OsmXY, b: OsmXY): OsmXY {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return { x: a.x + t * dx, y: a.y + t * dy };
}

function pointInRing(p: OsmXY, ring: readonly OsmXY[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function inBuilding(p: OsmXY, b: OsmBuilding): boolean {
  const [outer, ...holes] = b.rings;
  return !!outer && pointInRing(p, outer) && !holes.some((h) => pointInRing(p, h));
}

function distToRing(p: OsmXY, ring: readonly OsmXY[]): number {
  let d = Infinity;
  for (let i = 0; i < ring.length; i++) d = Math.min(d, dist(p, closestOnSegment(p, ring[i], ring[(i + 1) % ring.length])));
  return d;
}

function ringArea(ring: readonly OsmXY[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/** Centroide de área del anillo exterior. */
function ringCentroid(ring: readonly OsmXY[]): OsmXY {
  const a = ringArea(ring);
  if (Math.abs(a) < 1e-6) return { x: ring.reduce((s, p) => s + p.x, 0) / ring.length, y: ring.reduce((s, p) => s + p.y, 0) / ring.length };
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    const f = p.x * q.y - q.x * p.y;
    cx += (p.x + q.x) * f;
    cy += (p.y + q.y) * f;
  }
  return { x: cx / (6 * a), y: cy / (6 * a) };
}

function convexHull(pts: readonly OsmXY[]): OsmXY[] {
  const s = pts.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  if (s.length < 3) return s;
  const cross = (o: OsmXY, a: OsmXY, b: OsmXY) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: OsmXY[] = [];
  for (const p of s) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: OsmXY[] = [];
  for (let i = s.length - 1; i >= 0; i--) {
    const p = s[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** Rectángulo de área mínima: rumbo de un lado y largos (a lo largo / a través de ese lado). */
function minAreaRect(ring: readonly OsmXY[]): { bearing: number; along: number; across: number } | null {
  const hull = convexHull(ring);
  if (hull.length < 3) return null;
  let best: { bearing: number; along: number; across: number; area: number } | null = null;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const len = dist(a, b);
    if (len < 1e-6) continue;
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const p of hull) {
      const u = (p.x - a.x) * ux + (p.y - a.y) * uy;
      const v = -(p.x - a.x) * uy + (p.y - a.y) * ux;
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
    }
    const area = (maxU - minU) * (maxV - minV);
    if (!best || area < best.area) best = { bearing: bearingOf(a, b), along: maxU - minU, across: maxV - minV, area };
  }
  return best && { bearing: best.bearing, along: best.along, across: best.across };
}

/* ───────────────────────────── Nombres ───────────────────────────── */

const ROAD_WORDS = new Set(["avenida", "av", "avda", "calle", "pasaje", "psje", "pje", "camino", "autopista", "de", "del", "la", "el", "los", "las"]);

function nameCore(name: string): string {
  return name
    .replace(/\(.*?\)/g, " ")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w && !ROAD_WORDS.has(w))
    .join(" ");
}

/** true si dos nombres de vía se refieren a la misma calle ("Av. Macul" ~ "Avenida Macul"). */
export function sameRoadName(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const x = nameCore(a);
  const y = nameCore(b);
  if (!x || !y) return false;
  return x === y || ` ${x} `.includes(` ${y} `) || ` ${y} `.includes(` ${x} `);
}

/** Palabras que no identifican una calle ("Calzada norte", "Vía principal"…). */
const GENERIC_ROAD_WORDS = new Set([
  "calzada", "via", "vereda", "acceso", "lateral", "principal", "secundaria", "interior", "local", "servicio",
  "norte", "sur", "oriente", "poniente", "este", "oeste", "central", "bandejon", "cruce", "esquina",
  "sin", "nombre", "desconocida", "desconocido", "frente", "costado", "y", "con", "hacia", "n", "s", "e", "o",
]);

/** true si el nombre parece el de una calle real (no una descripción genérica). */
function isProperRoadName(name: string | null | undefined): boolean {
  if (!name) return false;
  return nameCore(name)
    .split(" ")
    .some((w) => w.length > 1 && !GENERIC_ROAD_WORDS.has(w) && !/^\d+$/.test(w));
}

/* ───────────────────────────── Transformación rígida ───────────────────────────── */

interface Rigid {
  pivot: OsmXY;
  target: OsmXY;
  /** Giro horario (grados). */
  theta: number;
}

function applyPoint(t: Rigid, p: OsmXY): OsmXY {
  const c = Math.cos(t.theta * RAD);
  const s = Math.sin(t.theta * RAD);
  const x = p.x - t.pivot.x;
  const y = p.y - t.pivot.y;
  return { x: t.target.x + x * c + y * s, y: t.target.y - x * s + y * c };
}

const camKey = (s: string) => s.trim().toUpperCase();

/**
 * Aplica el movimiento a todas las entidades; rumbos desconocidos (-1) se mantienen. Las
 * cámaras con GPS (`fixed`) no se mueven: su posición es un dato medido, no inferido.
 */
function transformScene(scene: SceneModel, t: Rigid, fixed: readonly FixedCamera[] = []): SceneModel {
  const fixedKeys = new Set(fixed.map((f) => camKey(f.media_ref)));
  const P = <T extends { x: number; y: number }>(o: T): T => {
    const p = applyPoint(t, o);
    return { ...o, x: r2(p.x), y: r2(p.y) };
  };
  const B = (d: number) => r2(norm360(d + t.theta));
  const known = (d: number) => (d >= 0 ? B(d) : d);
  return {
    ...scene,
    ground: {
      ...scene.ground,
      street_axis_deg:
        scene.ground.street_axis_deg >= 0 ? r2(((scene.ground.street_axis_deg + t.theta) % 180 + 180) % 180) : scene.ground.street_axis_deg,
    },
    roads: scene.roads.map((r) => {
      const a = applyPoint(t, { x: r.x1, y: r.y1 });
      const b = applyPoint(t, { x: r.x2, y: r.y2 });
      return { ...r, x1: r2(a.x), y1: r2(a.y), x2: r2(b.x), y2: r2(b.y) };
    }),
    structures: scene.structures.map((s) => ({ ...P(s), rotation_deg: B(s.rotation_deg) })),
    fire_zones: scene.fire_zones.map(P),
    smoke_plumes: scene.smoke_plumes.map((s) => ({ ...P(s), drift_deg: known(s.drift_deg) })),
    people: scene.people.map(P),
    vehicles: scene.vehicles.map((v) => ({ ...P(v), rotation_deg: B(v.rotation_deg) })),
    hazards: scene.hazards.map(P),
    access_points: scene.access_points.map(P),
    cameras: scene.cameras.map((c) => (fixedKeys.has(camKey(c.media_ref)) ? c : { ...P(c), facing_deg: known(c.facing_deg) })),
    annotations: scene.annotations.map(P),
  };
}

/**
 * Etiqueta de la primera cámara con GPS respecto de la cual la escena se movería más que
 * su tolerancia (el teléfono estaba donde dice su GPS), o null si el movimiento es compatible.
 */
function gpsConflict(scene: SceneModel, t: Rigid, fixed: readonly FixedCamera[]): string | null {
  for (const f of fixed) {
    const cam = scene.cameras.find((c) => camKey(c.media_ref) === camKey(f.media_ref));
    if (cam && dist(applyPoint(t, cam), cam) > f.tolerance_m) return cam.media_ref;
  }
  return null;
}

/** Quita las notas de anclaje (ajuste y aviso) que dejó una pasada anterior. */
const withoutAnchorNotes = (notes: readonly string[]) =>
  notes.filter((n) => !n.startsWith(ANCHOR_NOTE_PREFIX) && !n.startsWith(ANCHOR_WARNING_PREFIX));

/** Escena sin moverse, con un aviso honesto (reemplaza el aviso y el ajuste anteriores). */
function warn(scene: SceneModel, text: string): AnchorResult {
  const note = `${ANCHOR_WARNING_PREFIX} ${text.trim()}`;
  return { scene: { ...scene, uncertainty_notes: [...withoutAnchorNotes(scene.uncertainty_notes), note] }, adjustment: null, warning: note };
}

/** La escena ya calza: sin cambios, salvo quitar un aviso obsoleto. */
function fits(scene: SceneModel): AnchorResult {
  if (!scene.uncertainty_notes.some((n) => n.startsWith(ANCHOR_WARNING_PREFIX))) return { scene, adjustment: null };
  return {
    scene: { ...scene, uncertainty_notes: scene.uncertainty_notes.filter((n) => !n.startsWith(ANCHOR_WARNING_PREFIX)) },
    adjustment: null,
  };
}

const CARDINAL_ES = ["al norte", "al nororiente", "al oriente", "al suroriente", "al sur", "al surponiente", "al poniente", "al norponiente"];

function describeMove(t: Rigid): string {
  const d = dist(t.pivot, t.target);
  const parts: string[] = [];
  if (d >= 0.5) parts.push(`escena desplazada ${Math.round(d)} m ${CARDINAL_ES[Math.round(bearingOf(t.pivot, t.target) / 45) % 8]}`);
  if (Math.abs(t.theta) >= 0.5) {
    const g = Math.round(Math.abs(t.theta));
    parts.push(`${parts.length ? "y " : "escena "}girada ${g}° en sentido ${t.theta > 0 ? "horario" : "antihorario"}`);
  }
  return parts.join(" ");
}

function finish(scene: SceneModel, t: Rigid, reason: string, target: string | null, fixed: readonly FixedCamera[]): AnchorResult {
  const moved = transformScene(scene, t, fixed);
  const kept = fixed.filter((f) => scene.cameras.some((c) => camKey(c.media_ref) === camKey(f.media_ref)));
  const gpsNote = kept.length ? `; ${kept.map((f) => f.media_ref).join(", ")} se mantiene${kept.length > 1 ? "n" : ""} en su posición GPS` : "";
  const body = (reason.trim() || "escena ajustada.").replace(/\.$/, "");
  const note = `${ANCHOR_NOTE_PREFIX} ${body}${gpsNote}.`;
  return {
    scene: { ...moved, uncertainty_notes: [...withoutAnchorNotes(scene.uncertainty_notes), note] },
    adjustment: { dx: r2(t.target.x - t.pivot.x), dy: r2(t.target.y - t.pivot.y), rotation_deg: r2(t.theta), reason: note, target },
  };
}

/* ───────────────────────────── Escenas de tránsito ───────────────────────────── */

interface RoadSeg {
  road: OsmRoad;
  a: OsmXY;
  b: OsmXY;
  half: number;
}

function vehicularSegments(roads: readonly OsmRoad[]): RoadSeg[] {
  const out: RoadSeg[] = [];
  for (const road of roads) {
    const half = HALF_WIDTH[road.cls];
    if (half === undefined) continue;
    for (let i = 0; i + 1 < road.points.length; i++) out.push({ road, a: road.points[i], b: road.points[i + 1], half });
  }
  return out;
}

function onRoad(p: OsmXY, segs: readonly RoadSeg[]): boolean {
  return segs.some((s) => dist(p, closestOnSegment(p, s.a, s.b)) <= s.half + ROAD_TOLERANCE);
}

function centroid(pts: readonly OsmXY[]): OsmXY {
  return { x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length };
}

/** La escena de tránsito calza: vehículos sobre una calzada y ninguno dentro de un edificio. */
function vehiclesFit(scene: SceneModel, segs: readonly RoadSeg[], buildings: readonly OsmBuilding[]): boolean {
  if (!onRoad(centroid(scene.vehicles), segs)) return false;
  return !scene.vehicles.some((v) => buildings.some((b) => inBuilding(v, b)));
}

interface SceneRoad {
  name: string;
  a: OsmXY;
  b: OsmXY;
  axis: number;
}

function sceneRoads(scene: SceneModel): SceneRoad[] {
  return scene.roads
    .map((r) => ({ name: r.name, a: { x: r.x1, y: r.y1 }, b: { x: r.x2, y: r.y2 } }))
    .filter((r) => dist(r.a, r.b) >= 5)
    .map((r) => ({ ...r, axis: bearingOf(r.a, r.b) }));
}

/** Intersección de dos segmentos (con holgura `slack` m en los extremos). */
function segmentCross(a: OsmXY, b: OsmXY, c: OsmXY, d: OsmXY, slack: number): OsmXY | null {
  const rx = b.x - a.x;
  const ry = b.y - a.y;
  const sx = d.x - c.x;
  const sy = d.y - c.y;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / den;
  const u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / den;
  const et = slack / Math.hypot(rx, ry);
  const eu = slack / Math.hypot(sx, sy);
  if (t < -et || t > 1 + et || u < -eu || u > 1 + eu) return null;
  return { x: a.x + t * rx, y: a.y + t * ry };
}

const crossAngle = (a: number, b: number) => Math.abs(wrap180(a - b));
/** Distancia (m) a la que dos extremos de tramo se consideran el mismo nodo. */
const JOIN_M = 1;

interface Junction {
  at: OsmXY;
  r1: OsmRoad;
  r2: OsmRoad;
  axis1: number;
  axis2: number;
}

/** Cruces entre vías vehiculares distintas cerca de `center` (deduplicados a 3 m). */
function junctions(segs: readonly RoadSeg[], center: OsmXY, radius: number): Junction[] {
  const near = segs.filter((s) => dist(center, closestOnSegment(center, s.a, s.b)) <= radius);
  const out: Junction[] = [];
  const isEnd = (p: OsmXY, s: RoadSeg) => dist(p, s.a) <= JOIN_M || dist(p, s.b) <= JOIN_M;
  for (let i = 0; i < near.length; i++) {
    for (let j = i + 1; j < near.length; j++) {
      const s = near[i];
      const q = near[j];
      // Tramos de una misma polilínea no forman cruce. (OpenFreeMap agrupa muchas vías en
      // un solo rasgo multilínea: polilíneas distintas del mismo rasgo SÍ pueden cruzarse.)
      if (s.road.id === q.road.id) continue;
      // Tramos de la misma calle (mismo nombre) no forman cruce.
      if (s.road.name && s.road.name === q.road.name) continue;
      const axis1 = bearingOf(s.a, s.b);
      const axis2 = bearingOf(q.a, q.b);
      if (crossAngle(axis1, axis2) < MIN_CROSS_DEG) continue;
      const at = segmentCross(s.a, s.b, q.a, q.b, 0.5);
      if (!at || dist(at, center) > radius) continue;
      // Dos polilíneas que solo se empalman extremo con extremo (y nada más llega a ese
      // nodo) son una curva de la misma calle, no un cruce.
      if (isEnd(at, s) && isEnd(at, q) && near.filter((o) => isEnd(at, o)).length <= 2) continue;
      if (out.some((o) => dist(o.at, at) < 3)) continue;
      out.push({ at, r1: s.road, r2: q.road, axis1, axis2 });
    }
  }
  return out;
}

/** Cruces vehiculares de OSM a menos de `radius` m de `center` (diagnóstico y pruebas). */
export function osmJunctions(ctx: OsmContext, center: OsmXY, radius: number): { at: OsmXY; roads: [string | null, string | null] }[] {
  return junctions(vehicularSegments(ctx.roads), center, radius).map((j) => ({ at: j.at, roads: [j.r1.name, j.r2.name] }));
}

interface Candidate {
  rigid: Rigid;
  score: number;
  label: string;
  target: string | null;
}

const roadLabel = (r: OsmRoad) => r.name ?? "una calle sin nombre";
/** Costo (m) de girar la escena: leve hasta 20°, fuerte después (tramos curvos o ramales). */
const rotPenalty = (theta: number) => 0.15 * Math.abs(theta) + 0.5 * Math.max(0, Math.abs(theta) - 20);

function distToPolyline(p: OsmXY, pts: readonly OsmXY[]): number {
  let d = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) d = Math.min(d, dist(p, closestOnSegment(p, pts[i], pts[i + 1])));
  return d;
}

const NARROW_CLASSES = new Set(["minor", "service"]);

function anchorVehicles(scene: SceneModel, ctx: OsmContext, maxShift: number, fixed: readonly FixedCamera[]): AnchorResult {
  const none: AnchorResult = { scene, adjustment: null };
  if (scene.vehicles.length === 0) return none;
  const segs = vehicularSegments(ctx.roads);
  if (segs.length === 0) return none;

  const c = centroid(scene.vehicles);
  const sRoads = sceneRoads(scene);

  // Calles con nombre propio en la escena que no aparecen en OSM cerca: el GPS no calza con
  // la dirección. No se "ancla" a otra calle cualquiera; se avisa.
  const proper = [...new Set(scene.roads.map((r) => r.name).filter(isProperRoadName).map((n) => n.replace(/\s*\(.*?\)/g, "").trim()))];
  const namedNear = ctx.roads.filter((r) => r.name && distToPolyline(c, r.points) <= NAME_SEARCH_M);
  if (proper.length > 0 && !proper.some((n) => namedNear.some((r) => sameRoadName(n, r.name)))) {
    let nearest: { road: OsmRoad; d: number } | null = null;
    for (const s of segs) {
      const d = dist(c, closestOnSegment(c, s.a, s.b));
      if (s.road.name && (!nearest || d < nearest.d)) nearest = { road: s.road, d };
    }
    const hint = nearest ? ` (la calle más cercana es ${nearest.road.name}, a ${Math.round(nearest.d)} m)` : "";
    return warn(
      scene,
      `las calles de la escena (${proper.join(", ")}) no aparecen a menos de ${NAME_SEARCH_M} m del GPS del incidente${hint}; la escena no se movió. Revisar la ubicación del incidente.`,
    );
  }

  const nameHit = (r: OsmRoad) => sRoads.some((s) => sameRoadName(s.name, r.name));
  // Si la escena nombra calles que sí existen cerca, calzar exige estar sobre una de ellas
  // (o sobre un tramo sin nombre): un choque en «Av. Departamental» no calza en otra avenida.
  const fitSegs = proper.length > 0 ? segs.filter((s) => !s.road.name || nameHit(s.road)) : segs;
  if (vehiclesFit(scene, fitSegs, ctx.buildings)) return fits(scene);
  // Calle principal de la escena: la más cercana a los vehículos (o el eje declarado).
  const main = sRoads.slice().sort((p, q) => dist(c, closestOnSegment(c, p.a, p.b)) - dist(c, closestOnSegment(c, q.a, q.b)))[0];
  const mainAxis = main ? main.axis : scene.ground.street_axis_deg >= 0 ? scene.ground.street_axis_deg : null;
  // Avenida ancha (o dos calzadas con el mismo nombre): no puede ser un pasaje ni una calle de servicio.
  const mainWidth = main ? (scene.roads.find((r) => r.name === main.name)?.width_m ?? 0) : 0;
  const twoCarriageways = !!main && sRoads.filter((s) => s.name && sameRoadName(s.name, main.name) && crossAngle(s.axis, main.axis) < 15).length >= 2;
  const sceneWide = mainWidth >= WIDE_ROAD_M || twoCarriageways;
  const classOk = (r: OsmRoad) => !sceneWide || nameHit(r) || !NARROW_CLASSES.has(r.cls);

  const text = [scene.description, scene.ground.notes, ...scene.roads.map((r) => r.name), ...scene.annotations.map((a) => a.text)].join(" ");
  const sceneCrosses = sRoads.some((p, i) => sRoads.some((q, j) => j > i && crossAngle(p.axis, q.axis) >= MIN_CROSS_DEG));
  const wantsJunction = sceneCrosses || /\b(cruce|esquina|intersecci[oó]n)/i.test(text);

  const cands: (Candidate & { limit: number })[] = [];

  // 1) Cruce: el cruce de la escena (o el centro de los vehículos) al cruce OSM más cercano.
  if (wantsJunction) {
    let pivot = c;
    let pair: [SceneRoad, SceneRoad] | null = null;
    for (let i = 0; i < sRoads.length; i++) {
      for (let j = i + 1; j < sRoads.length; j++) {
        const p = sRoads[i];
        const q = sRoads[j];
        if (crossAngle(p.axis, q.axis) < MIN_CROSS_DEG) continue;
        const at = segmentCross(p.a, p.b, q.a, q.b, 20);
        if (!at || dist(at, c) > maxShift) continue;
        if (!pair || dist(at, c) < dist(pivot, c)) {
          pivot = at;
          // La primera del par es la calle de los vehículos (si participa).
          pair = q === main ? [q, p] : [p, q];
        }
      }
    }
    // Si el cruce de la escena es entre dos calles con nombre que existen cerca, el cruce OSM
    // tiene que ser ese mismo (no otro cruce de una de ellas).
    const existsNear = (n: string) => isProperRoadName(n) && namedNear.some((r) => sameRoadName(n, r.name));
    const needBoth = !!pair && existsNear(pair[0].name) && existsNear(pair[1].name);
    for (const jn of junctions(segs, pivot, maxShift)) {
      if (!classOk(jn.r1) && !classOk(jn.r2)) continue;
      if (needBoth && pair) {
        const m = (n: string) => sameRoadName(n, jn.r1.name) || sameRoadName(n, jn.r2.name);
        if (!m(pair[0].name) || !m(pair[1].name)) continue;
      }
      let theta = 0;
      if (pair) {
        // Asignación de calles: por nombre si se puede; si no, la que menos tuerce la segunda.
        const opts = [
          { t: wrap180(jn.axis1 - pair[0].axis), other: jn.axis2, osm: jn.r1 },
          { t: wrap180(jn.axis2 - pair[0].axis), other: jn.axis1, osm: jn.r2 },
        ].map((o) => ({
          ...o,
          err: crossAngle(pair[1].axis + o.t, o.other) - (sameRoadName(pair[0].name, o.osm.name) ? 90 : 0),
        }));
        theta = opts.sort((p, q) => p.err - q.err)[0].t;
      } else if (mainAxis !== null) {
        const t1 = wrap180(jn.axis1 - mainAxis);
        const t2 = wrap180(jn.axis2 - mainAxis);
        theta = Math.abs(t1) <= Math.abs(t2) ? t1 : t2;
      }
      const hits = (nameHit(jn.r1) ? 1 : 0) + (nameHit(jn.r2) ? 1 : 0);
      const label = `${roadLabel(jn.r1)} con ${roadLabel(jn.r2)}`;
      cands.push({
        rigid: { pivot, target: jn.at, theta },
        score: dist(pivot, jn.at) - 15 - 15 * hits + rotPenalty(theta),
        label: `hasta el cruce de ${label}`,
        target: jn.r1.name && jn.r2.name ? label : (jn.r1.name ?? jn.r2.name),
        limit: hits > 0 ? maxShift : Math.min(maxShift, NO_NAME_MAX_SHIFT),
      });
    }
  }

  // 2) Eje de la calle vehicular más cercana.
  for (const s of segs) {
    if (!classOk(s.road)) continue;
    const q = closestOnSegment(c, s.a, s.b);
    const d = dist(c, q);
    const hit = nameHit(s.road);
    const limit = hit ? maxShift : Math.min(maxShift, NO_NAME_MAX_SHIFT);
    if (d > limit) continue;
    const theta = mainAxis !== null ? wrap180(bearingOf(s.a, s.b) - mainAxis) : 0;
    cands.push({
      rigid: { pivot: c, target: q, theta },
      score: d + (CLASS_PENALTY[s.road.cls] ?? 0) - (hit ? 25 : 0) + rotPenalty(theta),
      label: `hasta el eje de ${roadLabel(s.road)}`,
      target: s.road.name,
      limit,
    });
  }

  cands.sort((p, q) => p.score - q.score);
  let blocked: { cam: string; label: string } | null = null;
  for (const cand of cands.slice(0, 80)) {
    if (dist(cand.rigid.pivot, cand.rigid.target) > cand.limit) continue;
    const moved = transformScene(scene, cand.rigid, fixed);
    // Comprobación final: vehículos sobre la calzada y ninguno dentro de un edificio.
    if (!vehiclesFit(moved, fitSegs, ctx.buildings)) continue;
    // Y compatible con el GPS de las cámaras (el teléfono estaba donde dice su GPS).
    const cam = gpsConflict(scene, cand.rigid, fixed);
    if (cam) {
      blocked ??= { cam, label: cand.label };
      continue;
    }
    return finish(scene, cand.rigid, `${describeMove(cand.rigid)} ${cand.label}.`, cand.target, fixed);
  }
  if (blocked) {
    return warn(
      scene,
      `los vehículos no quedan sobre una calzada del mapa y llevarlos ${blocked.label} contradice el GPS de ${blocked.cam}; la escena no se movió.`,
    );
  }
  return warn(scene, `los vehículos no quedan sobre una calzada del mapa y no hay una calle compatible cerca; la escena no se movió.`);
}

/* ───────────────────────────── Incendio estructural ───────────────────────────── */

function mainStructure(scene: SceneModel): SceneModel["structures"][number] | null {
  const involved = scene.structures.filter((s) => s.role === "involved");
  if (!involved.length) return null;
  const fires = (id: string) => scene.fire_zones.filter((f) => f.structure_id === id).length;
  return involved.slice().sort((a, b) => fires(b.id) - fires(a.id) || b.width_m * b.depth_m - a.width_m * a.depth_m)[0];
}

function anchorStructure(scene: SceneModel, ctx: OsmContext, maxDist: number, fixed: readonly FixedCamera[]): AnchorResult {
  const none: AnchorResult = { scene, adjustment: null };
  const s = mainStructure(scene);
  if (!s || ctx.buildings.length === 0) return none;
  const c = { x: s.x, y: s.y };
  const sArea = Math.max(1, s.width_m * s.depth_m);

  let chosen: OsmBuilding | null = null;
  const containing = ctx.buildings.filter((b) => (b.rings[0]?.length ?? 0) >= 3 && inBuilding(c, b));
  if (containing.length) {
    chosen = containing.sort((a, b) => Math.abs(ringArea(a.rings[0])) - Math.abs(ringArea(b.rings[0])))[0];
  } else {
    // Cámara del medio con rumbo conocido: la huella buscada debería estar hacia donde mira.
    const cam = scene.cameras
      .filter((k) => k.facing_deg >= 0)
      .sort((a, b) => dist(a, c) - dist(b, c))[0];
    let best: { b: OsmBuilding; score: number } | null = null;
    for (const b of ctx.buildings) {
      const ring = b.rings[0];
      if (!ring || ring.length < 3) continue;
      const d = distToRing(c, ring);
      if (d > maxDist) continue;
      let score = d + 4 * Math.abs(Math.log(Math.abs(ringArea(ring)) / sArea));
      if (cam) {
        const diff = norm360(bearingOf(cam, ringCentroid(ring)) - cam.facing_deg);
        const off = Math.min(diff, 360 - diff);
        score += off <= 35 ? -8 : 0.2 * (off - 35);
      }
      if (!best || score < best.score) best = { b, score };
    }
    chosen = best?.b ?? null;
  }
  if (!chosen) return none;

  const ring = chosen.rings[0];
  const fArea = Math.abs(ringArea(ring));
  const rect = minAreaRect(ring);
  // Rotación al eje principal de la huella (máx. 45°).
  let theta = 0;
  if (rect) {
    const sLong = s.width_m >= s.depth_m ? s.rotation_deg + 90 : s.rotation_deg;
    const fLong = rect.along >= rect.across ? rect.bearing : rect.bearing + 90;
    const sAspect = Math.max(s.width_m, s.depth_m) / Math.max(0.1, Math.min(s.width_m, s.depth_m));
    const fAspect = Math.max(rect.along, rect.across) / Math.max(0.1, Math.min(rect.along, rect.across));
    if (sAspect >= 1.25 && fAspect >= 1.25) {
      const t = wrap180(fLong - sLong);
      theta = Math.abs(t) <= 45 ? t : 0;
    } else {
      theta = wrap90(rect.bearing - s.rotation_deg);
    }
  }
  // Huella mucho más grande (p. ej. casas pareadas en un solo polígono) que ya contiene la
  // estructura: no se traslada, solo se alinea.
  const bigContainer = containing.length > 0 && fArea > 3 * sArea;
  const target = bigContainer ? c : ringCentroid(ring);
  const rigid: Rigid = { pivot: c, target, theta };
  if (dist(c, target) < FIT_SHIFT_M && Math.abs(theta) < FIT_ROT_DEG) return fits(scene);
  const what = `${s.id}${s.label ? ` (${s.label})` : ""}`;
  const cam = gpsConflict(scene, rigid, fixed);
  if (cam) {
    return warn(
      scene,
      `${what} no calza con la huella más cercana de OpenStreetMap y moverla ${Math.round(dist(c, target))} m contradice el GPS de ${cam}; la escena no se movió.`,
    );
  }
  const how = bigContainer
    ? `para alinear ${what} con la huella de OpenStreetMap que la contiene`
    : `para calzar ${what} con su huella en OpenStreetMap`;
  return finish(scene, rigid, `${describeMove(rigid)} ${how}.`, `huella OSM ${chosen.id}`, fixed);
}

/* ───────────────────────────── Entrada ───────────────────────────── */

export type AnchorMode = "vehicles" | "structure";

/**
 * Qué anclaje corresponde. Para un tipo "unknown" (reporte de vecino sin clasificar) se
 * deduce de la escena; otros tipos no se anclan.
 */
export function anchorModeFor(incidentType: IncidentType, scene: SceneModel): AnchorMode | null {
  if (incidentType === "vehicle_collision" || incidentType === "vehicle_fire") return "vehicles";
  if (incidentType === "structure_fire") return "structure";
  if (incidentType === "unknown") {
    if (scene.structures.some((s) => s.role === "involved")) return "structure";
    if (scene.vehicles.length > 0) return "vehicles";
  }
  return null;
}

/** Punto que el anclaje hace calzar: centro de los vehículos o de la estructura principal. */
function anchorPoint(scene: SceneModel, mode: AnchorMode): OsmXY | null {
  if (mode === "vehicles") return scene.vehicles.length ? centroid(scene.vehicles) : null;
  const s = mainStructure(scene);
  return s ? { x: s.x, y: s.y } : null;
}

/**
 * Si la escena ya calza porque la IA conservó las posiciones ancladas en la fusión anterior
 * pero reescribió las notas, se recupera la nota de ajuste: el comandante debe seguir sabiendo
 * que esas posiciones vienen del mapa.
 */
function carryNote(res: AnchorResult, mode: AnchorMode, previous: SceneModel | null | undefined): AnchorResult {
  if (res.adjustment || res.warning || !previous || !Array.isArray(previous.uncertainty_notes)) return res;
  if (res.scene.uncertainty_notes.some((n) => n.startsWith(ANCHOR_NOTE_PREFIX))) return res;
  const note = previous.uncertainty_notes.find((n) => n.startsWith(ANCHOR_NOTE_PREFIX));
  const now = anchorPoint(res.scene, mode);
  const before = anchorPoint(previous, mode);
  if (!note || !now || !before || dist(now, before) > CARRY_NOTE_M) return res;
  return { ...res, scene: { ...res.scene, uncertainty_notes: [...res.scene.uncertainty_notes, note] } };
}

/**
 * Ancla la escena al entorno OSM. Pura y nunca lanza: ante cualquier problema devuelve
 * la escena original sin ajuste.
 */
export function anchorScene(
  scene: SceneModel,
  incidentType: IncidentType,
  ctx: OsmContext | null,
  opts?: AnchorOptions,
): AnchorResult {
  const none: AnchorResult = { scene, adjustment: null };
  if (!ctx || !scene) return none;
  try {
    const mode = anchorModeFor(incidentType, scene);
    if (!mode) return none;
    const fixed = (opts?.fixedCameras ?? []).filter((f) => f && typeof f.media_ref === "string" && f.tolerance_m >= 0);
    const res =
      mode === "vehicles"
        ? anchorVehicles(scene, ctx, opts?.maxShiftM ?? DEFAULT_MAX_SHIFT, fixed)
        : anchorStructure(scene, ctx, opts?.maxStructureDistM ?? DEFAULT_MAX_STRUCTURE_DIST, fixed);
    return carryNote(res, mode, opts?.previous);
  } catch {
    return none;
  }
}
