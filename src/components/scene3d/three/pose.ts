/**
 * Cálculos numéricos puros de la escena 3D (sin WebGL ni React): techos, poses de
 * vehículos y cámaras, partículas de humo, selección por prioridad, brújula y escala.
 * Coordenadas three.js: x Este, y altura, z = −Norte.
 */
import type { SmokeVolume, VehicleState } from "@/lib/domain";
import {
  boundsCenter,
  boundsOf,
  clamp,
  footprintCorners,
  headingOf,
  padBounds,
  toThree,
  viewAngles,
  type Bounds,
  type Vec3,
  type ViewPreset,
  type XY,
} from "../geometry";
import { footprintOf, type NormScene, type NRoad } from "../model";
import type { SceneEntityKind, SceneSelection } from "../types";

const RAD = Math.PI / 180;

/* ───────────────────────────── Techos ───────────────────────────── */

/**
 * Triángulos (no indexados) de un techo a dos aguas sobre una planta w × d, con la
 * cumbrera paralela a la fachada (eje local X) y altura h. Base en y = 0.
 */
export function gableRoofPositions(w: number, d: number, h: number): Float32Array {
  const x = w / 2;
  const z = d / 2;
  // prettier-ignore
  return new Float32Array([
    // Faldón frontal (+Z)
    -x, 0, z,   x, 0, z,   x, h, 0,
    -x, 0, z,   x, h, 0,  -x, h, 0,
    // Faldón posterior (−Z)
     x, 0, -z, -x, 0, -z, -x, h, 0,
     x, 0, -z, -x, h, 0,   x, h, 0,
    // Hastial derecho (+X) e izquierdo (−X)
     x, 0, z,   x, 0, -z,  x, h, 0,
    -x, 0, -z, -x, 0, z,  -x, h, 0,
  ]);
}

/** Aristas del techo a dos aguas (pares de puntos) para el contorno. */
export function gableRoofEdges(w: number, d: number, h: number): Float32Array {
  const x = w / 2;
  const z = d / 2;
  // prettier-ignore
  return new Float32Array([
    -x, h, 0,   x, h, 0,
    -x, 0, z,  -x, h, 0,   x, 0, z,   x, h, 0,
    -x, 0, -z, -x, h, 0,   x, 0, -z,  x, h, 0,
  ]);
}

/* ───────────────────────────── Vehículos ───────────────────────────── */

export interface VehiclePose {
  /** Giro sobre el eje largo (local Z), en radianes. */
  rollRad: number;
  /** Altura del centro de la caja sobre el suelo. */
  lift: number;
  /** Factor de altura (aplastado). */
  scaleY: number;
}

/** Pose de la caja del vehículo según su estado (volcado, de costado, aplastado). */
export function vehiclePose(state: VehicleState, width: number, height: number): VehiclePose {
  switch (state) {
    case "on_side":
      return { rollRad: Math.PI / 2, lift: width / 2, scaleY: 1 };
    case "overturned":
      return { rollRad: Math.PI, lift: height / 2, scaleY: 1 };
    case "crushed":
      return { rollRad: 0, lift: height * 0.3, scaleY: 0.6 };
    default:
      return { rollRad: 0, lift: height / 2, scaleY: 1 };
  }
}

/* ───────────────────────────── Cámaras ───────────────────────────── */

/**
 * Inclinación hacia abajo (grados, positiva) de la cámara de un medio. Las que están
 * a la altura de una persona miran casi horizontal; las elevadas (dron, balcón) apuntan al foco.
 */
export function cameraTiltDeg(z: number, horizontalDistToFocus: number): number {
  if (!(z > 3)) return 6;
  const d = Math.max(1, Number.isFinite(horizontalDistToFocus) ? horizontalDistToFocus : 1);
  return clamp(Math.atan2(z, d) / RAD, 8, 80);
}

/**
 * Segmentos del frustum (pares de puntos) en el espacio local de la cámara: vértice en el
 * origen y mirando a +Z. `hfov`/`vfov` en grados.
 */
export function frustumSegments(length: number, hfovDeg = 58, vfovDeg = 36): Float32Array {
  const L = Math.max(0.5, length);
  const hw = Math.tan((clamp(hfovDeg, 5, 170) * RAD) / 2) * L;
  const hh = Math.tan((clamp(vfovDeg, 5, 170) * RAD) / 2) * L;
  const c: Vec3[] = [
    [-hw, hh, L],
    [hw, hh, L],
    [hw, -hh, L],
    [-hw, -hh, L],
  ];
  const out: number[] = [];
  for (const p of c) out.push(0, 0, 0, ...p);
  for (let i = 0; i < 4; i++) out.push(...c[i], ...c[(i + 1) % 4]);
  return new Float32Array(out);
}

