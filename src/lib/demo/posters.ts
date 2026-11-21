/**
 * Pósters de demostración: bocetos tácticos SVG de 1280×720 generados desde un
 * descriptor (`PosterSpec`). Siempre llevan la marca "IMAGEN DE DEMOSTRACIÓN —
 * NO ES VIDEO REAL": nunca deben pasar por fotogramas reales.
 *
 * Restricciones: deterministas (las variaciones salen de `spec.variant` con un
 * PRNG propio), sin referencias externas, scripts ni foreignObject, porque se
 * sirven con CSP "default-src 'none'; style-src 'unsafe-inline'; sandbox".
 */
import type { SmokeColor, SmokeVolume, VehicleKind, VehicleState } from "@/lib/domain";
import type {
  PosterIntensity,
  PosterPosition,
  PosterSpec,
  PosterVehicle,
  PosterView,
} from "./types";

export const POSTER_WATERMARK = "IMAGEN DE DEMOSTRACIÓN — NO ES VIDEO REAL";

type Pt = readonly [number, number];
type PosterExtra = NonNullable<PosterSpec["extras"]>[number];
type ActiveIntensity = Exclude<PosterIntensity, "none">;
type ActiveVolume = Exclude<SmokeVolume, "none">;

const W = 1280;
const H = 720;
const BAR_H = 46;
const SUB_H = 24;
const TOP = BAR_H + SUB_H;
const BAND_Y = 684;
/** Línea de suelo de la fachada en vistas de elevación (escena estructural). */
const GY = 590;

const FONT = "Barlow Condensed, Arial Narrow, Arial, sans-serif";
const MONO = "ui-monospace, Menlo, Consolas, monospace";

const COL = {
  line: "#8796a8",
  dim: "#56657a",
  fill: "#1b2532",
  win: "#0e141b",
  text: "#e2e8f0",
  hi: "#fde047",
  engine: "#c2463b",
} as const;

/* ───────────── utilidades ───────────── */

/** Número con un decimal como máximo (salida compacta y estable). */
function f(n: number): string {
  const r = Math.round(n * 10) / 10;
  return Object.is(r, -0) || r === 0 ? "0" : String(r);
}

function f2(n: number): string {
  return String(Math.round(n * 100) / 100);
}

function pts(p: readonly Pt[]): string {
  return p.map(([x, y]) => `${f(x)},${f(y)}`).join(" ");
}

const XML_ESC: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

