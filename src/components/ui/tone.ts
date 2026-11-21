/** Tono semántico compartido por badges, puntos de estado, paneles y avisos. */
export type Tone = "neutral" | "accent" | "critical" | "warning" | "ok" | "info" | "drone";

/** Color de texto por tono (neutral → texto atenuado). */
export const toneText: Record<Tone, string> = {
  neutral: "text-muted",
  accent: "text-accent",
  critical: "text-critical",
  warning: "text-warning",
  ok: "text-ok",
  info: "text-info",
  drone: "text-drone",
};

/** Fondo suave (translúcido) por tono (neutral → superficie elevada). */
export const toneSoftBg: Record<Tone, string> = {
  neutral: "bg-surface-2",
  accent: "bg-accent-soft",
  critical: "bg-critical-soft",
  warning: "bg-warning-soft",
  ok: "bg-ok-soft",
  info: "bg-info-soft",
  drone: "bg-drone-soft",
};

/** Fondo sólido por tono; el texto encima debe ser `text-on-solid`. */
export const toneSolidBg: Record<Tone, string> = {
  neutral: "bg-muted",
  accent: "bg-accent",
  critical: "bg-critical",
  warning: "bg-warning",
  ok: "bg-ok",
  info: "bg-info",
  drone: "bg-drone",
};

/** Borde por tono, al 40 % de opacidad (neutral → línea estándar). */
export const toneBorder: Record<Tone, string> = {
  neutral: "border-line",
  accent: "border-accent/40",
  critical: "border-critical/40",
  warning: "border-warning/40",
  ok: "border-ok/40",
  info: "border-info/40",
  drone: "border-drone/40",
};

/** Relleno de puntos de estado por tono (igual al sólido). */
export const toneDotBg: Record<Tone, string> = toneSolidBg;
