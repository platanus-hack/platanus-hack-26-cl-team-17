/**
 * Vista sintética de demostración: convierte el esquema de la escena de la IA
 * (SceneModel, metros ENU con origen en el incidente) en un archivo .splat.
 *
 * NO viene de los videos: se usa cuando no hay GPU y siempre se rotula como
 * "Vista sintética · generada desde el esquema de la IA". Las coordenadas del
 * archivo ya son ENU (x Este, y Norte, z arriba): su transform es la identidad.
 * Determinista (semilla fija) para que dos generaciones de la misma escena coincidan.
 */
import type {
  Construction,
  PersonStatus,
  SceneModel,
  SmokeColor,
  VehicleKind,
} from "@/lib/domain";
import { SplatWriter } from "./splat-writer";

type V3 = [number, number, number];
type RGB = [number, number, number];

export const IDENTITY_TRANSFORM: number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/* Presupuesto aproximado de gaussianas por capa (~80 000 en total ≈ 2,5 MB). */
const BUDGET = { ground: 15_000, roads: 12_000, structures: 45_000 } as const;

const UP: V3 = [0, 0, 1];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const clamp = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo);
const num = (v: number, fallback: number) => (Number.isFinite(v) ? v : fallback);
const mix = (a: RGB, b: RGB, t: number): RGB => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
const rad = (d: number) => (d * Math.PI) / 180;
/** Rumbo (0 = Norte, horario) → vector unitario ENU en el plano. */
const heading = (deg: number): V3 => [Math.sin(rad(deg)), Math.cos(rad(deg)), 0];
/** Perpendicular "a la derecha" de un rumbo, en el plano. */
const rightOf = (deg: number): V3 => [Math.cos(rad(deg)), -Math.sin(rad(deg)), 0];

/** Generador pseudoaleatorio determinista (mulberry32). */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Cuaternión (w, x, y, z) de la base ortonormal derecha u, v, n (columnas). */
export function quatFromBasis(u: V3, v: V3, n: V3): [number, number, number, number] {
  const [m00, m10, m20] = u;
  const [m01, m11, m21] = v;
  const [m02, m12, m22] = n;
  const tr = m00 + m11 + m22;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1);
    return [0.25 / s, (m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s];
  }
  if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    return [(m21 - m12) / s, 0.25 * s, (m01 + m10) / s, (m02 + m20) / s];
  }
  if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    return [(m02 - m20) / s, (m01 + m10) / s, 0.25 * s, (m12 + m21) / s];
  }
  const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
  return [(m10 - m01) / s, (m02 + m20) / s, (m12 + m21) / s, 0.25 * s];
}

/* ─────────────── Paleta (sRGB 0..255) ─────────────── */

const CONSTRUCTION_COLOR: Record<Construction, RGB> = {
  wood: [146, 108, 74],
  masonry: [158, 92, 70],
  concrete: [156, 156, 150],
  metal: [124, 134, 146],
  light_materials: [178, 163, 132],
  mixed: [146, 130, 114],
  unknown: [136, 136, 134],
};
const ROOF_GABLE: RGB = [112, 58, 46];
const ROOF_FLAT: RGB = [92, 94, 96];
const GLASS: RGB = [34, 44, 58];
const GLOW: RGB = [255, 150, 54];
const SOOT: RGB = [34, 30, 28];
const DOOR: RGB = [64, 46, 34];
const GROUND: RGB = [62, 67, 64];
const ASPHALT: RGB = [40, 42, 46];
const MARKING: RGB = [222, 222, 210];
const BLOCKED: RGB = [255, 160, 40];

const SMOKE_COLOR: Record<SmokeColor, RGB> = {
  none: [150, 150, 150],
  white: [228, 228, 226],
  gray: [138, 138, 140],
  black: [34, 34, 38],
  brown: [112, 86, 62],
  yellow: [184, 172, 96],
  unknown: [130, 130, 132],
};

