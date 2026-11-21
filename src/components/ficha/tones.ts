/**
 * Colores de la ficha. El color es escaso y siempre significa algo:
 * rojo = personas o peligro para la vida · naranjo = fuego y humo · ámbar = riesgos ·
 * azul = unidades de bomberos y cámaras de vecinos · verde = despejado o controlado.
 * El resto, grises cálidos. Rojo y ámbar son los de la marca (Rojo Bombero, Ámbar Faro).
 * Las clases f-* están definidas en globals.css (@theme).
 */
import type { Tone } from "./model";

export const TONE_HEX: Record<Tone, string> = {
  red: "#E8362F",
  orange: "#F76B15",
  amber: "#FFB020",
  blue: "#0090FF",
  green: "#30A46C",
  gray: "#8D8D86",
};

/** Punto sólido (marcadores, viñetas). */
export const TONE_DOT: Record<Tone, string> = {
  red: "bg-f-red",
  orange: "bg-f-orange",
  amber: "bg-f-amber",
  blue: "bg-f-blue",
  green: "bg-f-green",
  gray: "bg-f-faint",
};

/** Texto con color (el ámbar se oscurece para que se lea sobre blanco). */
export const TONE_TEXT: Record<Tone, string> = {
  red: "text-f-red",
  orange: "text-f-orange-ink",
  amber: "text-f-amber-ink",
  blue: "text-f-blue",
  green: "text-f-green",
  gray: "text-f-muted",
};

/** Fondo suave para íconos de tarjeta. */
export const TONE_WASH: Record<Tone, string> = {
  red: "bg-f-red/12",
  orange: "bg-f-orange/12",
  amber: "bg-f-amber/18",
  blue: "bg-f-blue/12",
  green: "bg-f-green/12",
  gray: "bg-f-ink/6",
};