/** Escapa texto para XML y quita caracteres de control que XML no admite. */
export function escapeXml(s: string): string {
  let clean = "";
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    const invalid = (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || c === 0xfffe || c === 0xffff;
    if (!invalid) clean += ch;
  }
  return clean.replace(/[&<>"']/g, (c) => XML_ESC[c] ?? c);
}

/** Recorta por puntos de código (no parte emojis ni tildes compuestas). */
function clip(s: string, max: number): string {
  const chars = Array.from(s.replace(/\s+/g, " ").trim());
  return chars.length <= max ? chars.join("") : `${chars.slice(0, max - 1).join("")}…`;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

interface Rng {
  next(): number;
  range(lo: number, hi: number): number;
  int(lo: number, hi: number): number;
}

/** mulberry32: pequeño, rápido y determinista. */
function makeRng(variant: number): Rng {
  const v = Number.isFinite(variant) ? Math.trunc(variant) : 0;
  let a = (Math.imul(v | 0, 0x9e3779b1) ^ 0x85ebca6b) >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (lo, hi) => lo + (hi - lo) * next(),
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
  };
}

/* ───────────── normalización del descriptor ───────────── */

interface Norm {
  scene: "structure" | "collision";
  view: PosterView;
  caption: string;
  clock: string;
  floors: number;
  building: "house" | "apartment";
  fire: { floor: number; position: PosterPosition; intensity: ActiveIntensity } | null;
  smoke: { color: SmokeColor; volume: ActiveVolume; position: PosterPosition } | null;
  person: { floor: number; position: PosterPosition; balcony: boolean } | null;
  exposures: { left: boolean; right: boolean };
  vehicles: PosterVehicle[];
  extras: Set<PosterExtra>;
  street: string | null;
}

const VIEWS: readonly PosterView[] = ["front", "side", "rear", "corner", "aerial"];

function normalize(spec: PosterSpec): Norm {
  const building: "house" | "apartment" =
    spec.building ?? ((spec.floors ?? 2) > 2 ? "apartment" : "house");
  const rawFloors = spec.floors ?? (building === "house" ? 2 : 4);
  const floors = clamp(Math.round(Number.isFinite(rawFloors) ? rawFloors : 2), 1, 6);
  const floorOf = (n: number): number =>
    clamp(Math.round(Number.isFinite(n) ? n : 1), 1, floors);
  const sf = spec.fire;
  const fireIntensity: PosterIntensity = sf?.intensity ?? "none";
  const fire =
    sf && fireIntensity !== "none"
      ? { floor: floorOf(sf.floor), position: sf.position, intensity: fireIntensity }
      : null;
  const ss = spec.smoke;
  const smokeVolume: SmokeVolume = ss?.volume ?? "none";
  const smoke =
    ss && smokeVolume !== "none" && ss.color !== "none"
      ? { color: ss.color, volume: smokeVolume, position: ss.position }
      : null;
  const person = spec.person
    ? { floor: floorOf(spec.person.floor), position: spec.person.position, balcony: spec.person.balcony === true }
    : null;
  const street = spec.street && spec.street.trim() ? clip(spec.street, 40) : null;
  return {
    scene: spec.scene === "collision" ? "collision" : "structure",
    view: VIEWS.includes(spec.view) ? spec.view : "front",
    caption: clip(spec.caption ?? "", 92),
    clock: clip(spec.clock ?? "", 12),
    floors,
    building,
    fire,
    smoke,
    person,
    exposures: { left: spec.exposures?.left === true, right: spec.exposures?.right === true },
    vehicles: (spec.vehicles ?? []).map((v) => ({
      ...v,
      x: clamp(Number.isFinite(v.x) ? v.x : 0.5, 0, 1),
      tag: v.tag ? clip(v.tag, 28) : undefined,
    })),
    extras: new Set(spec.extras ?? []),
    street,
  };
}

const POS_U: Record<PosterPosition, number> = { left: 0.2, center: 0.5, right: 0.8 };

/* ───────────── fuego y humo ───────────── */

const INTENSITY: Record<ActiveIntensity, { op: number; h: number; glow: number }> = {
  light: { op: 0.72, h: 0.5, glow: 0.4 },
  moderate: { op: 0.86, h: 1.05, glow: 0.6 },
  heavy: { op: 0.96, h: 1.7, glow: 0.85 },
};

/** Llama estilizada (tres capas rojo/naranja/amarillo) apoyada en `baseY`. */
function flame(rng: Rng, cx: number, baseY: number, w: number, h: number, lean: number, op: number): string {
  const tongues = 4 + rng.int(0, 2);
  const prof: [number, number][] = [[0, 0]];
  for (let i = 0; i < tongues; i++) {
    const u = (i + 0.5) / tongues;
    const center = 1 - Math.abs(u - 0.5) * 1.1;
    prof.push([u + rng.range(-0.04, 0.04), rng.range(0.55, 1) * center]);
    if (i < tongues - 1) prof.push([(i + 1) / tongues, rng.range(0.12, 0.35) * center]);
  }
  prof.push([1, 0]);
  const layer = (s: number, color: string): string => {
    const p = prof.map(([u, v]): Pt => [cx + (u - 0.5) * w * s + v * lean * s, baseY - v * h * s]);
    return `<polygon points="${pts(p)}" fill="${color}"/>`;
  };
  return `<g opacity="${f2(op)}">${layer(1, "#d9381e")}${layer(0.72, "#ff7a1a")}${layer(0.42, "#ffc857")}</g>`;
}

/** Llama vista desde arriba: estrella irregular en tres capas. */
function flameTop(rng: Rng, cx: number, cy: number, r: number, op: number): string {
  const n = 10;
  const prof: [number, number][] = [];
  for (let i = 0; i < n * 2; i++) {
    const a = (i / (n * 2)) * Math.PI * 2 + rng.range(-0.08, 0.08);
    prof.push([a, i % 2 === 0 ? rng.range(0.7, 1) : rng.range(0.32, 0.5)]);
  }
  const layer = (s: number, color: string): string => {
    const p = prof.map(([a, k]): Pt => [cx + Math.cos(a) * r * k * s, cy + Math.sin(a) * r * k * s * 0.85]);
    return `<polygon points="${pts(p)}" fill="${color}"/>`;
  };
  return `<g opacity="${f2(op)}">${glow(cx, cy, r * 1.6, r * 1.4, 0.7)}${layer(1, "#d9381e")}${layer(0.66, "#ff7a1a")}${layer(0.34, "#ffc857")}</g>`;
}

function glow(cx: number, cy: number, rx: number, ry: number, op: number): string {
  return `<ellipse cx="${f(cx)}" cy="${f(cy)}" rx="${f(rx)}" ry="${f(ry)}" fill="url(#gw)" opacity="${f2(op)}"/>`;
}

const SMOKE_FILL: Record<SmokeColor, string> = {
  none: "#8b929b",
  white: "#e5e7eb",
  gray: "#8b929b",
  black: "#08090c",
  brown: "#6b4a2e",
  yellow: "#b8a04a",
  unknown: "#7c838c",
};

const SMOKE_VOL: Record<ActiveVolume, { n: number; r0: number; grow: number; op: number; dist: number }> = {
  light: { n: 5, r0: 20, grow: 38, op: 0.55, dist: 0.55 },
  moderate: { n: 8, r0: 30, grow: 70, op: 0.75, dist: 0.8 },
  heavy: { n: 12, r0: 42, grow: 110, op: 0.9, dist: 1 },
};

/** Manchas difuminadas; los humos oscuros llevan un borde más claro para leerse sobre el fondo. */
function smokeBlobs(color: SmokeColor, op: number, blobs: { x: number; y: number; rx: number; ry: number }[]): string {
  const fill = SMOKE_FILL[color];
  const dark = color === "black" || color === "brown";
  const shapes = (extra: number): string =>
    blobs
      .map((b) => `<ellipse cx="${f(b.x)}" cy="${f(b.y)}" rx="${f(b.rx + extra)}" ry="${f(b.ry + extra)}"/>`)
      .join("");
  const rim = dark ? `<g fill="#46505e" opacity=".5">${shapes(7)}</g>` : "";
  return `<g filter="url(#bl)" opacity="${f2(op)}">${rim}<g fill="${fill}">${shapes(0)}</g></g>`;
}

function smokeRising(rng: Rng, color: SmokeColor, volume: ActiveVolume, sx: number, sy: number, wind: number): string {
  const p = SMOKE_VOL[volume];
  const topY = TOP + 20;
  const blobs: { x: number; y: number; rx: number; ry: number }[] = [];
  for (let i = 0; i < p.n; i++) {
    const t = p.n === 1 ? 0 : i / (p.n - 1);
    const y = lerp(sy, Math.max(topY, sy - (sy - topY) * p.dist), t) + rng.range(-10, 10);
    const r = p.r0 + t * p.grow;
    blobs.push({ x: sx + wind * t * 380 + rng.range(-28, 28), y, rx: r * 1.25, ry: r * 0.8 });
  }
  if (volume === "heavy") {
    for (let i = 0; i < 4; i++) {
      blobs.push({ x: sx + wind * 300 + rng.range(-260, 260), y: topY + rng.range(10, 70), rx: rng.range(90, 150), ry: rng.range(40, 60) });
    }
  }
  return smokeBlobs(color, p.op, blobs);
}

/** Pluma vista desde arriba: se alarga a sotavento. */
function smokePlume(rng: Rng, color: SmokeColor, volume: ActiveVolume, sx: number, sy: number, angle: number): string {
  const p = SMOKE_VOL[volume];
  const dist = 220 + p.dist * 320;
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const blobs: { x: number; y: number; rx: number; ry: number }[] = [];
  for (let i = 0; i < p.n; i++) {
    const t = p.n === 1 ? 0 : i / (p.n - 1);
    const r = p.r0 * 0.8 + t * p.grow * 0.8;
    blobs.push({
      x: sx + dx * dist * t + rng.range(-16, 16),
      y: sy + dy * dist * t + rng.range(-16, 16),
      rx: r * 1.2,
      ry: r,
    });
  }
  return smokeBlobs(color, p.op * 0.9, blobs);
}

/* ───────────── figuras humanas ───────────── */

/**
 * Pictograma de persona. "full" = cuerpo entero (pies en `footY`); "bust" = medio cuerpo
 * cortado en `footY` (marco de ventana). `bright` = contorno destacado.
 */
function figure(cx: number, footY: number, height: number, mode: "full" | "bust", bright: boolean): string {
  const hgt = mode === "full" ? height : height * 1.6;
  const r = hgt * 0.1;
  const headY = footY - hgt + r;
  const neck = headY + r;
  const hip = footY - hgt * 0.45;
  const sh = neck + hgt * 0.08;
  let d = `M${f(cx)} ${f(neck)}V${f(mode === "full" ? hip : footY)}`;
  d += `M${f(cx)} ${f(sh)}L${f(cx - hgt * 0.2)} ${f(headY - r * 1.2)}`;
  d += `M${f(cx)} ${f(sh)}L${f(cx + hgt * 0.17)} ${f(Math.min(footY, sh + hgt * 0.2))}`;
  if (mode === "full") {
    d += `M${f(cx)} ${f(hip)}L${f(cx - hgt * 0.11)} ${f(footY)}M${f(cx)} ${f(hip)}L${f(cx + hgt * 0.11)} ${f(footY)}`;
  }
  if (!bright) {
    return `<g stroke="#7b8798" stroke-width="2.5" stroke-linecap="round" fill="none"><path d="${d}"/><circle cx="${f(cx)}" cy="${f(headY)}" r="${f(r)}" fill="#7b8798"/></g>`;
  }
  const sw = clamp(hgt * 0.06, 2.5, 5);
  const halo = `<rect x="${f(cx - hgt * 0.32)}" y="${f(headY - r * 2.4)}" width="${f(hgt * 0.64)}" height="${f(footY - headY + r * 2.6)}" rx="6" fill="none" stroke="${COL.hi}" stroke-width="2" stroke-dasharray="7 5"/>`;
  return (
    `<g stroke-linecap="round" fill="none">` +
    `<path d="${d}" stroke="#05070a" stroke-width="${f(sw + 4)}"/>` +
    `<path d="${d}" stroke="${COL.hi}" stroke-width="${f(sw)}"/>` +
    `<circle cx="${f(cx)}" cy="${f(headY)}" r="${f(r)}" fill="#fef9c3" stroke="${COL.hi}" stroke-width="2.5"/>` +
    `</g>${halo}`
  );
}

/** Persona vista desde arriba (cabeza y hombros) con anillo destacado. */
function figureTop(cx: number, cy: number): string {
  return (
    `<circle cx="${f(cx)}" cy="${f(cy)}" r="22" fill="none" stroke="${COL.hi}" stroke-width="2" stroke-dasharray="6 4"/>` +
    `<ellipse cx="${f(cx)}" cy="${f(cy)}" rx="11" ry="6" fill="#fef9c3" stroke="${COL.hi}" stroke-width="2.5"/>` +
    `<circle cx="${f(cx)}" cy="${f(cy)}" r="5" fill="${COL.hi}"/>`
  );
}

/* ───────────── vehículos ───────────── */

interface VDim {
  L: number;
  H: number;
  W: number;
}

const VEH: Record<VehicleKind, VDim> = {
  car: { L: 170, H: 52, W: 88 },
  suv_pickup: { L: 185, H: 64, W: 96 },
  van: { L: 190, H: 80, W: 96 },
  truck: { L: 260, H: 104, W: 120 },
  bus: { L: 300, H: 108, W: 126 },
  motorcycle: { L: 84, H: 50, W: 30 },
  bicycle: { L: 70, H: 44, W: 22 },
  trailer: { L: 230, H: 88, W: 118 },
  other: { L: 160, H: 60, W: 92 },
};

interface VStyle {
  body: string;
  wheel: string;
}

function vehicleStyle(burning: boolean, unknown: boolean, engine: boolean, dim: boolean): VStyle {
  const dash = unknown ? ` stroke-dasharray="6 4"` : "";
  const stroke = engine ? COL.engine : burning ? "#a8653f" : dim ? COL.dim : COL.line;
  const fill = engine ? "#3b1c1c" : burning ? "#2a1812" : COL.fill;
  return {
    body: `fill="${fill}" stroke="${stroke}" stroke-width="2" stroke-linejoin="round"${dash}`,
    wheel: `fill="#0b1016" stroke="${stroke}" stroke-width="2"${dash}`,
  };
}

const poly = (p: readonly Pt[], attrs: string): string => `<polygon points="${pts(p)}" ${attrs}/>`;
const rect = (x: number, y: number, w: number, h: number, attrs: string): string =>
  `<rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" ${attrs}/>`;
const circle = (cx: number, cy: number, r: number, attrs: string): string =>
  `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(r)}" ${attrs}/>`;

/** Perfil lateral mirando a la derecha; origen en el suelo, al centro. */
function sideProfile(kind: VehicleKind, st: VStyle): string {
  const { L, H: h } = VEH[kind];
  const win = `fill="${COL.win}" stroke="${COL.dim}" stroke-width="1.5"`;
  const wheels = (xs: number[], r: number): string => xs.map((x) => circle(x * L, -r, r, st.wheel)).join("");
  switch (kind) {
    case "car":
      return (
        poly([[-L / 2, -0.16 * h], [-L / 2, -0.52 * h], [-0.3 * L, -0.56 * h], [-0.2 * L, -h], [0.17 * L, -h], [0.31 * L, -0.57 * h], [L / 2, -0.5 * h], [L / 2, -0.16 * h]], st.body) +
        poly([[-0.17 * L, -0.6 * h], [-0.13 * L, -0.92 * h], [0.14 * L, -0.92 * h], [0.25 * L, -0.6 * h]], win) +
        wheels([-0.3, 0.3], 0.19 * h)
      );
    case "suv_pickup":
      return (
        poly([[-L / 2, -0.16 * h], [-L / 2, -0.55 * h], [-0.04 * L, -0.55 * h], [0, -h], [0.29 * L, -h], [0.37 * L, -0.6 * h], [L / 2, -0.55 * h], [L / 2, -0.16 * h]], st.body) +
        poly([[0.04 * L, -0.62 * h], [0.06 * L, -0.9 * h], [0.27 * L, -0.9 * h], [0.33 * L, -0.62 * h]], win) +
        wheels([-0.32, 0.32], 0.2 * h)
      );
    case "van":
      return (
        poly([[-L / 2, -0.14 * h], [-L / 2, -h], [0.27 * L, -h], [L / 2, -0.55 * h], [L / 2, -0.14 * h]], st.body) +
        poly([[0.19 * L, -0.92 * h], [0.27 * L, -0.92 * h], [0.43 * L, -0.6 * h], [0.19 * L, -0.6 * h]], win) +
        rect(-0.42 * L, -0.9 * h, 0.5 * L, 0.3 * h, win) +
        wheels([-0.32, 0.3], 0.17 * h)
      );
    case "truck":
      return (
        rect(-L / 2, -h, 0.72 * L, 0.82 * h, st.body) +
        poly([[0.25 * L, -0.15 * h], [0.25 * L, -0.78 * h], [0.4 * L, -0.78 * h], [L / 2, -0.5 * h], [L / 2, -0.15 * h]], st.body) +
        poly([[0.29 * L, -0.72 * h], [0.39 * L, -0.72 * h], [0.46 * L, -0.52 * h], [0.29 * L, -0.52 * h]], win) +
        wheels([-0.36, -0.22, 0.37], 0.14 * h)
      );
    case "bus":
      return (
        rect(-L / 2, -h, L, 0.88 * h, `${st.body} rx="8"`) +
        rect(-0.45 * L, -0.86 * h, 0.9 * L, 0.3 * h, win) +
        `<path d="M${f(-0.27 * L)} ${f(-0.86 * h)}v${f(0.3 * h)}M${f(-0.09 * L)} ${f(-0.86 * h)}v${f(0.3 * h)}M${f(0.09 * L)} ${f(-0.86 * h)}v${f(0.3 * h)}M${f(0.27 * L)} ${f(-0.86 * h)}v${f(0.3 * h)}" stroke="${COL.dim}" stroke-width="1.5"/>` +
        wheels([-0.32, 0.32], 0.13 * h)
      );
    case "motorcycle":
    case "bicycle": {
      const r = (kind === "bicycle" ? 0.33 : 0.3) * h;
      const frame =
        kind === "bicycle"
          ? `M${f(-0.32 * L)} ${f(-r)}L${f(-0.05 * L)} ${f(-0.72 * h)}L${f(0.25 * L)} ${f(-0.72 * h)}L${f(0.32 * L)} ${f(-r)}M${f(-0.05 * L)} ${f(-0.72 * h)}L${f(0)} ${f(-r)}L${f(0.25 * L)} ${f(-0.72 * h)}M${f(0.25 * L)} ${f(-0.72 * h)}L${f(0.22 * L)} ${f(-0.95 * h)}`
          : `M${f(-0.33 * L)} ${f(-r)}L${f(-0.08 * L)} ${f(-0.68 * h)}L${f(0.2 * L)} ${f(-0.68 * h)}L${f(0.33 * L)} ${f(-r)}M${f(0.2 * L)} ${f(-0.68 * h)}L${f(0.26 * L)} ${f(-h)}M${f(-0.22 * L)} ${f(-0.74 * h)}H${f(0.05 * L)}`;
      return `<path d="${frame}" fill="none" ${st.wheel.replace(/fill="[^"]*"/, "")}/>` + wheels([-0.33, 0.33], r).replace(/fill="#0b1016"/g, 'fill="none"');
    }
    case "trailer":
      return (
        rect(-L / 2, -h, 0.88 * L, 0.8 * h, st.body) +
        `<path d="M${f(0.38 * L)} ${f(-0.3 * h)}H${f(L / 2)}" fill="none" ${st.wheel}/>` +
        wheels([-0.22, -0.06], 0.14 * h)
      );
    case "other":
      return rect(-L / 2, -h, L, 0.85 * h, `${st.body} rx="10"`) + wheels([-0.3, 0.3], 0.17 * h);
  }
}

/** Silueta frontal o trasera; origen en el suelo, al centro. */
function frontProfile(kind: VehicleKind, st: VStyle, rear: boolean): string {
  const { W: w, H: h } = VEH[kind];
  const light = rear ? "#d64545" : "#e8eef5";
  const win = `fill="${COL.win}" stroke="${COL.dim}" stroke-width="1.5"`;
  if (kind === "motorcycle" || kind === "bicycle") {
    return (
      rect(-w * 0.18, -0.5 * h, w * 0.36, 0.5 * h, st.wheel) +
      `<path d="M${f(-w)} ${f(-0.82 * h)}H${f(w)}M0 ${f(-0.5 * h)}V${f(-0.82 * h)}" fill="none" ${st.wheel}/>` +
      circle(0, -0.62 * h, w * 0.16, `fill="${light}"`)
    );
  }
  const box = kind === "truck" || kind === "bus" || kind === "van" || kind === "trailer";
  const lights = rect(-0.43 * w, -0.42 * h, 0.15 * w, 0.08 * h, `fill="${light}"`) + rect(0.28 * w, -0.42 * h, 0.15 * w, 0.08 * h, `fill="${light}"`);
  const wheels = rect(-0.46 * w, -0.13 * h, 0.16 * w, 0.13 * h, st.wheel) + rect(0.3 * w, -0.13 * h, 0.16 * w, 0.13 * h, st.wheel);
  if (box) {
    const glass = kind === "trailer" ? "" : rect(-0.38 * w, -0.92 * h, 0.76 * w, 0.3 * h, win);
    return wheels + rect(-w / 2, -h, w, 0.88 * h, `${st.body} rx="6"`) + glass + lights;
  }
  return (
    wheels +
    rect(-w / 2, -0.58 * h, w, 0.46 * h, `${st.body} rx="6"`) +
    poly([[-0.38 * w, -0.58 * h], [-0.29 * w, -h], [0.29 * w, -h], [0.38 * w, -0.58 * h]], st.body) +
    poly([[-0.31 * w, -0.62 * h], [-0.25 * w, -0.92 * h], [0.25 * w, -0.92 * h], [0.31 * w, -0.62 * h]], win) +
    lights
  );
}

/** Planta (vista desde arriba) mirando a +x; origen al centro. */
function topProfile(kind: VehicleKind, st: VStyle, width?: number): string {
  const { L } = VEH[kind];
  const w = width ?? VEH[kind].W;
  if (kind === "motorcycle" || kind === "bicycle") {
    return rect(-L / 2, -w / 4, L, w / 2, `${st.body} rx="4"`) + `<path d="M${f(0.3 * L)} ${f(-w * 0.7)}V${f(w * 0.7)}" fill="none" ${st.wheel}/>`;
  }
  const g = `fill="none" stroke="${COL.dim}" stroke-width="1.5"`;
  switch (kind) {
    case "truck":
      return rect(0.27 * L, -w / 2, 0.23 * L, w, `${st.body} rx="6"`) + rect(-L / 2, -w / 2, 0.75 * L, w, st.body);
    case "trailer":
      return rect(-L / 2, -w / 2, 0.88 * L, w, st.body) + `<path d="M${f(0.38 * L)} 0H${f(L / 2)}" ${g}/>`;
    case "bus":
      return rect(-L / 2, -w / 2, L, w, `${st.body} rx="8"`) + rect(-0.4 * L, -w * 0.3, 0.75 * L, w * 0.6, g);
    default:
      return (
        rect(-L / 2, -w / 2, L, w, `${st.body} rx="12"`) +
        rect(-0.24 * L, -w * 0.38, 0.42 * L, w * 0.76, `${g} rx="6"`) +
        `<path d="M${f(0.18 * L)} ${f(-w * 0.38)}L${f(0.3 * L)} ${f(-w * 0.42)}V${f(w * 0.42)}L${f(0.18 * L)} ${f(w * 0.38)}" ${g}/>`
      );
  }
}

/** Sombreado de daño sobre un rectángulo. */
function hatchRect(x: number, y: number, w: number, h: number): string {
  return rect(x, y, w, h, `fill="url(#ht)" opacity=".7"`);
}

function tagLabel(text: string, x: number, bottom: number): string {
  const w = 16 + Array.from(text).length * 8.6;
  return (
    `<path d="M${f(x)} ${f(bottom)}v10" stroke="${COL.text}" stroke-width="1.5"/>` +
    rect(x - w / 2, bottom - 24, w, 24, `rx="3" fill="#0b1118" fill-opacity=".85" stroke="${COL.line}" stroke-width="1"`) +
    `<text x="${f(x)}" y="${f(bottom - 7)}" class="t" font-size="16" fill="${COL.text}" text-anchor="middle">${escapeXml(text)}</text>`
  );
}

interface VehicleDraw {
  kind: VehicleKind;
  state: VehicleState;
  burning: boolean;
  tag?: string;
  engine?: boolean;
  dim?: boolean;
}

/** Vehículo en vista de elevación: lateral (`side`) o frontal/trasera. */
function vehicleElev(
  rng: Rng,
  v: VehicleDraw,
  mode: "side" | "front" | "rear",
  cx: number,
  gy: number,
  scale: number,
  flip: boolean,
  skew: number,
): string {
  const d = VEH[v.kind];
  const burning = v.burning || v.state === "burning";
  const st = vehicleStyle(burning, v.state === "unknown", v.engine === true, v.dim === true);
  const len = mode === "side" ? d.L : d.W;
  let inner: string;
  let visH = d.H;
  const base = mode === "side" ? sideProfile(v.kind, st) : frontProfile(v.kind, st, mode === "rear");
  switch (v.state) {
    case "overturned":
      inner = `<g transform="translate(0 ${f(-d.H)}) scale(1 -1)">${base}</g>`;
      break;
    case "on_side":
      if (mode === "side") {
        const hp = d.W * 0.8;
        visH = hp;
        inner =
          `<g transform="translate(0 ${f(-hp / 2)})">${topProfile(v.kind, st, hp)}</g>` +
          rect(-0.36 * d.L, -hp - 7, 0.14 * d.L, 9, st.wheel) +
          rect(0.22 * d.L, -hp - 7, 0.14 * d.L, 9, st.wheel);
      } else {
        visH = d.W;
        inner = `<g transform="translate(0 ${f(d.H / 2 - d.W / 2)}) rotate(90 0 ${f(-d.H / 2)})">${base}</g>`;
      }
      break;
    case "crushed": {
      visH = d.H * 0.66;
      const jag: Pt[] = [];
      for (let i = 0; i <= 8; i++) jag.push([lerp(-len * 0.45, len * 0.45, i / 8), -visH + (i % 2 === 0 ? 2 : 9) + rng.range(-2, 2)]);
      inner =
        `<g transform="scale(1 .66)">${base}</g>` +
        hatchRect(-len * 0.42, -visH, len * 0.84, visH * 0.55) +
        `<polyline points="${pts(jag)}" fill="none" stroke="#e2a24a" stroke-width="2"/>`;
      break;
    }
    default:
      inner = base;
  }
  if (v.engine && mode === "side" && v.state === "upright") {
    // Escala mecánica sobre la caja del carro bomba.
    const y = -d.H - 7;
    inner += `<path d="M${f(-0.46 * d.L)} ${f(y)}H${f(0.2 * d.L)}M${f(-0.46 * d.L)} ${f(y + 6)}H${f(0.2 * d.L)}${Array.from({ length: 9 }, (_, i) => `M${f(-0.44 * d.L + i * 0.075 * d.L)} ${f(y)}v6`).join("")}" stroke="#d6d0c4" stroke-width="1.5" fill="none"/>`;
    inner += rect(0.28 * d.L, -0.84 * d.H, 0.1 * d.L, 5, `fill="#3b82f6"`) + rect(0.38 * d.L, -0.84 * d.H, 0.08 * d.L, 5, `fill="#ef4444"`);
  }
  const tf = `translate(${f(cx)} ${f(gy)})${skew ? ` skewY(${f(skew)})` : ""} scale(${f2(flip ? -scale : scale)} ${f2(scale)})`;
  let out = `<g transform="${tf}">${inner}</g>`;
  if (v.state === "unknown") {
    out += `<text x="${f(cx)}" y="${f(gy - (d.H + 8) * scale)}" class="t" font-size="26" fill="${COL.line}" text-anchor="middle">?</text>`;
  }
  if (burning) {
    const fw = len * 0.6 * scale;
    out += glow(cx, gy - visH * scale * 0.7, fw, 70 * scale, 0.6);
    out += flame(rng, cx, gy - visH * scale * 0.45, fw, (70 + visH * 0.8) * scale, rng.range(-12, 12), 0.92);
  }
  if (v.tag) out += tagLabel(v.tag, cx, gy - (visH + 34) * scale - (burning ? 60 * scale : 0));
  return out;
}

/** Vehículo en planta. */
function vehicleTop(rng: Rng, v: VehicleDraw, cx: number, cy: number, angle: number, scale: number): string {
  const d = VEH[v.kind];
  const burning = v.burning || v.state === "burning";
  const st = vehicleStyle(burning, v.state === "unknown", v.engine === true, v.dim === true);
  let inner: string;
  switch (v.state) {
    case "overturned": {
      const under = vehicleStyle(burning, false, v.engine === true, true);
      const wheel = (x: number, y: number): string => rect(x - 0.06 * d.L, y - 5, 0.12 * d.L, 10, under.wheel);
      inner =
        rect(-d.L / 2, -d.W / 2, d.L, d.W, `fill="#0f1419" stroke="${COL.line}" stroke-width="2" rx="10"`) +
        `<path d="M${f(-0.3 * d.L)} ${f(-d.W * 0.4)}V${f(d.W * 0.4)}M${f(0.3 * d.L)} ${f(-d.W * 0.4)}V${f(d.W * 0.4)}M${f(-0.3 * d.L)} 0H${f(0.3 * d.L)}" stroke="${COL.dim}" stroke-width="2"/>` +
        wheel(-0.3 * d.L, -d.W * 0.4) + wheel(-0.3 * d.L, d.W * 0.4) + wheel(0.3 * d.L, -d.W * 0.4) + wheel(0.3 * d.L, d.W * 0.4);
      break;
    }
    case "on_side": {
      const w = d.H * 0.9;
      inner =
        topProfile(v.kind, st, w) +
        rect(-0.36 * d.L, w / 2, 0.14 * d.L, 8, st.wheel) +
        rect(0.22 * d.L, w / 2, 0.14 * d.L, 8, st.wheel);
      break;
    }
    case "crushed": {
      const jag: Pt[] = [];
      for (let i = 0; i <= 10; i++) {
        const t = i / 10;
        jag.push([lerp(-d.L / 2, d.L / 2, t), -d.W / 2 + (i % 2 === 0 ? 0 : 7) + rng.range(-2, 2)]);
      }
      for (let i = 10; i >= 0; i--) {
        const t = i / 10;
        jag.push([lerp(-d.L / 2, d.L / 2, t) * 0.92, d.W / 2 - (i % 2 === 0 ? 0 : 6) + rng.range(-2, 2)]);
      }
      inner = poly(jag, st.body) + hatchRect(-d.L * 0.3, -d.W * 0.35, d.L * 0.6, d.W * 0.7);
      break;
    }
    default:
      inner = topProfile(v.kind, st);
  }
  if (v.engine) {
    inner += `<path d="M${f(-0.42 * d.L)} -8H${f(0.2 * d.L)}M${f(-0.42 * d.L)} 8H${f(0.2 * d.L)}${Array.from({ length: 8 }, (_, i) => `M${f(-0.4 * d.L + i * 0.08 * d.L)} -8v16`).join("")}" stroke="#d6d0c4" stroke-width="1.5" fill="none"/>`;
  }
  let out = `<g transform="translate(${f(cx)} ${f(cy)}) rotate(${f(angle)}) scale(${f2(scale)})">${inner}</g>`;
  if (burning) out += flameTop(rng, cx, cy, d.L * 0.36 * scale, 0.92);
  if (v.tag) out += tagLabel(v.tag, cx, cy - d.L * 0.38 * scale - 6);
  return out;
}

/* ───────────── pictogramas de contexto ───────────── */

function gasCylinders(x: number, gy: number, n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) {
    const cx = x + i * 30;
    out += rect(cx - 12, gy - 62, 24, 62, `rx="10" fill="#3a2f1a" stroke="#d4a24a" stroke-width="2"`);
    out += rect(cx - 5, gy - 71, 10, 9, `fill="#1b2532" stroke="#d4a24a" stroke-width="1.5"`);
    out += `<path d="M${f(cx - 12)} ${f(gy - 40)}h24" stroke="#d4a24a" stroke-width="1"/>`;
  }
  return out;
}

function hydrant(x: number, gy: number, s: number): string {
  return (
    `<g transform="translate(${f(x)} ${f(gy)}) scale(${f2(s)})">` +
    rect(-11, -48, 22, 44, `rx="3" fill="#5c1d1a" stroke="#e05a4f" stroke-width="2"`) +
    `<path d="M-14 -48a14 12 0 0 1 28 0Z" fill="#5c1d1a" stroke="#e05a4f" stroke-width="2"/>` +
    rect(-20, -36, 9, 9, `fill="#e8c547"`) + rect(11, -36, 9, 9, `fill="#e8c547"`) +
    rect(-16, -5, 32, 5, `fill="#5c1d1a" stroke="#e05a4f" stroke-width="1.5"`) +
    `</g>`
  );
}

function puddle(rng: Rng, cx: number, cy: number, rx: number, ry: number): string {
  const p: Pt[] = [];
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2;
    const k = rng.range(0.75, 1.12);
    p.push([cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k]);
  }
  return poly(p, `fill="#0a0e13" fill-opacity=".85" stroke="#4fa3a5" stroke-width="2" stroke-dasharray="10 5"`) +
    `<ellipse cx="${f(cx - rx * 0.2)}" cy="${f(cy - ry * 0.15)}" rx="${f(rx * 0.35)}" ry="${f(ry * 0.25)}" fill="none" stroke="#7c6fb0" stroke-width="1.5" opacity=".7"/>`;
}