const VEHICLE_DIMS: Record<VehicleKind, { l: number; w: number; h: number; color: RGB }> = {
  car: { l: 4.5, w: 1.8, h: 1.5, color: [58, 92, 146] },
  suv_pickup: { l: 5.2, w: 2.0, h: 1.8, color: [150, 152, 158] },
  van: { l: 5.0, w: 2.0, h: 2.2, color: [222, 222, 222] },
  truck: { l: 8.0, w: 2.5, h: 3.2, color: [200, 200, 196] },
  bus: { l: 12.0, w: 2.55, h: 3.2, color: [228, 180, 44] },
  motorcycle: { l: 2.1, w: 0.8, h: 1.2, color: [44, 44, 46] },
  bicycle: { l: 1.8, w: 0.6, h: 1.1, color: [44, 44, 46] },
  trailer: { l: 7.0, w: 2.5, h: 2.8, color: [182, 182, 182] },
  other: { l: 4.5, w: 1.8, h: 1.6, color: [122, 122, 122] },
};

const CRITICAL_PERSON: ReadonlySet<PersonStatus> = new Set([
  "trapped",
  "at_window_or_balcony",
  "on_roof",
  "injured",
]);
function personColor(status: PersonStatus): RGB {
  if (CRITICAL_PERSON.has(status)) return [255, 58, 108];
  if (status === "responder") return [255, 204, 40];
  if (status === "unknown") return [255, 120, 200];
  return [236, 236, 236];
}

const HAZARD_COLOR = { high: [255, 77, 77], medium: [255, 178, 36], low: [255, 222, 120] } as const;

/* ─────────────── Generador ─────────────── */

export interface SyntheticSplat {
  bytes: Uint8Array;
  count: number;
  /** Radio del suelo dibujado, en metros. */
  ground_radius_m: number;
}

interface Ctx {
  w: SplatWriter;
  rand: () => number;
}

function jitter(c: RGB, rand: () => number, amount: number): RGB {
  const d = (rand() - 0.5) * 2 * amount;
  return [c[0] + d, c[1] + d, c[2] + d];
}

/**
 * Siembra una superficie plana: rectángulo desde `origin` a lo largo de u (lenU) y v (lenV).
 * `color(a, b, p)` devuelve [rgb, opacidad] o null para dejar un hueco.
 */
function plane(
  ctx: Ctx,
  origin: V3,
  u: V3,
  v: V3,
  lenU: number,
  lenV: number,
  spacing: number,
  color: (a: number, b: number, p: V3) => [RGB, number] | null,
  thickness = 0.03,
) {
  const n = norm(cross(u, v));
  const [qw, qx, qy, qz] = quatFromBasis(u, v, n);
  const nu = Math.max(1, Math.round(lenU / spacing));
  const nv = Math.max(1, Math.round(lenV / spacing));
  const du = lenU / nu;
  const dv = lenV / nv;
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const a = (i + 0.5 + (ctx.rand() - 0.5) * 0.4) * du;
      const b = (j + 0.5 + (ctx.rand() - 0.5) * 0.4) * dv;
      const p = add(add(origin, scale(u, a)), scale(v, b));
      const c = color(a, b, p);
      if (!c) continue;
      const [rgb, alpha] = c;
      ctx.w.push({
        x: p[0],
        y: p[1],
        z: p[2],
        sx: du * 0.55,
        sy: dv * 0.55,
        sz: thickness,
        r: rgb[0],
        g: rgb[1],
        b: rgb[2],
        a: alpha,
        qw,
        qx,
        qy,
        qz,
      });
    }
  }
}

/** Nube de gaussianas redondas (fuego, humo, marcadores). */
function blob(ctx: Ctx, p: V3, s: number, rgb: RGB, alpha: number) {
  ctx.w.push({ x: p[0], y: p[1], z: p[2], sx: s, sy: s, sz: s, r: rgb[0], g: rgb[1], b: rgb[2], a: alpha });
}

/** Punto aleatorio aproximadamente normal (suma de uniformes). */
function gauss(rand: () => number) {
  return (rand() + rand() + rand() - 1.5) / 0.5;
}

type FireZone = SceneModel["fire_zones"][number];

function fireCenter(f: FireZone): V3 {
  return [clamp(f.x, -1000, 1000), clamp(f.y, -1000, 1000), clamp(num(f.z, 1.5), 0, 300)];
}

