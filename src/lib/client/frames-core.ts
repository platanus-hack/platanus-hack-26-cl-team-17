/**
 * Lógica pura de la extracción de fotogramas (sin DOM): muestreo de instantes,
 * escalado, descarte de cuadros casi negros, escalera de calidad JPEG y errores.
 * La usa `frames.ts`; se prueba en node.
 */
import { LIMITS } from "@/lib/domain";

export type FrameExtractionErrorCode = "unsupported" | "aborted" | "timeout" | "empty" | "failed";

const DEFAULT_MESSAGES: Record<FrameExtractionErrorCode, string> = {
  unsupported:
    "Tu navegador no puede leer este archivo. Igual lo vamos a enviar para procesarlo en el servidor.",
  aborted: "Se canceló la preparación de las imágenes.",
  timeout: "El archivo tardó demasiado en abrirse. Inténtalo de nuevo.",
  empty: "No pudimos sacar imágenes de este video. Prueba con otro video.",
  failed: "No pudimos preparar las imágenes. Inténtalo de nuevo.",
};

export class FrameExtractionError extends Error {
  readonly code: FrameExtractionErrorCode;

  constructor(code: FrameExtractionErrorCode, message?: string, options?: { cause?: unknown }) {
    super(message ?? DEFAULT_MESSAGES[code], options);
    this.name = "FrameExtractionError";
    this.code = code;
  }
}

export function isFrameExtractionError(err: unknown): err is FrameExtractionError {
  return err instanceof FrameExtractionError;
}

/** Mensaje específico para fotos HEIC/HEIF que el navegador no decodifica. */
export const HEIC_UNSUPPORTED_MESSAGE =
  "Tu teléfono guardó la foto en formato HEIC y este navegador no puede abrirla. Prueba con otra foto o cambia la cámara a «Más compatible» (JPG).";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Redondea segundos a centésimas. */
export function roundTime(t: number): number {
  return Math.round(t * 100) / 100;
}

/** Duración utilizable (finita y > 0) o null (Infinity/NaN de algunos webm). */
export function usableDuration(d: number | null | undefined): number | null {
  return typeof d === "number" && Number.isFinite(d) && d > 0 ? d : null;
}

/** Margen que se evita al inicio y al final (suele haber cuadros movidos o negros). */
export const EDGE_MARGIN_FRACTION = 0.03;
export const MIN_FRAMES = 4;

/**
 * Instantes (s) repartidos de forma pareja dentro de [start, end], evitando el
 * primer y el último 3 % del tramo. n = clamp(round(largo/3), 4, max).
 */
export function sampleInstantsInRange(
  start: number,
  end: number,
  max: number = LIMITS.MAX_FRAMES_PER_MEDIA,
): number[] {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  const cap = Math.floor(max);
  if (!(cap >= 1)) return [];
  const span = end - start;
  const n = clamp(Math.round(span / 3), Math.min(MIN_FRAMES, cap), cap);
  const a = start + span * EDGE_MARGIN_FRACTION;
  const b = end - span * EDGE_MARGIN_FRACTION;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? (a + b) / 2 : a + ((b - a) * i) / (n - 1);
    // milisegundos: suficiente para un seek; evita duplicados en videos muy cortos
    const r = Math.round(t * 1000) / 1000;
    if (out.length === 0 || r > out[out.length - 1]) out.push(r);
  }
  return out;
}

/** Instantes de muestreo para un video de `duration_s` segundos. */
export function sampleInstants(duration_s: number, max: number = LIMITS.MAX_FRAMES_PER_MEDIA): number[] {
  const d = usableDuration(duration_s);
  return d === null ? [] : sampleInstantsInRange(0, d, max);
}

/**
 * Último recurso cuando no se conoce la duración ni hay rangos buscables:
 * segundos fijos (0,5; 2,5; 4,5; …) que se prueban hasta llegar al final.
 */
export function probeInstants(max: number = LIMITS.MAX_FRAMES_PER_MEDIA, step = 2, first = 0.5): number[] {
  const cap = Math.max(0, Math.floor(max));
  return Array.from({ length: cap }, (_, i) => roundTime(first + i * step));
}

/**
 * Tramo buscable a partir de los rangos de `video.seekable` como pares [inicio, fin].
 * Null si no hay rangos finitos con largo > 0.
 */
export function seekableSpan(ranges: ReadonlyArray<readonly [number, number]>): { start: number; end: number } | null {
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const [s, e] of ranges) {
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue;
    start = Math.min(start, s);
    end = Math.max(end, e);
  }
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? { start, end } : null;
}