function crowd(rng: Rng, x0: number, gy: number, n: number, s: number): string {
  let out = "";
  for (let i = 0; i < n; i++) out += figure(x0 + i * 26 * s + rng.range(-6, 6), gy + rng.range(-3, 3), (52 + rng.range(-6, 6)) * s, "full", false);
  return out;
}

/** Postes y tendido que cruzan todo el cuadro. */
function powerLinesElev(gy: number, topY: number): string {
  const poles = [44, W - 44];
  let out = "";
  for (const x of poles) {
    out += rect(x - 5, topY, 10, gy - topY, `fill="#2b2620" stroke="#6b5f50" stroke-width="1.5"`);
    out += `<path d="M${x - 40} ${f(topY + 16)}H${x + 40}" stroke="#6b5f50" stroke-width="5"/>`;
  }
  const wires = [-34, 0, 34]
    .map((dx, i) => `M${f(poles[0] + dx)} ${f(topY + 14)}Q640 ${f(topY + 70 + i * 8)} ${f(poles[1] + dx)} ${f(topY + 14)}`)
    .join("");
  return out + `<path d="${wires}" fill="none" stroke="#a1a9b4" stroke-width="2"/>`;
}

function streetSign(text: string, px: number, gy: number, poleH: number): string {
  const pw = 28 + Array.from(text).length * 10.4;
  const top = gy - poleH;
  return (
    `<path d="M${f(px)} ${f(gy)}V${f(top)}" stroke="#9aa5b3" stroke-width="5"/>` +
    rect(px - 14, top - 34, pw, 34, `rx="3" fill="#1d4d3a" stroke="#e8eef5" stroke-width="2"`) +
    `<text x="${f(px - 14 + pw / 2)}" y="${f(top - 10)}" class="t" font-size="20" font-weight="700" fill="#f1f5f9" text-anchor="middle">${escapeXml(text)}</text>`
  );
}

