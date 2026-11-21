/**
 * Colores del visor. El 2D usa directamente las utilidades de tokens (fill-accent,
 * stroke-critical…); el 3D necesita valores concretos: se leen de las variables CSS
 * del tema en tiempo de ejecución, con respaldo en los valores del tema "mando".
 */
import type { SmokeColor } from "@/lib/domain";

export type PaletteKey =
  | "bg"
  | "surface"
  | "surface2"
  | "line"
  | "lineStrong"
  | "text"
  | "muted"
  | "faint"
  | "accent"
  | "critical"
  | "warning"
  | "ok"
  | "info"
  | "drone";

export type Palette = Record<PaletteKey, string>;

/** Respaldo: valores del tema "mando" (globals.css). */
export const DEFAULT_PALETTE: Palette = {
  bg: "#0a0e13",
  surface: "#10161d",
  surface2: "#161e27",
  line: "#223040",
  lineStrong: "#33465c",
  text: "#e8eef4",
  muted: "#8fa0b4",
  faint: "#647487",
  accent: "#ff6a47",
  critical: "#ff4d4d",
  warning: "#ffb224",
  ok: "#35d49a",
  info: "#48b8ff",
  drone: "#a78bfa",
};

const TOKEN: Record<PaletteKey, string> = {
  bg: "bg",
  surface: "surface",
  surface2: "surface-2",
  line: "line",
  lineStrong: "line-strong",
  text: "text",
  muted: "muted",
  faint: "faint",
  accent: "accent",
  critical: "critical",
  warning: "warning",
  ok: "ok",
  info: "info",
  drone: "drone",
};

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const RGB = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/i;

/** Convierte "#abc", "#aabbcc" o "rgb(…)" a "#rrggbb"; null si no se reconoce (p. ej. oklch). */
export function toHex(value: string): string | null {
  const v = value.trim();
  if (HEX.test(v)) {
    if (v.length === 4) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`.toLowerCase();
    return v.toLowerCase();
  }
  const m = RGB.exec(v);
  if (m) {
    const h = (n: string) => Math.min(255, Number(n)).toString(16).padStart(2, "0");
    return `#${h(m[1])}${h(m[2])}${h(m[3])}`;
  }
  return null;
}

/** Lee la paleta del tema vigente para `el` (variables --color-* o --v-*). */
export function readPalette(el: Element | null): Palette {
  if (!el || typeof getComputedStyle !== "function") return DEFAULT_PALETTE;
  const cs = getComputedStyle(el);
  const out = { ...DEFAULT_PALETTE };
  for (const key of Object.keys(TOKEN) as PaletteKey[]) {
    const name = TOKEN[key];
    const raw = cs.getPropertyValue(`--color-${name}`) || cs.getPropertyValue(`--v-${name}`);
    const hex = raw ? toHex(raw) : null;
    if (hex) out[key] = hex;
  }
  return out;
}

/** Colores físicos del humo (no dependen del tema). */
export const SMOKE_HEX: Record<SmokeColor, string> = {
  none: "#8b95a1",
  white: "#e4e8ec",
  gray: "#8b95a1",
  black: "#26292e",
  brown: "#6e5340",
  yellow: "#c2b25a",
  unknown: "#8b95a1",
};