function structures(ctx: Ctx, scene: SceneModel) {
  const list = scene.structures;
  if (list.length === 0) return;
  const dims = list.map((s) => {
    const floors = clamp(Math.round(num(s.floors, 1)), 1, 60);
    const fh = clamp(num(s.floor_height_m, 2.7), 2.2, 6);
    return {
      s,
      W: clamp(num(s.width_m, 10), 2, 300),
      D: clamp(num(s.depth_m, 10), 2, 300),
      H: floors * fh,
      fh,
    };
  });
  const area = dims.reduce((sum, d) => sum + 2 * (d.W + d.D) * d.H + d.W * d.D * 1.15, 0);
  const spacing = clamp(Math.sqrt(area / BUDGET.structures), 0.22, 1.5);

  for (const { s, W, D, H, fh } of dims) {
    const C: V3 = [clamp(s.x, -1000, 1000), clamp(s.y, -1000, 1000), 0];
    const n = heading(num(s.rotation_deg, 0));
    const t = rightOf(num(s.rotation_deg, 0));
    const fires = scene.fire_zones.filter(
      (f) =>
        f.intensity !== "smoke_only" &&
        (f.structure_id === s.id || Math.hypot(f.x - C[0], f.y - C[1]) < Math.max(W, D) / 2 + 1),
    );
    const tint = (ctx.rand() - 0.5) * 16;
    let base = CONSTRUCTION_COLOR[s.construction] ?? CONSTRUCTION_COLOR.unknown;
    base = [base[0] + tint, base[1] + tint, base[2] + tint];
    if (s.role === "reference") base = mix(base, [170, 170, 170], 0.45);

    // Hollín y resplandor según la cercanía a los focos de esta estructura.
    const heat = (p: V3) => {
      let soot = 0;
      let glow = 0;
      for (const f of fires) {
        const c = fireCenter(f);
        const r = clamp(num(f.radius_m, 2), 0.8, 20);
        const d = Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]);
        if (p[2] >= c[2] - 1.5) soot = Math.max(soot, clamp(1 - d / (r * 3 + 3), 0, 1));
        glow = Math.max(glow, clamp(1 - d / (r + 2.5), 0, 1));
      }
      return { soot: soot * 0.75, glow };
    };

    const gable = s.roof === "gable";
    const ridge = gable ? clamp(Math.min(W, D) * 0.25, 1, 4) : 0;

    type WallKind = "front" | "back" | "side";
    const wall = (lenU: number, kind: WallKind) => (a: number, b: number, p: V3): [RGB, number] | null => {
      // Los costados de un techo a dos aguas terminan en triángulo bajo la cumbrera.
      const top = kind === "side" && gable ? H + ridge * (1 - Math.abs(a - lenU / 2) / (lenU / 2)) : H;
      if (b > top) return null;
      const h = heat(p);
      const floorIdx = Math.floor(b / fh);
      const zb = b - floorIdx * fh;
      const inWindowBand = zb > 0.9 && zb < fh - 0.6 && b < H;
      const col = a % 3.2 > 1.0 && a % 3.2 < 2.2 && a > 0.6 && a < lenU - 0.6;
      let c: RGB;
      if (kind === "front" && floorIdx === 0 && Math.abs(a - lenU / 2) < 0.6 && b < 2.1) c = DOOR;
      else if (inWindowBand && col) c = h.glow > 0.15 ? mix(GLASS, GLOW, Math.min(1, h.glow * 1.6)) : GLASS;
      else c = mix(jitter(base, ctx.rand, 7), SOOT, h.soot);
      // Corte esquemático: junto al foco el muro se vuelve translúcido para que se vea el fuego interior.
      return [c, 0.96 * (1 - 0.75 * h.glow)];
    };

    const halfW = scale(t, W / 2);
    const halfD = scale(n, D / 2);
    const maxH = H + ridge;
    // Fachada (mira hacia n), fondo y costados.
    plane(ctx, add(add(C, halfD), scale(halfW, -1)), t, UP, W, H, spacing, wall(W, "front"));
    plane(ctx, add(add(C, scale(halfD, -1)), scale(halfW, -1)), t, UP, W, H, spacing, wall(W, "back"));
    plane(ctx, add(add(C, halfW), scale(halfD, -1)), n, UP, D, maxH, spacing, wall(D, "side"));
    plane(ctx, add(add(C, scale(halfW, -1)), scale(halfD, -1)), n, UP, D, maxH, spacing, wall(D, "side"));

    const roofColor = (a: number, b: number, p: V3): [RGB, number] => {
      const h = heat(p);
      return [mix(jitter(gable ? ROOF_GABLE : ROOF_FLAT, ctx.rand, 6), SOOT, h.soot), 0.97 * (1 - 0.6 * h.glow)];
    };
    if (gable) {
      const eave = 0.3;
      const top = add(C, [0, 0, H + ridge]);
      for (const dir of [1, -1]) {
        const slope = norm(add(scale(n, (dir * D) / 2), [0, 0, -ridge]));
        const len = Math.hypot(D / 2, ridge) + eave;
        plane(ctx, add(top, scale(t, -(W / 2 + eave))), t, slope, W + 2 * eave, len, spacing, roofColor);
      }
    } else {
      plane(ctx, add(add(add(C, scale(halfW, -1)), scale(halfD, -1)), [0, 0, H]), t, n, W, D, spacing, roofColor);
    }
  }
}