function streetLabelTop(text: string, x: number, y: number): string {
  const pw = 28 + Array.from(text).length * 10.4;
  return (
    rect(x, y - 15, pw, 30, `rx="3" fill="#1d4d3a" stroke="#e8eef5" stroke-width="2"`) +
    `<text x="${f(x + pw / 2)}" y="${f(y + 7)}" class="t" font-size="19" font-weight="700" fill="#f1f5f9" text-anchor="middle">${escapeXml(text)}</text>`
  );
}

/* ───────────── escena estructural en elevación ───────────── */

interface Face {
  x: number;
  w: number;
  h: number;
  rise: number;
  shrink: number;
  cols: number;
}

interface Slot {
  pts: Pt[];
  cx: number;
  top: number;
  bottom: number;
  w: number;
}

function fp(face: Face, u: number, v: number): Pt {
  return [face.x + u * face.w, GY - u * face.rise - v * face.h * (1 - u * face.shrink)];
}

interface Building {
  faces: Face[];
  slots: Slot[][];
  left: number;
  right: number;
  topY: number;
  floorH: number;
}

function layoutBuilding(n: Norm, rng: Rng): Building {
  const house = n.building === "house";
  const F = n.floors;
  const floorH = house ? Math.min(112, 320 / F) : Math.min(92, 440 / F);
  const h = floorH * F;
  const mainW = house ? 470 : 540;
  const sideW = house ? 380 : 420;
  const mainCols = house ? 3 : 4;
  const sideCols = house ? 2 : 3;
  let faces: Face[];
  if (n.view === "corner") {
    faces = [
      { x: 0, w: mainW * 0.78, h, rise: 0, shrink: 0, cols: mainCols },
      { x: 0, w: sideW * 0.52, h, rise: 24, shrink: 0.14, cols: sideCols },
    ];
  } else if (n.view === "side") {
    faces = [{ x: 0, w: sideW, h, rise: 0, shrink: 0, cols: sideCols }];
  } else {
    faces = [{ x: 0, w: mainW, h, rise: 0, shrink: 0, cols: mainCols }];
  }
  const total = faces.reduce((s, fc) => s + fc.w, 0);
  let x = W / 2 - total / 2 + rng.range(-24, 24);
  for (const fc of faces) {
    fc.x = x;
    x += fc.w;
  }
  const slots: Slot[][] = [];
  for (let fl = 0; fl < F; fl++) {
    const row: Slot[] = [];
    for (const fc of faces) {
      for (let c = 0; c < fc.cols; c++) {
        const u0 = (c + 0.22) / fc.cols;
        const u1 = (c + 0.78) / fc.cols;
        const v0 = (fl + 0.22) / F;
        const v1 = (fl + 0.78) / F;
        const p = [fp(fc, u0, v0), fp(fc, u1, v0), fp(fc, u1, v1), fp(fc, u0, v1)];
        const xs = p.map((q) => q[0]);
        const ys = p.map((q) => q[1]);
        row.push({
          pts: p,
          cx: (Math.min(...xs) + Math.max(...xs)) / 2,
          top: Math.min(...ys),
          bottom: Math.max(...ys),
          w: Math.max(...xs) - Math.min(...xs),
        });
      }
    }
    slots.push(row);
  }
  return { faces, slots, left: faces[0].x, right: x, topY: GY - h, floorH };
}

