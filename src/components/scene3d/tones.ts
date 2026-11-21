/**
 * Clases de Tailwind por tono, escritas de forma literal para que Tailwind las genere.
 * Todas apuntan a los tokens del sistema de diseño (cambian con el tema).
 */
import type { Tone } from "./icons";

export const TONE_TEXT: Record<Tone, string> = {
  critical: "text-critical",
  warning: "text-warning",
  accent: "text-accent",
  info: "text-info",
  ok: "text-ok",
  drone: "text-drone",
  muted: "text-muted",
  text: "text-text",
};

export const TONE_FILL: Record<Tone, string> = {
  critical: "fill-critical",
  warning: "fill-warning",
  accent: "fill-accent",
  info: "fill-info",
  ok: "fill-ok",
  drone: "fill-drone",
  muted: "fill-muted",
  text: "fill-text",
};

export const TONE_STROKE: Record<Tone, string> = {
  critical: "stroke-critical",
  warning: "stroke-warning",
  accent: "stroke-accent",
  info: "stroke-info",
  ok: "stroke-ok",
  drone: "stroke-drone",
  muted: "stroke-muted",
  text: "stroke-text",
};

/** Chip de etiqueta (HTML) por tono. */
export const TONE_CHIP: Record<Tone, string> = {
  critical: "border-critical bg-critical text-on-solid",
  warning: "border-warning/60 bg-surface/90 text-warning",
  accent: "border-accent/60 bg-surface/90 text-accent",
  info: "border-info/50 bg-surface/90 text-info",
  ok: "border-ok/50 bg-surface/90 text-ok",
  drone: "border-drone/50 bg-surface/90 text-drone",
  muted: "border-line bg-surface/85 text-muted",
  text: "border-line-strong bg-surface/90 text-text",
};

/** Insignia tenue por tono (barra superior, inspector). */
export const TONE_BADGE: Record<Tone, string> = {
  critical: "border-critical/50 bg-critical-soft text-critical",
  warning: "border-warning/50 bg-warning-soft text-warning",
  accent: "border-accent/50 bg-accent-soft text-accent",
  info: "border-info/40 bg-info-soft text-info",
  ok: "border-ok/40 bg-ok-soft text-ok",
  drone: "border-drone/40 bg-drone-soft text-drone",
  muted: "border-line bg-surface-2 text-muted",
  text: "border-line-strong bg-surface-2 text-text",
};

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}