function ground(ctx: Ctx, radius: number) {
  const spacing = Math.max(0.5, Math.sqrt((Math.PI * radius * radius) / BUDGET.ground));
  const origin: V3 = [-radius, -radius, 0];
  plane(
    ctx,
    origin,
    [1, 0, 0],
    [0, 1, 0],
    radius * 2,
    radius * 2,
    spacing,
    (_a, _b, p) => {
      const d = Math.hypot(p[0], p[1]);
      if (d > radius) return null;
      const fade = clamp((radius - d) / (radius * 0.18), 0, 1);
      return [jitter(GROUND, ctx.rand, 8), 0.95 * fade];
    },
    0.02,
  );
}

function roads(ctx: Ctx, scene: SceneModel, radius: number) {
  const segs = scene.roads
    .map((r) => {
      const p1: V3 = [clamp(r.x1, -1000, 1000), clamp(r.y1, -1000, 1000), 0.03];
      const p2: V3 = [clamp(r.x2, -1000, 1000), clamp(r.y2, -1000, 1000), 0.03];
      const len = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
      return { r, p1, p2, len, width: clamp(num(r.width_m, 7), 2, 40) };
    })
    .filter((s) => s.len > 0.5);
  if (segs.length === 0) return;
  const area = segs.reduce((sum, s) => sum + Math.min(s.len, radius * 2) * s.width, 0);
  const spacing = clamp(Math.sqrt(area / BUDGET.roads), 0.3, 1.2);
  for (const s of segs) {
    const d = norm([s.p2[0] - s.p1[0], s.p2[1] - s.p1[1], 0]);
    const side: V3 = [-d[1], d[0], 0];
    const origin = add(s.p1, scale(side, -s.width / 2));
    plane(
      ctx,
      origin,
      d,
      side,
      s.len,
      s.width,
      spacing,
      (a, b, p) => {
        if (Math.hypot(p[0], p[1]) > radius) return null;
        const off = b - s.width / 2;
        let c: RGB = jitter(ASPHALT, ctx.rand, 4);
        if (Math.abs(off) < 0.14 && a % 6 < 3) c = MARKING;
        else if (Math.abs(off) > s.width / 2 - 0.3) c = mix(MARKING, ASPHALT, 0.35);
        else if (s.r.blocked && (a + b) % 4 < 0.7) c = BLOCKED;
        return [c, 0.97];
      },
      0.02,
    );
  }
}

function flames(ctx: Ctx, f: FireZone) {
  const count = f.intensity === "heavy" ? 2200 : f.intensity === "moderate" ? 1100 : f.intensity === "light" ? 500 : 0;
  if (count === 0) return;
  const c = fireCenter(f);
  const r = clamp(num(f.radius_m, 2), 0.8, 15);
  for (let i = 0; i < count; i++) {
    const g: V3 = [gauss(ctx.rand) * 0.55, gauss(ctx.rand) * 0.55, Math.abs(gauss(ctx.rand)) * 1.1 - 0.25];
    const t = clamp(Math.hypot(g[0], g[1], g[2] * 0.7), 0, 1);
    const p = add(c, scale(g, r));
    const rgb = t < 0.5 ? mix([255, 242, 176], [255, 140, 40], t * 2) : mix([255, 140, 40], [212, 48, 14], (t - 0.5) * 2);
    blob(ctx, p, r * (0.1 + 0.12 * ctx.rand()) * (1 - 0.4 * t), rgb, 0.85 - 0.4 * t);
  }
  // Resplandor tenue alrededor del foco.
  for (let i = 0; i < 40; i++) {
    const p = add(c, [gauss(ctx.rand) * r * 0.5, gauss(ctx.rand) * r * 0.5, Math.abs(gauss(ctx.rand)) * r * 0.5]);
    blob(ctx, p, r * 0.6, [255, 122, 40], 0.07);
  }
}

