/**
 * Colores para las capas WebGL de MapLibre. Las capas no entienden `var(--…)`, así que se leen
 * los tokens del sistema de diseño (variables --v-* de globals.css) del contenedor del mapa.
 * Si un token falta o viene en un formato que MapLibre no interpreta, se usa el respaldo.
 */
import type { MapTheme } from "./types";

export interface MapPalette {
  bg: string;
  surface: string;
  line: string;
  text: string;
  muted: string;
  accent: string;
  critical: string;
  warning: string;
  ok: string;
  info: string;
  drone: string;
}

const TOKENS: Record<keyof MapPalette, string> = {
  bg: "--v-bg",
  surface: "--v-surface",
  line: "--v-line",
  text: "--v-text",
  muted: "--v-muted",
  accent: "--v-fire",
  critical: "--v-critical",
  warning: "--v-warning",
  ok: "--v-ok",
  info: "--v-info",
  drone: "--v-drone",
};

/** Mismos valores que globals.css (mando = oscuro, vecino = claro). */
export const FALLBACK_PALETTE: Record<MapTheme, MapPalette> = {
  dark: {
    bg: "#0a0e13",
    surface: "#10161d",
    line: "#223040",
    text: "#e8eef4",
    muted: "#8fa0b4",
    accent: "#ea580c",
    critical: "#ff4d4d",
    warning: "#ffb224",
    ok: "#35d49a",
    info: "#48b8ff",
    drone: "#a78bfa",
  },
  light: {
    bg: "#fffdf9",
    surface: "#ffffff",
    line: "#e2dbd0",
    text: "#16130f",
    muted: "#5a5248",
    accent: "#ea580c",
    critical: "#b3141f",
    warning: "#8a5a00",
    ok: "#0f7a4a",
    info: "#0a62a8",
    drone: "#6a3fc9",
  },
};

const PARSEABLE = /^(#[0-9a-f]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\))$/i;

export function readPalette(el: Element | null, theme: MapTheme): MapPalette {
  const base = FALLBACK_PALETTE[theme];
  if (!el || typeof getComputedStyle !== "function") return base;
  const cs = getComputedStyle(el);
  const out = { ...base };
  for (const key of Object.keys(TOKENS) as (keyof MapPalette)[]) {
    const v = cs.getPropertyValue(TOKENS[key]).trim();
    if (PARSEABLE.test(v)) out[key] = v;
  }
  return out;
}