function slotAt(b: Building, floor: number, pos: PosterPosition): { slot: Slot; col: number } {
  const row = b.slots[clamp(floor - 1, 0, b.slots.length - 1)];
  const col = pos === "left" ? 0 : pos === "right" ? row.length - 1 : Math.floor((row.length - 1) / 2);
  return { slot: row[col], col };
}

/** Vecina (exposición) en elevación, recortada por el borde del cuadro. */
function exposureElev(rng: Rng, side: "left" | "right", b: Building, house: boolean): string {
  const gap = rng.range(26, 46);
  const x0 = side === "left" ? -12 : b.right + gap;
  const x1 = side === "left" ? b.left - gap : W + 12;
  if (x1 - x0 < 50) return "";
  const hh = Math.max(110, (GY - b.topY) * rng.range(0.6, 1.05));
  const top = GY - hh;
  let out = rect(x0, top, x1 - x0, hh, `fill="#18212c" stroke="${COL.dim}" stroke-width="2"`);
  const rows = Math.max(1, Math.round(hh / Math.max(70, b.floorH)));
  const rh = hh / rows;
  let d = "";
  for (let r = 0; r < rows; r++) {
    for (let x = x0 + 24; x + 34 < x1 - 10; x += 70) {
      d += `M${f(x)} ${f(top + r * rh + rh * 0.28)}h34v${f(rh * 0.42)}h-34Z`;
    }
  }
  out += `<path d="${d}" fill="${COL.win}" stroke="${COL.dim}" stroke-width="1"/>`;
  out += house
    ? poly([[x0 - 10, top], [x1 + 10, top], [(x0 + x1) / 2, top - 52]], `fill="#18212c" stroke="${COL.dim}" stroke-width="2"`)
    : rect(x0 - 4, top - 8, x1 - x0 + 8, 8, `fill="#18212c" stroke="${COL.dim}" stroke-width="1.5"`);
  return out;
}

function roofElev(n: Norm, b: Building, rng: Rng): { svg: string; peakY: number } {
  const roofAttr = `fill="#232b35" stroke="${COL.line}" stroke-width="2" stroke-linejoin="round"`;
  const top = b.topY;
  if (n.building === "apartment") {
    let svg = "";
    for (const fc of b.faces) {
      const a = fp(fc, 0, 1);
      const c = fp(fc, 1, 1);
      svg += poly([a, c, [c[0], c[1] - 10], [a[0], a[1] - 10]], roofAttr);
    }
    const m = b.faces[0];
    svg += rect(m.x + m.w * rng.range(0.55, 0.72), top - 42, 52, 32, `fill="#1b2532" stroke="${COL.dim}" stroke-width="1.5"`);
    return { svg, peakY: top - 42 };
  }
  const rh = Math.min(105, b.floorH * 0.95);
  const m = b.faces[0];
  if (n.view === "side") {
    return { svg: poly([[m.x - 14, top], [m.x + m.w + 14, top], [m.x + m.w / 2, top - rh]], roofAttr), peakY: top - rh };
  }
  if (n.view === "corner" && b.faces[1]) {
    const s = b.faces[1];
    const c = fp(s, 0, 1);
    const sr = fp(s, 1, 1);
    const apex: Pt = [(c[0] + sr[0]) / 2, (c[1] + sr[1]) / 2 - rh * (1 - 0.5 * s.shrink)];
    const main = poly([[m.x - 14, top], c, apex, [m.x - 14 + (apex[0] - c[0]), apex[1]]], roofAttr);
    const gable = poly([c, apex, [sr[0] + 8, sr[1]]], roofAttr);
    return { svg: main + gable, peakY: apex[1] };
  }
  return {
    svg: poly([[m.x - 14, top], [m.x + m.w + 14, top], [m.x + m.w * 0.8, top - rh], [m.x + m.w * 0.2, top - rh]], roofAttr),
    peakY: top - rh,
  };
}