function plume(
  ctx: Ctx,
  base: V3,
  volume: "light" | "moderate" | "heavy",
  color: SmokeColor,
  driftDeg: number,
) {
  const count = volume === "heavy" ? 1500 : volume === "moderate" ? 800 : 350;
  const height = volume === "heavy" ? 28 : volume === "moderate" ? 18 : 10;
  const drift = driftDeg >= 0 ? heading(driftDeg) : ([0.25, 0.15, 0] as V3);
  const rgb = SMOKE_COLOR[color] ?? SMOKE_COLOR.unknown;
  for (let i = 0; i < count; i++) {
    const t = ctx.rand();
    const center = add(add(base, [0, 0, t * height]), scale(drift, Math.pow(t, 1.5) * height * 0.9));
    const spread = 0.8 + t * height * 0.22;
    const p = add(center, [gauss(ctx.rand) * spread * 0.5, gauss(ctx.rand) * spread * 0.5, gauss(ctx.rand) * spread * 0.35]);
    blob(ctx, p, 0.6 + t * 2.6 + ctx.rand() * 0.6, jitter(rgb, ctx.rand, 10), 0.3 * (1 - 0.65 * t));
  }
}

function boxSurface(
  ctx: Ctx,
  center: V3,
  fwd: V3,
  right: V3,
  L: number,
  W: number,
  H: number,
  spacing: number,
  color: (face: "side" | "front" | "back" | "top", a: number, b: number) => RGB,
) {
  const hf = scale(fwd, L / 2);
  const hr = scale(right, W / 2);
  const paint = (face: "side" | "front" | "back" | "top") => (a: number, b: number): [RGB, number] => [
    color(face, a, b),
    0.97,
  ];
  plane(ctx, add(add(center, hr), scale(hf, -1)), fwd, UP, L, H, spacing, paint("side"));
  plane(ctx, add(add(center, scale(hr, -1)), scale(hf, -1)), fwd, UP, L, H, spacing, paint("side"));
  plane(ctx, add(add(center, hf), scale(hr, -1)), right, UP, W, H, spacing, paint("front"));
  plane(ctx, add(add(center, scale(hf, -1)), scale(hr, -1)), right, UP, W, H, spacing, paint("back"));
  plane(ctx, add(add(add(center, scale(hf, -1)), scale(hr, -1)), [0, 0, H]), fwd, right, L, W, spacing, paint("top"));
}

function vehicles(ctx: Ctx, scene: SceneModel) {
  for (const v of scene.vehicles) {
    const d = VEHICLE_DIMS[v.kind] ?? VEHICLE_DIMS.other;
    const L = num(v.length_m, 0) > 0.5 ? clamp(v.length_m, 0.5, 25) : d.l;
    const W = num(v.width_m, 0) > 0.3 ? clamp(v.width_m, 0.3, 4) : d.w;
    const H = d.h;
    const fwd = heading(num(v.rotation_deg, 0));
    const right = rightOf(num(v.rotation_deg, 0));
    const center: V3 = [clamp(v.x, -1000, 1000), clamp(v.y, -1000, 1000), 0];
    const burning = v.burning || v.state === "burning";
    const body: RGB = burning ? [58, 46, 40] : d.color;
    boxSurface(ctx, center, fwd, right, L, W, H, 0.14, (face, a, b) => {
      if (face === "side") {
        const wheel = [0.18 * L, 0.82 * L].some((wx) => Math.hypot(a - wx, b - 0.35) < 0.36);
        if (wheel) return [20, 20, 22];
        if (b > H * 0.55 && a > L * 0.2 && a < L * 0.85) return GLASS;
      }
      if (face === "front" && b > H * 0.55) return GLASS;
      return jitter(body, ctx.rand, 5);
    });
    if (burning) {
      flames(ctx, {
        id: v.id,
        structure_id: "",
        floor: 0,
        side: "unknown",
        x: center[0],
        y: center[1],
        z: H,
        radius_m: Math.max(1.2, L * 0.35),
        intensity: "moderate",
        confidence: "medium",
        note: "",
      });
    }
  }
}