/* ───────────────────────────── Humo ───────────────────────────── */

export interface SmokeConfig {
  count: number;
  /** Altura que alcanza la columna (m). */
  height: number;
  /** Desplazamiento horizontal máximo por la deriva (m). */
  driftLen: number;
  /** Tamaño de la partícula al nacer y al disiparse (m). */
  size0: number;
  size1: number;
  opacity: number;
  /** Ciclos por segundo de cada partícula. */
  speed: number;
}

const SMOKE: Record<Exclude<SmokeVolume, "none">, SmokeConfig> = {
  light: { count: 36, height: 14, driftLen: 10, size0: 1.6, size1: 5, opacity: 0.4, speed: 0.07 },
  moderate: { count: 64, height: 22, driftLen: 16, size0: 2.2, size1: 7.5, opacity: 0.5, speed: 0.06 },
  heavy: { count: 110, height: 32, driftLen: 24, size0: 3, size1: 11, opacity: 0.6, speed: 0.05 },
};

export function smokeConfig(volume: SmokeVolume, hasDrift: boolean): SmokeConfig {
  const base = SMOKE[volume === "none" ? "light" : volume];
  return hasDrift ? base : { ...base, driftLen: 0 };
}

/** Pseudoaleatorio determinista en [0, 1) (las semillas de partículas no dependen de Math.random). */
export function rand(i: number, salt = 0): number {
  let t = (Math.imul(i + 1, 0x9e3779b1) ^ Math.imul(salt + 7, 0x85ebca6b)) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Semilla numérica estable a partir de un id. */
export function seedOf(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 100_000;
}

/* ───────────────────────────── Selección ───────────────────────────── */

/** Al hacer clic sobre varias entidades superpuestas gana la de mayor prioridad (personas primero). */
export const PICK_PRIORITY: Record<SceneEntityKind, number> = {
  person: 9,
  camera: 8,
  drone: 8,
  vehicle: 6,
  fire: 6,
  hazard: 5,
  access: 5,
  smoke: 3,
  structure: 2,
  road: 1,
};

interface PickNode {
  userData: Record<string, unknown>;
  parent: PickNode | null;
}

function pickOf(node: PickNode | null): SceneSelection | null {
  for (let n = node; n; n = n.parent) {
    const p = n.userData?.vgPick;
    if (p && typeof p === "object" && "kind" in p && "id" in p) {
      const { kind, id } = p as { kind: unknown; id: unknown };
      if (typeof kind === "string" && kind in PICK_PRIORITY && typeof id === "string") {
        return { kind: kind as SceneEntityKind, id };
      }
    }
  }
  return null;
}

/** Entidad a seleccionar entre las intersecciones del rayo (ordenadas por distancia). */
export function choosePick(hits: readonly { object: PickNode }[]): SceneSelection | null {
  let best: SceneSelection | null = null;
  for (const h of hits) {
    const p = pickOf(h.object);
    if (p && (!best || PICK_PRIORITY[p.kind] > PICK_PRIORITY[best.kind])) best = p;
  }
  return best;
}

/* ───────────────────────────── Calles ───────────────────────────── */

/**
 * Punto donde rotular una calle: cerca del foco pero corrido ~`offset` m a lo largo de
 * la vía para no tapar la fachada principal.
 */
export function roadLabelPoint(road: Pick<NRoad, "x1" | "y1" | "x2" | "y2" | "length">, focus: XY, offset = 32): XY {
  const dx = road.x2 - road.x1;
  const dy = road.y2 - road.y1;
  const L = Math.max(1e-6, road.length || Math.hypot(dx, dy));
  const t0 = clamp(((focus.x - road.x1) * dx + (focus.y - road.y1) * dy) / (L * L), 0, 1);
  const step = offset / L;
  const t = t0 + step <= 0.97 ? t0 + step : t0 - step >= 0.03 ? t0 - step : 0.5;
  return { x: road.x1 + dx * t, y: road.y1 + dy * t };
}

/* ───────────────────────────── Vista ───────────────────────────── */

/** Rumbo (0 = N) hacia el que mira la cámara en planta, a partir de su posición y su objetivo (three.js). */
export function viewHeadingDeg(cam: Vec3, target: Vec3): number {
  const dx = target[0] - cam[0];
  const dy = -(target[2] - cam[2]);
  if (Math.hypot(dx, dy) < 1e-9) return 0;
  return headingOf(dx, dy);
}

/** Metros por píxel de pantalla a la distancia del objetivo (cámara perspectiva). */
export function metersPerPixel(distance: number, fovDeg: number, heightPx: number): number {
  const d = Number.isFinite(distance) && distance > 0 ? distance : 1;
  return (2 * d * Math.tan((clamp(fovDeg, 1, 170) * RAD) / 2)) / Math.max(1, heightPx);
}

/** Acota el objetivo de la cámara al suelo dibujado (con margen) y a una altura razonable. */
export function clampTarget(target: Vec3, extent: Bounds, margin: number, maxHeight = 60): Vec3 {
  return [
    clamp(target[0], extent.minX - margin, extent.maxX + margin),
    clamp(target[1], 0, maxHeight),
    clamp(target[2], -(extent.maxY + margin), -(extent.minY - margin)),
  ];
}

/** Anima solo si hay algo que animar, el usuario no pidió menos movimiento y el visor se ve. */
export function shouldAnimate(o: { content: boolean; reducedMotion: boolean; pageVisible: boolean; onScreen: boolean }): boolean {
  return o.content && !o.reducedMotion && o.pageVisible && o.onScreen;
}

/** Suavizado de las transiciones de cámara. */
export function easeInOut(t: number): number {
  const x = clamp(t, 0, 1);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

/* ───────────────────────────── Modo del visor ───────────────────────────── */

export type ViewerMode = "2d" | "3d";

/**
 * Modo vigente: planta si no hay WebGL o el 3D falló; si no, lo que eligió el usuario
 * o el valor por defecto (planta en compacto, 3D en el resto). `webgl` null = aún no se sabe.
 */
export function resolveMode(o: { compact: boolean; webgl: boolean | null; failed: boolean; chosen: ViewerMode | null }): ViewerMode {
  if (o.failed || o.webgl === false) return "2d";
  return o.chosen ?? (o.compact ? "2d" : "3d");
}

/** Motivo por el que no se puede pasar a 3D (null si se puede). */
export function threeDBlockedReason(o: { webgl: boolean | null; failed: boolean }): string | null {
  if (o.webgl === false) return "Este navegador o equipo no permite gráficos 3D (WebGL).";
  if (o.failed) return "La vista 3D falló en este equipo.";
  return null;
}

/* ───────────────────────────── Encuadre 3D ───────────────────────────── */

/** Radio alrededor del foco que define el "núcleo táctico" del primer encuadre 3D. */
export const CORE_RADIUS = 45;

/**
 * Caja del núcleo táctico: estructuras afectadas o expuestas, focos, personas en riesgo o lesionadas y vehículos
 * con atrapamiento o en llamas cerca del foco. Cámaras lejanas, accesos y la traza del dron
 * quedan fuera (se ven al alejar). Sin núcleo, usa `fallback`.
 */
export function coreBounds(scene: NormScene, fallback: Bounds): Bounds {
  const f = scene.focus;
  const near = (x: number, y: number) => Math.hypot(x - f.x, y - f.y) <= CORE_RADIUS;
  const pts: { x: number; y: number; z: number }[] = [];
  for (const s of scene.structures) {
    // Los edificios de referencia no definen el encuadre (se ven al alejar).
    if (s.role === "reference" || !near(s.x, s.y)) continue;
    for (const c of footprintCorners(footprintOf(s))) pts.push({ ...c, z: s.height + s.roofHeight });
  }
  for (const fi of scene.fires) if (near(fi.x, fi.y)) pts.push({ x: fi.x, y: fi.y, z: fi.z + fi.radius });
  for (const p of scene.people) if (p.risk !== "other" && near(p.x, p.y)) pts.push({ x: p.x, y: p.y, z: p.z + 7 });
  for (const v of scene.vehicles) {
    if (!(v.entrapment || v.burning) || !near(v.x, v.y)) continue;
    const r = Math.max(v.length, v.width) / 2 + 2;
    pts.push({ x: v.x - r, y: v.y - r, z: v.height + 4 }, { x: v.x + r, y: v.y + r, z: 0 });
  }
  const b = boundsOf(pts);
  return b ? padBounds(b, 5, 14) : fallback;
}

/**
 * Pose que encuadra exactamente las 8 esquinas de `b` desde la vista pedida (más ajustado
 * que la esfera envolvente). `aspect` = ancho / alto; `fovDeg` = campo vertical.
 */
export function fitBox(b: Bounds, preset: ViewPreset, frontHeadingDeg: number, aspect: number, fovDeg = 45, margin = 1.08): { position: Vec3; target: Vec3 } {
  const c = boundsCenter(b);
  if (![c.x, c.y, c.z].every(Number.isFinite)) return { position: [60, 50, 60], target: [0, 0, 0] };
  const { azimuthDeg, elevationDeg } = viewAngles(preset, Number.isFinite(frontHeadingDeg) ? frontHeadingDeg : 180);
  const az = azimuthDeg * RAD;
  const el = elevationDeg * RAD;
  // Base de la cámara en ENU: w apunta del objetivo a la cámara.
  const w = { x: Math.cos(el) * Math.sin(az), y: Math.cos(el) * Math.cos(az), z: Math.sin(el) };
  const fw = { x: -w.x, y: -w.y, z: -w.z };
  let r = { x: fw.y, y: -fw.x, z: 0 }; // fw × Z
  const rl = Math.hypot(r.x, r.y) || 1;
  r = { x: r.x / rl, y: r.y / rl, z: 0 };
  const u = { x: r.y * fw.z - r.z * fw.y, y: r.z * fw.x - r.x * fw.z, z: r.x * fw.y - r.y * fw.x };
  const safeAspect = Number.isFinite(aspect) && aspect > 0.1 ? Math.min(aspect, 10) : 1.5;
  const tanV = Math.tan((clamp(fovDeg, 10, 120) * RAD) / 2);
  const tanH = tanV * safeAspect;
  const tz = clamp(c.z, 0, 10);
  let d = 0;
  for (const x of [b.minX, b.maxX]) {
    for (const y of [b.minY, b.maxY]) {
      for (const z of [b.minZ, b.maxZ]) {
        const p = { x: x - c.x, y: y - c.y, z: z - tz };
        const depth = p.x * w.x + p.y * w.y + p.z * w.z;
        const a = Math.abs(p.x * r.x + p.y * r.y);
        const v = Math.abs(p.x * u.x + p.y * u.y + p.z * u.z);
        d = Math.max(d, depth + a / tanH, depth + v / tanV);
      }
    }
  }
  const dist = clamp(d * margin, 12, 4000);
  return {
    target: toThree(c.x, c.y, tz),
    position: toThree(c.x + w.x * dist, c.y + w.y * dist, tz + w.z * dist),
  };
}

/* ───────────────────────────── Etiquetas ───────────────────────────── */

export interface LabelBox {
  x: number;
  y: number;
  w: number;
  h: number;
  priority: number;
  /** Siempre visible (personas en riesgo, atrapamiento, entidad seleccionada). */
  pinned: boolean;
}

export interface LabelPlacement {
  visible: boolean;
  /** Corrimiento aplicado (px) respecto de la posición natural. */
  dx: number;
  dy: number;
}

/**
 * Despeje de etiquetas en pantalla: de mayor a menor prioridad (las fijas primero), cada
 * etiqueta prueba su lugar natural y, si `shift`, a la derecha, a la izquierda, arriba y abajo
 * de su ancla; si todo choca con una ya colocada, se oculta. Las fijas nunca se mueven ni se
 * ocultan. Las cajas vacías (etiqueta detrás de la cámara) no ocupan lugar.
 */
export function declutter(boxes: readonly LabelBox[], options: { pad?: number; shift?: boolean } = {}): LabelPlacement[] {
  const pad = options.pad ?? 2;
  const shift = options.shift ?? true;
  const order = boxes
    .map((_, i) => i)
    .sort((i, j) => Number(boxes[j].pinned) - Number(boxes[i].pinned) || boxes[j].priority - boxes[i].priority || i - j);
  const out: LabelPlacement[] = boxes.map(() => ({ visible: true, dx: 0, dy: 0 }));
  const placed: { x: number; y: number; w: number; h: number }[] = [];
  const free = (x: number, y: number, w: number, h: number) =>
    !placed.some((p) => x < p.x + p.w + pad && x + w + pad > p.x && y < p.y + p.h + pad && y + h + pad > p.y);
  for (const i of order) {
    const b = boxes[i];
    if (!(b.w > 0 && b.h > 0)) continue;
    const candidates: [number, number][] = !shift
      ? [[0, 0]]
      : [
          [0, 0],
          [b.w / 2 + 6, 0],
          [-(b.w / 2 + 6), 0],
          [0, -(b.h + 4)],
          [0, b.h + 12],
        ];
    // Las fijas también buscan un hueco (dos personas en riesgo juntas no se montan), pero nunca se ocultan.
    const hit = candidates.find(([dx, dy]) => free(b.x + dx, b.y + dy, b.w, b.h)) ?? (b.pinned ? candidates[0] : undefined);
    if (hit) {
      placed.push({ x: b.x + hit[0], y: b.y + hit[1], w: b.w, h: b.h });
      out[i] = { visible: true, dx: hit[0], dy: hit[1] };
    } else {
      out[i] = { visible: false, dx: 0, dy: 0 };
    }
  }
  return out;
}