function structureElevation(n: Norm, rng: Rng): string {
  const b = layoutBuilding(n, rng);
  const house = n.building === "house";
  const wind = rng.range(-0.5, 0.8);
  const out: string[] = [];

  // Suelo: vereda y calzada (o patio en vista posterior).
  if (n.view === "rear") {
    out.push(rect(0, GY, W, BAND_Y - GY, `fill="#18201b"`));
    let pick = "";
    for (let x = 6; x < W; x += 22) pick += `M${x} 640v-34`;
    out.push(`<path d="M0 622H${W}M0 638H${W}${pick}" stroke="#4d5a52" stroke-width="2"/>`);
  } else {
    out.push(rect(0, GY, W, 22, `fill="#222d3a"`));
    out.push(rect(0, GY + 22, W, BAND_Y - GY - 22, `fill="#19222d"`));
    out.push(`<path d="M0 ${GY + 22}H${W}" stroke="${COL.dim}" stroke-width="2"/><path d="M0 652H${W}" stroke="#6b7686" stroke-width="3" stroke-dasharray="34 26"/>`);
  }

  if (n.exposures.left) out.push(exposureElev(rng, "left", b, house));
  if (n.exposures.right) out.push(exposureElev(rng, "right", b, house));

  // Fachadas.
  for (const fc of b.faces) {
    out.push(poly([fp(fc, 0, 0), fp(fc, 1, 0), fp(fc, 1, 1), fp(fc, 0, 1)], `class="b"`));
    let fl = "";
    for (let i = 1; i < n.floors; i++) {
      const a = fp(fc, 0, i / n.floors);
      const c = fp(fc, 1, i / n.floors);
      fl += `M${f(a[0])} ${f(a[1])}L${f(c[0])} ${f(c[1])}`;
    }
    if (fl) out.push(`<path d="${fl}" class="d"/>`);
  }
  if (b.faces.length > 1) {
    const c0 = fp(b.faces[1], 0, 0);
    const c1 = fp(b.faces[1], 0, 1);
    out.push(`<path d="M${f(c0[0])} ${f(c0[1])}L${f(c1[0])} ${f(c1[1])}" stroke="${COL.line}" stroke-width="3"/>`);
  }

  // Ventanas y puerta (todo en dos trazados para mantener el archivo liviano).
  const m = b.faces[0];
  const doorCol = Math.floor((m.cols - 1) / 2);
  let winD = "";
  let mull = "";
  b.slots.forEach((row, fl) => {
    row.forEach((s, ci) => {
      if (fl === 0 && ci === doorCol) return;
      winD += `M${pts(s.pts).replace(/ /g, "L")}Z`;
      if (house) mull += `M${f(s.cx)} ${f(s.top)}V${f(s.bottom)}`;
    });
  });
  out.push(`<path d="${winD}" class="w"/>`);
  if (mull) out.push(`<path d="${mull}" class="d"/>`);
  const du0 = (doorCol + 0.36) / m.cols;
  const du1 = (doorCol + 0.64) / m.cols;
  out.push(poly([fp(m, du0, 0), fp(m, du1, 0), fp(m, du1, 0.72 / n.floors), fp(m, du0, 0.72 / n.floors)], `fill="#10161e" stroke="${COL.line}" stroke-width="2"`));

  // Balcones: en departamentos desde el 2º piso; en casas solo si hay persona en balcón.
  const balconySlots: Slot[] = [];
  if (!house) b.slots.forEach((row, fl) => { if (fl > 0) balconySlots.push(...row); });
  let personSlot: Slot | null = null;
  if (n.person) {
    personSlot = slotAt(b, n.person.floor, n.person.position).slot;
    if (n.person.balcony && !balconySlots.includes(personSlot)) balconySlots.push(personSlot);
  }
  const railing = (s: Slot): string => {
    const rh = (s.bottom - s.top) * 0.42;
    return `M${f(s.cx - s.w / 2 - 9)} ${f(s.bottom + 5)}h${f(s.w + 18)}v${f(-rh)}h${f(-(s.w + 18))}Z`;
  };
  if (balconySlots.length) {
    out.push(`<path d="${balconySlots.map(railing).join("")}" fill="#1b2532" fill-opacity=".6" stroke="${COL.line}" stroke-width="1.5"/>`);
  }

  const roof = roofElev(n, b, rng);
  out.push(roof.svg);

  // Daño de techumbre: parche sombreado sobre la cubierta.
  if (n.extras.has("roof_damage")) {
    const pos = n.fire?.position ?? "center";
    const cx = slotAt(b, n.floors, pos).slot.cx;
    const y0 = house ? b.topY - (b.topY - roof.peakY) * 0.75 : b.topY - 12;
    const y1 = house ? b.topY - 4 : b.topY + 16;
    const p: Pt[] = [];
    for (let i = 0; i <= 6; i++) p.push([cx - 60 + i * 20, (i % 2 ? y0 + 10 : y0) + rng.range(-4, 4)]);
    p.push([cx + 66, y1], [cx - 66, y1]);
    out.push(poly(p, `fill="#0b0d10"`) + poly(p, `fill="url(#ht)" stroke="#e2a24a" stroke-width="2"`));
  }

  // Fuego.
  let smokeSrc: Pt | null = null;
  if (n.fire) {
    const ip = INTENSITY[n.fire.intensity];
    const { slot, col } = slotAt(b, n.fire.floor, n.fire.position);
    const sites: Slot[] = [slot];
    if (n.fire.intensity === "heavy") {
      const row = b.slots[n.fire.floor - 1];
      if (row[col - 1]) sites.push(row[col - 1]);
      if (row[col + 1]) sites.push(row[col + 1]);
      if (b.slots[n.fire.floor]) sites.push(b.slots[n.fire.floor][col]);
    }
    for (const s of sites) {
      const sh = s.bottom - s.top;
      out.push(poly(s.pts, `fill="#ff8a2a" opacity="${f2(ip.glow)}"`));
      out.push(glow(s.cx, s.top, s.w * 1.2, sh * 1.2, ip.glow));
      out.push(flame(rng, s.cx, s.bottom - 2, s.w * (n.fire.intensity === "heavy" ? 1.35 : 1.05), (sh / 0.56) * ip.h, wind * 30, ip.op));
    }
    if (n.fire.intensity === "heavy" && n.fire.floor === n.floors) {
      out.push(flame(rng, slot.cx, b.topY + 6, slot.w * 2.2, (b.topY - roof.peakY + 60) * 1.4, wind * 40, ip.op));
    }
    smokeSrc = [slot.cx, slot.top - 10];
  }

  // Humo.
  if (n.smoke) {
    const src: Pt = smokeSrc ?? [slotAt(b, n.floors, n.smoke.position).slot.cx, roof.peakY];
    out.push(smokeRising(rng, n.smoke.color, n.smoke.volume, src[0], Math.min(src[1], roof.peakY + 20), wind));
  }

  // Persona (después del humo para que siempre se lea).
  if (n.person && personSlot) {
    const s = personSlot;
    const sh = s.bottom - s.top;
    if (n.person.balcony) {
      out.push(figure(s.cx, s.bottom + 3, sh * 1.15, "full", true));
      out.push(`<path d="${railing(s)}" fill="#1b2532" fill-opacity=".45" stroke="${COL.line}" stroke-width="1.5"/>`);
    } else {
      out.push(figure(s.cx, s.bottom - 1, sh * 0.62, "bust", true));
    }
  }

  // Elementos de contexto a nivel de suelo.
  if (n.extras.has("gas_cylinders")) out.push(gasCylinders(b.right - 96, GY, 3));
  if (n.extras.has("crowd")) out.push(crowd(rng, 170, GY + 14, 7, 1));
  if (n.extras.has("hydrant")) out.push(hydrant(W - 92, GY + 16, 1));
  if (n.extras.has("traffic_queue")) {
    for (let i = 0; i < 5; i++) out.push(vehicleElev(rng, { kind: "car", state: "upright", burning: false, dim: true }, "side", 60 + i * 82, 634, 0.42, false, 0));
  }
  if (n.extras.has("fuel_spill")) out.push(puddle(rng, 640 + rng.range(-60, 60), 668, 130, 12));
  if (n.extras.has("fire_engine")) out.push(vehicleElev(rng, { kind: "truck", state: "upright", burning: false, engine: true }, "side", 1010, 678, 0.85, false, 0));
  for (const v of n.vehicles) {
    out.push(vehicleElev(rng, { kind: v.kind, state: v.state, burning: v.burning === true, tag: v.tag }, "side", v.x * W, 678, 0.85, false, 0));
  }
  if (n.extras.has("power_lines")) out.push(powerLinesElev(GY + 14, Math.max(TOP + 30, Math.min(150, roof.peakY - 10))));
  if (n.street) out.push(streetSign(n.street, 116, GY + 16, 120));
  return out.join("");
}

/* ───────────── colisión en elevación ───────────── */

function skyline(rng: Rng, x0: number, x1: number, base: number, hMin: number, hMax: number): string {
  let d = "";
  for (let x = x0; x < x1; ) {
    const w = rng.range(70, 190);
    const h = rng.range(hMin, hMax);
    d += `M${f(x)} ${f(base)}V${f(base - h)}H${f(Math.min(x1, x + w))}V${f(base)}`;
    x += w + rng.range(4, 24);
  }
  return `<path d="${d}" fill="#18212c" stroke="${COL.dim}" stroke-width="1.5"/>`;
}

function collisionElevation(n: Norm, rng: Rng): string {
  const out: string[] = [];
  const view = n.view;
  const persp = view === "front" || view === "rear";
  const horizon = persp ? 400 : view === "corner" ? 392 : 470;
  const wind = rng.range(-0.5, 0.8);
  const vpx = view === "corner" ? 1040 + rng.range(-30, 30) : 640 + rng.range(-40, 40);

  out.push(skyline(rng, -10, W + 10, horizon, persp ? 40 : 70, persp ? 140 : 190));
  if (n.exposures.left) out.push(rect(-10, horizon - 300, 230, 300, `fill="#1a2330" stroke="${COL.line}" stroke-width="2"`) + `<path d="M30 ${horizon - 250}h40v40h-40ZM120 ${horizon - 250}h40v40h-40ZM30 ${horizon - 150}h40v40h-40ZM120 ${horizon - 150}h40v40h-40Z" class="w"/>`);
  if (n.exposures.right) out.push(rect(W - 220, horizon - 300, 230, 300, `fill="#1a2330" stroke="${COL.line}" stroke-width="2"`) + `<path d="M${W - 180} ${horizon - 250}h40v40h-40ZM${W - 90} ${horizon - 250}h40v40h-40ZM${W - 180} ${horizon - 150}h40v40h-40ZM${W - 90} ${horizon - 150}h40v40h-40Z" class="w"/>`);

  // Calzada.
  if (view === "side") {
    out.push(rect(0, horizon, W, 16, `fill="#222d3a"`) + rect(0, horizon + 16, W, BAND_Y - horizon - 16, `fill="#19222d"`));
    out.push(`<path d="M0 ${horizon + 16}H${W}" stroke="${COL.dim}" stroke-width="2"/><path d="M0 566H${W}M0 628H${W}" stroke="#6b7686" stroke-width="3" stroke-dasharray="34 26"/>`);
  } else {
    const spread = view === "corner" ? [-300, 1700] : [-320, W + 320];
    out.push(rect(0, horizon, W, BAND_Y - horizon, `fill="#1e2833"`));
    out.push(poly([[spread[0], BAND_Y], [spread[1], BAND_Y], [vpx + 24, horizon], [vpx - 24, horizon]], `fill="#19222d" stroke="${COL.dim}" stroke-width="2"`));
    const lanes = [0.3, 0.5, 0.7]
      .map((t) => `M${f(lerp(spread[0], spread[1], t))} ${BAND_Y}L${f(vpx + (t - 0.5) * 20)} ${horizon}`)
      .join("");
    out.push(`<path d="${lanes}" stroke="#6b7686" stroke-width="3" stroke-dasharray="30 24"/>`);
  }
  out.push(`<path d="M0 ${horizon}H${W}" stroke="${COL.dim}" stroke-width="1.5"/>`);

  const lane = (i: number): { gy: number; s: number } => {
    const k = i % 3;
    if (view === "side") return [{ gy: 672, s: 1 }, { gy: 610, s: 0.85 }, { gy: 548, s: 0.7 }][k];
    if (persp) return [{ gy: 670, s: 1.5 }, { gy: 590, s: 1.15 }, { gy: 520, s: 0.85 }][k];
    return [{ gy: 668, s: 1 }, { gy: 612, s: 0.8 }, { gy: 560, s: 0.62 }][k];
  };
  const mode: "side" | "front" | "rear" = view === "front" ? "front" : view === "rear" ? "rear" : "side";
  const skew = view === "corner" ? -7 : 0;

  if (n.extras.has("traffic_queue")) {
    const q = { kind: "car" as const, state: "upright" as const, burning: false, dim: true };
    for (let i = 0; i < 6; i++) {
      if (persp) {
        const t = i / 6;
        out.push(vehicleElev(rng, q, mode, lerp(vpx - 210, vpx - 18, t), lerp(560, horizon + 14, t), lerp(0.9, 0.22, t), false, 0));
      } else {
        out.push(vehicleElev(rng, q, "side", 40 + i * 70, horizon + 66, 0.5, false, skew));
      }
    }
  }
  if (n.extras.has("fuel_spill")) {
    const first = n.vehicles[0];
    out.push(puddle(rng, first ? first.x * W + 40 : 640, lane(0).gy + 4, 170, 16));
  }
  if (n.extras.has("gas_cylinders")) out.push(gasCylinders(view === "side" ? 330 : 140, horizon + 70, 2));
  if (n.extras.has("hydrant")) out.push(hydrant(W - 70, persp ? 600 : horizon + 30, persp ? 1.1 : 0.75));
  if (n.extras.has("crowd")) out.push(crowd(rng, persp ? 30 : 900, persp ? 640 : horizon + 18, 6, persp ? 1.2 : 0.7));
  if (n.extras.has("fire_engine")) {
    const l = lane(2);
    out.push(vehicleElev(rng, { kind: "truck", state: "upright", burning: false, engine: true }, mode, persp ? vpx + 200 : 1110, l.gy, l.s * (persp ? 0.9 : 0.85), true, skew));
  }

  // Vehículos de atrás hacia adelante.
  const order = n.vehicles.map((v, i) => ({ v, i })).sort((a, b) => (b.i % 3) - (a.i % 3) || a.i - b.i);
  let burningAt: Pt | null = null;
  for (const { v, i } of order) {
    const l = lane(i);
    const flip = i % 2 === 1;
    out.push(vehicleElev(rng, { kind: v.kind, state: v.state, burning: v.burning === true, tag: v.tag }, mode, v.x * W, l.gy, l.s, flip, skew));
    if (!burningAt && (v.burning || v.state === "burning")) burningAt = [v.x * W, l.gy - VEH[v.kind].H * l.s];
  }

  if (n.fire) {
    const ip = INTENSITY[n.fire.intensity];
    const x = POS_U[n.fire.position] * W;
    const gy = lane(0).gy;
    out.push(glow(x, gy - 40, 140 * ip.h, 80 * ip.h, ip.glow));
    out.push(flame(rng, x, gy, 120 + 60 * ip.h, 90 * ip.h + 40, wind * 30, ip.op));
    burningAt = burningAt ?? [x, gy - 90 * ip.h];
  }
  if (n.smoke) {
    const src: Pt = burningAt ?? [POS_U[n.smoke.position] * W, lane(0).gy - 60];
    out.push(smokeRising(rng, n.smoke.color, n.smoke.volume, src[0], src[1], wind));
  }
  if (n.person) {
    const x = POS_U[n.person.position] * W + 40;
    out.push(figure(x, lane(0).gy + 4, persp ? 120 : 100, "full", true));
  }
  if (n.extras.has("power_lines")) out.push(powerLinesElev(persp ? 650 : horizon + 12, TOP + 40));
  if (n.street) out.push(persp ? streetSign(n.street, 96, 660, 150) : streetSign(n.street, 140, horizon + 14, 110));
  return out.join("");
}