function people(ctx: Ctx, scene: SceneModel) {
  for (const p of scene.people) {
    const n = clamp(Math.round(num(p.count, 1)), 1, 6);
    const rgb = personColor(p.status);
    const feet: V3 = [clamp(p.x, -1000, 1000), clamp(p.y, -1000, 1000), clamp(num(p.z, 0), 0, 300)];
    for (let k = 0; k < n; k++) {
      const base = add(feet, [(k - (n - 1) / 2) * 0.7, 0, 0]);
      for (let i = 0; i < 26; i++) {
        const h = (i / 25) * 1.45;
        blob(ctx, add(base, [gauss(ctx.rand) * 0.08, gauss(ctx.rand) * 0.08, h]), 0.13, rgb, 0.95);
      }
      blob(ctx, add(base, [0, 0, 1.62]), 0.13, rgb, 0.98);
    }
    // Baliza vertical para ubicar de lejos a quienes pueden necesitar rescate.
    if (CRITICAL_PERSON.has(p.status)) {
      for (let i = 0; i < 30; i++) {
        blob(ctx, add(feet, [0, 0, 2.2 + i * 0.16]), 0.07, rgb, 0.85 * (1 - i / 34));
      }
      for (let i = 0; i < 36; i++) {
        const a = (i / 36) * Math.PI * 2;
        blob(ctx, add(feet, [Math.cos(a) * 1.2, Math.sin(a) * 1.2, 0.05]), 0.09, rgb, 0.9);
      }
    }
  }
}

function hazards(ctx: Ctx, scene: SceneModel) {
  for (const h of scene.hazards) {
    const rgb = [...(HAZARD_COLOR[h.severity] ?? HAZARD_COLOR.medium)] as RGB;
    const c: V3 = [clamp(h.x, -1000, 1000), clamp(h.y, -1000, 1000), 0.06];
    const r = clamp(num(h.radius_m, 3), 1.5, 40);
    const steps = Math.ceil((2 * Math.PI * r) / 0.3);
    for (let i = 0; i < steps; i++) {
      if (i % 5 === 4) continue;
      const a = (i / steps) * Math.PI * 2;
      blob(ctx, add(c, [Math.cos(a) * r, Math.sin(a) * r, 0]), 0.1, rgb, 0.9);
    }
    const marker: V3 = [c[0], c[1], clamp(num(h.z, 0.5), 0.3, 300)];
    for (let i = 0; i < 14; i++) {
      blob(ctx, add(marker, [gauss(ctx.rand) * 0.15, gauss(ctx.rand) * 0.15, gauss(ctx.rand) * 0.15]), 0.12, rgb, 0.95);
    }
  }
}

/** Radio del suelo: abarca lo dibujado más un margen. */
function sceneRadius(scene: SceneModel): number {
  let ext = 0;
  const see = (x: number, y: number, pad = 0) => {
    if (Number.isFinite(x) && Number.isFinite(y)) ext = Math.max(ext, Math.hypot(x, y) + pad);
  };
  for (const s of scene.structures) see(s.x, s.y, Math.hypot(num(s.width_m, 10), num(s.depth_m, 10)) / 2);
  for (const f of scene.fire_zones) see(f.x, f.y, num(f.radius_m, 2));
  for (const v of scene.vehicles) see(v.x, v.y, 3);
  for (const p of scene.people) see(p.x, p.y);
  for (const h of scene.hazards) see(h.x, h.y, num(h.radius_m, 3));
  for (const sp of scene.smoke_plumes) see(sp.x, sp.y);
  return clamp(ext + 15, 30, 160);
}

export function buildSyntheticSplat(scene: SceneModel): SyntheticSplat {
  const ctx: Ctx = { w: new SplatWriter(90_000), rand: rng(0x5eed1) };
  const radius = sceneRadius(scene);
  ground(ctx, radius);
  roads(ctx, scene, radius);
  structures(ctx, scene);
  vehicles(ctx, scene);
  for (const f of scene.fire_zones) {
    flames(ctx, f);
    if (f.intensity === "smoke_only") plume(ctx, fireCenter(f), "light", "gray", -1);
  }
  for (const s of scene.smoke_plumes) {
    if (s.volume === "none") continue;
    const base: V3 = [clamp(s.x, -1000, 1000), clamp(s.y, -1000, 1000), clamp(num(s.z, 3), 0, 300)];
    plume(ctx, base, s.volume, s.color, num(s.drift_deg, -1));
  }
  people(ctx, scene);
  hazards(ctx, scene);
  return { bytes: ctx.w.toBytes(), count: ctx.w.count, ground_radius_m: radius };
}