/** Escala (w, h) para que el lado mayor sea ≤ longEdge, sin agrandar nunca. */
export function scaleToLongEdge(w: number, h: number, longEdge: number): { width: number; height: number } {
  if (!(w > 0) || !(h > 0) || !Number.isFinite(w) || !Number.isFinite(h)) return { width: 0, height: 0 };
  const edge = longEdge > 0 && Number.isFinite(longEdge) ? longEdge : Math.max(w, h);
  const s = Math.min(1, edge / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
}

/**
 * Calidades JPEG a probar en orden, desde `initial` bajando de a 0,12 hasta `min`.
 * Si con la última el archivo aún excede el tope, se reduce la resolución.
 */
export function jpegQualityLadder(initial: number = LIMITS.FRAME_JPEG_QUALITY, min = 0.4): number[] {
  const start = clamp(initial, 0.05, 1);
  const floor = clamp(min, 0.05, start);
  const out: number[] = [];
  for (let q = start; q > floor + 1e-9; q -= 0.12) out.push(Math.round(q * 100) / 100);
  out.push(Math.round(floor * 100) / 100);
  return out;
}

/* ---------- Cuadros casi negros ---------- */

export interface LumaStats {
  /** Luminancia media 0–255. */
  mean: number;
  /** Desviación estándar de la luminancia. */
  std: number;
  /** Alfa medio 0–255; 0 significa que no se dibujó nada (iOS a veces entrega lienzo vacío). */
  alpha: number;
}

/** Estadística de luminancia (Rec. 601) sobre píxeles RGBA (p. ej. un getImageData de 16×16). */
export function computeLumaStats(rgba: ArrayLike<number>): LumaStats {
  const px = Math.floor(rgba.length / 4);
  if (px === 0) return { mean: 0, std: 0, alpha: 0 };
  let sum = 0;
  let sumSq = 0;
  let alpha = 0;
  for (let i = 0; i < px; i++) {
    const o = i * 4;
    const y = 0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2];
    sum += y;
    sumSq += y * y;
    alpha += rgba[o + 3];
  }
  const mean = sum / px;
  const variance = Math.max(0, sumSq / px - mean * mean);
  return { mean, std: Math.sqrt(variance), alpha: alpha / px };
}

export const DARK_MEAN_MAX = 20;
export const DARK_STD_MAX = 10;
const SIMILAR_DELTA = 5;

/** Cuadro casi negro y uniforme (lente tapado, bolsillo, transición). */
export function isNearBlack(s: LumaStats | null | undefined): boolean {
  return !!s && s.mean < DARK_MEAN_MAX && s.std < DARK_STD_MAX;
}

function similar(a: LumaStats, b: LumaStats): boolean {
  return Math.abs(a.mean - b.mean) < SIMILAR_DELTA && Math.abs(a.std - b.std) < SIMILAR_DELTA;
}

/**
 * Índices (en orden) de los cuadros que se conservan.
 * 1) Si quedan ≥ minKeep cuadros no oscuros, se descartan todos los casi negros.
 * 2) Si no, se descartan solo los casi negros repetidos (iguales a uno oscuro anterior),
 *    mientras queden al menos minKeep cuadros.
 * 3) En otro caso no se descarta nada. `null` = sin estadística (se conserva).
 */
export function filterDarkFrames(stats: ReadonlyArray<LumaStats | null>, minKeep: number = MIN_FRAMES): number[] {
  const all = stats.map((_, i) => i);
  const keepMin = Math.max(1, Math.floor(minKeep));
  const bright = all.filter((i) => !isNearBlack(stats[i]));
  if (bright.length === stats.length) return all;
  if (bright.length >= keepMin) return bright;

  const repeats = new Set<number>();
  const seenDark: LumaStats[] = [];
  for (const i of all) {
    const s = stats[i];
    if (!s || !isNearBlack(s)) continue;
    if (seenDark.some((d) => similar(d, s))) repeats.add(i);
    else seenDark.push(s);
  }
  const droppable = Math.min(repeats.size, stats.length - keepMin);
  if (droppable <= 0) return all;
  // se descartan los repetidos más tardíos primero; el primero de cada grupo queda
  const drop = new Set([...repeats].sort((x, y) => y - x).slice(0, droppable));
  return all.filter((i) => !drop.has(i));
}

/** true si `filterDarkFrames` descartaría algún cuadro. */
export function shouldDropDarkFrames(stats: ReadonlyArray<LumaStats | null>, minKeep: number = MIN_FRAMES): boolean {
  return filterDarkFrames(stats, minKeep).length < stats.length;
}

/* ---------- Errores de <video> ---------- */

/** Traduce `MediaError.code` (1 abortado, 2 red, 3 decodificación, 4 formato) a nuestro código. */
export function mediaErrorToCode(code: number | null | undefined): FrameExtractionErrorCode {
  if (code === 3 || code === 4) return "unsupported";
  return "failed";
}

/** Progreso global: 5 % para abrir el video, el resto repartido entre los cuadros. */
export function progressFraction(done: number, total: number): number {
  if (!(total > 0)) return 0.05;
  return clamp(0.05 + 0.95 * (done / total), 0, 1);
}