/* ───────────── vista aérea ───────────── */

function aerialBlocks(rng: Rng, y0: number, y1: number): string {
  let d = "";
  for (let x = -20; x < W + 20; ) {
    const w = rng.range(110, 230);
    d += `M${f(x)} ${f(y0)}h${f(w)}V${f(y1)}h${f(-w)}Z`;
    x += w + rng.range(14, 30);
  }
  return `<path d="${d}" fill="#18212c" stroke="${COL.dim}" stroke-width="1.5"/>`;
}

function structureAerial(n: Norm, rng: Rng): string {
  const out: string[] = [];
  const house = n.building === "house";
  const bw = house ? 400 : 470;
  const bh = house ? 230 : 270;
  const x0 = W / 2 - bw / 2 + rng.range(-30, 30);
  const y0 = 548 - 70 - bh;
  const roadTop = 566;
  const angle = rng.range(-1.2, -0.45);

  out.push(rect(0, TOP, W, roadTop - TOP, `fill="#17202b"`));
  // Deslindes de predios.
  out.push(`<path d="M${f(x0 - 18)} ${TOP}V548M${f(x0 + bw + 18)} ${TOP}V548" stroke="${COL.dim}" stroke-width="1.5" stroke-dasharray="8 6"/>`);
  out.push(rect(0, 548, W, 18, `fill="#232e3b"`));
  out.push(rect(0, roadTop, W, BAND_Y - roadTop, `fill="#1b2430"`));
  out.push(`<path d="M0 ${roadTop}H${W}" stroke="${COL.dim}" stroke-width="2"/><path d="M0 625H${W}" stroke="#6b7686" stroke-width="3" stroke-dasharray="34 26"/>`);

  if (n.exposures.left) out.push(rect(-20, y0 + 16, x0 - 36 + 20, bh - 32, `fill="#1c2531" stroke="${COL.dim}" stroke-width="2"`) + `<path d="M-20 ${f(y0 + bh / 2)}H${f(x0 - 36)}" class="d"/>`);
  if (n.exposures.right) out.push(rect(x0 + bw + 36, y0 + 10, W + 20 - (x0 + bw + 36), bh - 20, `fill="#1c2531" stroke="${COL.dim}" stroke-width="2"`) + `<path d="M${f(x0 + bw + 36)} ${f(y0 + bh / 2)}H${W + 20}" class="d"/>`);

  // Sombra proporcional a la altura (número de pisos).
  const so = n.floors * 7;
  out.push(poly([[x0 + bw, y0], [x0 + bw + so, y0 + so * 0.7], [x0 + bw + so, y0 + bh + so * 0.7], [x0 + so, y0 + bh + so * 0.7], [x0, y0 + bh]], `fill="#05080c" opacity=".55"`));

  // Cubierta.
  out.push(rect(x0, y0, bw, bh, `fill="#212b38" stroke="${COL.line}" stroke-width="2.5"`));
  if (house) {
    const r = bh / 2;
    out.push(`<path d="M${f(x0)} ${f(y0)}L${f(x0 + r)} ${f(y0 + r)}H${f(x0 + bw - r)}L${f(x0 + bw)} ${f(y0)}M${f(x0)} ${f(y0 + bh)}L${f(x0 + r)} ${f(y0 + r)}M${f(x0 + bw - r)} ${f(y0 + r)}L${f(x0 + bw)} ${f(y0 + bh)}" fill="none" stroke="${COL.line}" stroke-width="1.5"/>`);
  } else {
    out.push(rect(x0 + 10, y0 + 10, bw - 20, bh - 20, `class="d"`));
    out.push(rect(x0 + bw * 0.62, y0 + 34, 60, 40, `fill="#1b2532" stroke="${COL.dim}" stroke-width="1.5"`));
    out.push(circle(x0 + bw * 0.25, y0 + 60, 22, `fill="#1b2532" stroke="${COL.dim}" stroke-width="1.5"`));
    let bal = "";
    for (let i = 0; i < 4; i++) bal += `M${f(x0 + bw * (0.1 + i * 0.22))} ${f(y0 + bh)}v14h${f(bw * 0.14)}v-14`;
    out.push(`<path d="${bal}" fill="none" stroke="${COL.line}" stroke-width="2"/>`);
  }

  const fireU = n.fire ? POS_U[n.fire.position] : 0.5;
  if (n.extras.has("roof_damage")) {
    const cx = x0 + bw * fireU;
    const cy = y0 + bh * 0.45;
    const p: Pt[] = [];
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const k = i % 2 ? rng.range(0.6, 0.8) : rng.range(0.9, 1.1);
      p.push([cx + Math.cos(a) * 75 * k, cy + Math.sin(a) * 55 * k]);
    }
    out.push(poly(p, `fill="#0b0d10"`) + poly(p, `fill="url(#ht)" stroke="#e2a24a" stroke-width="2"`));
  }

  let smokeSrc: Pt = [x0 + bw * (n.smoke ? POS_U[n.smoke.position] : 0.5), y0 + bh * 0.45];
  if (n.fire) {
    const ip = INTENSITY[n.fire.intensity];
    const onRoof = n.fire.floor >= n.floors || n.fire.intensity === "heavy";
    const cx = x0 + bw * fireU;
    const cy = onRoof ? y0 + bh * 0.45 : y0 + bh + 6;
    const r = n.fire.intensity === "light" ? 26 : n.fire.intensity === "moderate" ? 50 : 90;
    out.push(flameTop(rng, cx, cy, onRoof ? r : r * 0.6, ip.op));
    smokeSrc = [cx, cy];
  }
  if (n.smoke) out.push(smokePlume(rng, n.smoke.color, n.smoke.volume, smokeSrc[0], smokeSrc[1], angle));
  if (n.person) out.push(figureTop(x0 + bw * POS_U[n.person.position], y0 + bh + (n.person.balcony ? 8 : -12)));

  if (n.extras.has("gas_cylinders")) {
    for (let i = 0; i < 3; i++) out.push(circle(x0 + bw - 70 + i * 22, y0 - 26, 9, `fill="#3a2f1a" stroke="#d4a24a" stroke-width="2"`));
  }
  if (n.extras.has("power_lines")) {
    let d = "";
    for (const dy of [-8, 0, 8]) d += `M0 ${540 + dy}H${W}`;
    out.push(`<path d="${d}M${f(x0 + 80)} 540L${f(x0 + 60)} ${f(y0 + bh)}" fill="none" stroke="#a1a9b4" stroke-width="1.5"/>`);
    for (const x of [130, 560, 990]) out.push(circle(x, 540, 8, `fill="#2b2620" stroke="#6b5f50" stroke-width="2"`));
  }
  if (n.extras.has("hydrant")) {
    const hx = Math.min(W - 40, x0 + bw + 130);
    out.push(circle(hx, 557, 9, `fill="#5c1d1a" stroke="#e05a4f" stroke-width="2.5"`) + `<path d="M${f(hx - 13)} 557h26" stroke="#e8c547" stroke-width="3"/>`);
  }
  if (n.extras.has("crowd")) {
    for (let i = 0; i < 9; i++) out.push(circle(150 + i * 17 + rng.range(-4, 4), 557 + rng.range(-5, 5), 5, `fill="#7b8798"`));
  }
  if (n.extras.has("fuel_spill")) out.push(puddle(rng, 640 + rng.range(-80, 80), 632, 110, 26));
  if (n.extras.has("traffic_queue")) {
    for (let i = 0; i < 5; i++) out.push(vehicleTop(rng, { kind: "car", state: "upright", burning: false, dim: true }, 60 + i * 74, 655, 0, 0.38));
  }
  if (n.extras.has("fire_engine")) out.push(vehicleTop(rng, { kind: "truck", state: "upright", burning: false, engine: true }, 1060, 596, 180, 0.62));
  n.vehicles.forEach((v, i) => {
    const far = i % 2 === 0;
    out.push(vehicleTop(rng, { kind: v.kind, state: v.state, burning: v.burning === true, tag: v.tag }, v.x * W, far ? 596 : 654, (far ? 180 : 0) + rng.range(-5, 5), 0.6));
  });
  if (n.street) out.push(streetLabelTop(n.street, 24, 642));
  return out.join("");
}

function collisionAerial(n: Norm, rng: Rng): string {
  const out: string[] = [];
  const roadTop = 250;
  const roadBot = 540;
  const laneH = (roadBot - roadTop) / 4;
  const angle = rng.range(-1.3, -0.5);
  out.push(rect(0, TOP, W, BAND_Y - TOP, `fill="#17202b"`));
  out.push(aerialBlocks(rng, TOP + 14, 222) + aerialBlocks(rng, 568, BAND_Y + 10));
  if (n.exposures.left) out.push(rect(20, TOP + 10, 260, 158, `fill="#1c2531" stroke="${COL.line}" stroke-width="2"`));
  if (n.exposures.right) out.push(rect(W - 280, TOP + 10, 260, 158, `fill="#1c2531" stroke="${COL.line}" stroke-width="2"`));
  out.push(rect(0, roadTop - 16, W, 16, `fill="#232e3b"`) + rect(0, roadBot, W, 16, `fill="#232e3b"`));
  out.push(rect(0, roadTop, W, roadBot - roadTop, `fill="#1b2430"`));
  out.push(`<path d="M0 ${f(roadTop + laneH)}H${W}M0 ${f(roadTop + laneH * 3)}H${W}" stroke="#6b7686" stroke-width="3" stroke-dasharray="34 26"/><path d="M0 ${f(roadTop + laneH * 2 - 3)}H${W}M0 ${f(roadTop + laneH * 2 + 3)}H${W}" stroke="#b59a3a" stroke-width="2"/>`);
  const laneY = (k: number): number => roadTop + (k + 0.5) * laneH;

  if (n.extras.has("traffic_queue")) {
    for (let i = 0; i < 4; i++) {
      for (const k of [2, 3]) out.push(vehicleTop(rng, { kind: "car", state: "upright", burning: false, dim: true }, 40 + i * 78, laneY(k), 0, 0.42));
    }
  }
  if (n.extras.has("fuel_spill")) {
    const first = n.vehicles[0];
    out.push(puddle(rng, first ? first.x * W + 30 : 640, laneY(2), 150, 48));
  }
  if (n.extras.has("power_lines")) {
    out.push(`<path d="M0 ${roadTop - 8}H${W}M0 ${roadTop - 2}H${W}" stroke="#a1a9b4" stroke-width="1.5"/>`);
    for (const x of [100, 520, 940]) out.push(circle(x, roadTop - 8, 8, `fill="#2b2620" stroke="#6b5f50" stroke-width="2"`));
  }
  if (n.extras.has("hydrant")) out.push(circle(W - 120, roadBot + 8, 9, `fill="#5c1d1a" stroke="#e05a4f" stroke-width="2.5"`) + `<path d="M${W - 133} ${roadBot + 8}h26" stroke="#e8c547" stroke-width="3"/>`);
  if (n.extras.has("crowd")) {
    for (let i = 0; i < 10; i++) out.push(circle(860 + i * 16 + rng.range(-4, 4), roadTop - 8 + rng.range(-4, 4), 5, `fill="#7b8798"`));
  }
  if (n.extras.has("gas_cylinders")) {
    for (let i = 0; i < 3; i++) out.push(circle(380 + i * 22, roadBot + 8, 9, `fill="#3a2f1a" stroke="#d4a24a" stroke-width="2"`));
  }
  if (n.extras.has("fire_engine")) out.push(vehicleTop(rng, { kind: "truck", state: "upright", burning: false, engine: true }, 1120, laneY(0), 180, 0.72));

  let fireAt: Pt | null = null;
  for (let i = 0; i < n.vehicles.length; i++) {
    const v = n.vehicles[i];
    const k = i % 4;
    const cx = v.x * W;
    const cy = laneY(k) + rng.range(-10, 10);
    const a = (k < 2 ? 180 : 0) + rng.range(-35, 35);
    out.push(vehicleTop(rng, { kind: v.kind, state: v.state, burning: v.burning === true, tag: v.tag }, cx, cy, a, 0.72));
    if (!fireAt && (v.burning || v.state === "burning")) fireAt = [cx, cy];
  }
  if (n.fire) {
    const ip = INTENSITY[n.fire.intensity];
    const cx = POS_U[n.fire.position] * W;
    out.push(flameTop(rng, cx, laneY(1), 30 + 40 * ip.h, ip.op));
    fireAt = fireAt ?? [cx, laneY(1)];
  }
  if (n.smoke) {
    const src: Pt = fireAt ?? [POS_U[n.smoke.position] * W, laneY(1)];
    out.push(smokePlume(rng, n.smoke.color, n.smoke.volume, src[0], src[1], angle));
  }
  if (n.person) out.push(figureTop(POS_U[n.person.position] * W + 60, laneY(2) + 30));
  if (n.street) out.push(streetLabelTop(n.street, 24, roadBot - 22));
  return out.join("");
}

/* ───────────── marco común ───────────── */

const VIEW_LABEL: Record<PosterView, string> = {
  front: "VISTA FRONTAL",
  side: "VISTA LATERAL",
  rear: "VISTA POSTERIOR",
  corner: "VISTA EN ESQUINA",
  aerial: "VISTA AÉREA (DRON, CENITAL)",
};

function defs(): string {
  return (
    `<defs>` +
    `<style>.t{font-family:${FONT}}.m{font-family:${MONO}}.b{fill:${COL.fill};stroke:${COL.line};stroke-width:2;stroke-linejoin:round}.w{fill:${COL.win};stroke:#5f6f84;stroke-width:1.5}.d{fill:none;stroke:${COL.dim};stroke-width:1}</style>` +
    `<pattern id="gr" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none" stroke="#2a3a4d" stroke-width="1"/></pattern>` +
    `<pattern id="ht" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><path d="M0 0V10" stroke="#e2a24a" stroke-width="2.5"/></pattern>` +
    `<radialGradient id="gw"><stop offset="0" stop-color="#ff9a3a" stop-opacity=".9"/><stop offset="1" stop-color="#ff5a1a" stop-opacity="0"/></radialGradient>` +
    `<linearGradient id="sk" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#111821"/><stop offset="1" stop-color="#202c3b"/></linearGradient>` +
    `<filter id="bl" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="9"/></filter>` +
    `</defs>`
  );
}

function chrome(n: Norm): string {
  const wm = escapeXml(POSTER_WATERMARK);
  return (
    // Marca de agua diagonal, grande y semitransparente.
    `<g transform="rotate(-14 640 380)" class="t" font-weight="700" text-anchor="middle">` +
    `<text x="640" y="392" font-size="56" textLength="1120" lengthAdjust="spacingAndGlyphs" fill="#ffffff" fill-opacity=".3" stroke="#000000" stroke-opacity=".35" stroke-width="1.5">${wm}</text>` +
    `<text x="640" y="434" font-size="24" fill="#ffffff" fill-opacity=".32">Boceto generado por computador · escena ficticia</text>` +
    `</g>` +
    // Barra superior: rótulo y reloj.
    rect(0, 0, W, BAR_H, `fill="#05080c" fill-opacity=".86"`) +
    rect(14, 10, 62, 26, `rx="4" fill="#b45309"`) +
    `<text x="45" y="29" class="t" font-size="17" font-weight="700" fill="#fff7ed" text-anchor="middle">DEMO</text>` +
    `<text x="90" y="31" class="t" font-size="23" font-weight="600" fill="${COL.text}">${escapeXml(n.caption)}</text>` +
    `<text x="${W - 16}" y="31" class="m" font-size="22" fill="${COL.text}" text-anchor="end">${escapeXml(n.clock)}</text>` +
    rect(0, BAR_H, W, SUB_H, `fill="#05080c" fill-opacity=".6"`) +
    `<text x="16" y="${BAR_H + 17}" class="t" font-size="15" letter-spacing="1" fill="#a9b4c2">CÁMARA · ${VIEW_LABEL[n.view]} · BOCETO TÁCTICO SIMULADO</text>` +
    // Banda inferior con la advertencia completa y la marca de esquina.
    rect(0, BAND_Y, W, H - BAND_Y, `fill="#05080c" fill-opacity=".8"`) +
    `<path d="M0 ${BAND_Y}H${W}" stroke="#f59e0b" stroke-width="2"/>` +
    `<text x="640" y="${BAND_Y + 25}" class="t" font-size="22" font-weight="700" letter-spacing="1" fill="#fbbf24" text-anchor="middle">${wm}</text>` +
    rect(W - 136, BAND_Y + 7, 124, 22, `rx="3" fill="none" stroke="#94a3b8" stroke-width="1"`) +
    `<text x="${W - 74}" y="${BAND_Y + 23}" class="t" font-size="14" font-weight="700" letter-spacing="1" fill="#cbd5e1" text-anchor="middle">VIGÍA · DEMO</text>`
  );
}

/**
 * Dibuja el póster como documento SVG autónomo de 1280×720.
 * Determinista: el mismo descriptor produce exactamente la misma cadena.
 */
export function renderPoster(spec: PosterSpec): string {
  const n = normalize(spec);
  const rng = makeRng(spec.variant);
  const aerial = n.view === "aerial";
  const body = aerial
    ? n.scene === "collision"
      ? collisionAerial(n, rng)
      : structureAerial(n, rng)
    : n.scene === "collision"
      ? collisionElevation(n, rng)
      : structureElevation(n, rng);
  const title = escapeXml(`Imagen de demostración (no es video real): ${n.caption}`);
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img">` +
    `<title>${title}</title>` +
    defs() +
    rect(0, 0, W, H, `fill="${aerial ? "#141c26" : "url(#sk)"}"`) +
    body +
    rect(0, 0, W, H, `fill="url(#gr)" opacity=".45"`) +
    chrome(n) +
    `</svg>`
  );
}
