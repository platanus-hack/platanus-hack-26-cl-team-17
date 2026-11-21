/**
 * Lectura de transcripciones radiales pegadas como texto (módulo puro, sin React).
 *
 * Formatos aceptados por línea:
 *   "21:14 B-3: en el lugar, humo negro"     hora + emisor + texto
 *   "[21:14:05] Central: B-3, copiado"        hora con segundos, entre corchetes
 *   "21:14 - OBAC: ..."                       separador opcional tras la hora
 *   "RX-15: llegando"                         emisor sin hora
 *   "se ve fuego en el segundo piso"          línea suelta (sin hora ni emisor)
 * Las líneas vacías se ignoran; CRLF y CR se aceptan.
 */

/** Tope del texto de una entrada (igual que AddCommInputSchema). */
export const MAX_IMPORT_TEXT_CHARS = 2000;
/** Tope del emisor (igual que AddCommInputSchema). */
export const MAX_IMPORT_SPEAKER_CHARS = 60;

/** Hora del día leída de la línea. */
export interface ClockTime {
  h: number;
  m: number;
  s: number;
}

/** Una entrada lista para importar. */
export interface ParsedTranscriptEntry {
  /** Número de línea en el texto pegado, desde 1. */
  line: number;
  /** Línea original sin espacios sobrantes en los extremos. */
  raw: string;
  /** Hora leída; null si la línea no traía hora. */
  time: ClockTime | null;
  /**
   * Días después del primer día de la transcripción (cruce de medianoche: 23:58 → 00:03 queda en +1).
   * 0 si no hay hora.
   */
  dayOffset: number;
  /** Emisor leído; "" si la línea no lo traía. */
  speaker: string;
  text: string;
}

/** Línea que no se puede importar, con el porqué en español. */
export interface TranscriptIssue {
  line: number;
  raw: string;
  reason: string;
}

export interface ParsedTranscript {
  entries: ParsedTranscriptEntry[];
  issues: TranscriptIssue[];
}

// Hora al inicio: "21:14", "9:05", "21:14:05", "[21:14]", "(21:14:05)", con separador opcional "-", "–", "—", "|".
const TIME_PREFIX = /^[[(]?([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?[\])]?(?:\s*[-–—|]\s*|\s+|$)/;
// Emisor: hasta 4 palabras de letras, dígitos y - . / #; termina en ":" seguido de espacio o fin.
const SPEAKER_PREFIX = /^([\p{L}\d][\p{L}\d\-./#]*(?: [\p{L}\d][\p{L}\d\-./#]*){0,3})\s*:(?:\s+|$)/u;
const HAS_LETTER = /\p{L}/u;
const STARTS_UPPER_OR_DIGIT = /^[\p{Lu}\d]/u;
const CONNECTORS = new Set(["a", "al", "de", "del", "y", "e"]);

/**
 * Un emisor de varias palabras debe parecer nombre de unidad o cargo ("B-3 a Central", "Segundo Comandante"):
 * cada palabra con mayúscula o dígito inicial, salvo conectores. Así "Se ve humo: mucho" queda como texto.
 */
function isPlausibleSpeaker(candidate: string): boolean {
  if (!HAS_LETTER.test(candidate) || candidate.length > MAX_IMPORT_SPEAKER_CHARS) return false;
  const words = candidate.split(" ");
  if (words.length === 1) return true;
  return words.every((w) => STARTS_UPPER_OR_DIGIT.test(w) || CONNECTORS.has(w));
}

/** Una vuelta de reloj hacia atrás mayor a esto se toma como cruce de medianoche, no como desorden. */
const MIDNIGHT_BACKWARD_JUMP_S = 6 * 3600;

/** Lee una sola línea (ya sin salto de línea). null si está vacía. */
export function parseTranscriptLine(input: string): { time: ClockTime | null; speaker: string; text: string } | null {
  let rest = input.replace(/\s+/g, " ").trim();
  if (!rest) return null;

  let time: ClockTime | null = null;
  const t = TIME_PREFIX.exec(rest);
  if (t) {
    time = { h: Number(t[1]), m: Number(t[2]), s: t[3] ? Number(t[3]) : 0 };
    rest = rest.slice(t[0].length).trim();
  }

  let speaker = "";
  const sp = SPEAKER_PREFIX.exec(rest);
  if (sp && isPlausibleSpeaker(sp[1])) {
    speaker = sp[1];
    rest = rest.slice(sp[0].length).trim();
  }

  return { time, speaker, text: rest };
}

function secondsOfDay(t: ClockTime): number {
  return t.h * 3600 + t.m * 60 + t.s;
}

/** Lee la transcripción completa: entradas importables y líneas descartadas con su motivo. */
export function parseTranscript(input: string): ParsedTranscript {
  const entries: ParsedTranscriptEntry[] = [];
  const issues: TranscriptIssue[] = [];
  const lines = input.split(/\r\n|\r|\n/);
  let dayOffset = 0;
  let prevSeconds: number | null = null;

  lines.forEach((rawLine, idx) => {
    const raw = rawLine.trim();
    const parsed = parseTranscriptLine(raw);
    if (!parsed) return;
    const line = idx + 1;
    if (!parsed.text) {
      issues.push({ line, raw, reason: "No tiene texto después de la hora o el emisor." });
      return;
    }
    if (parsed.text.length > MAX_IMPORT_TEXT_CHARS) {
      issues.push({ line, raw: raw.slice(0, 120), reason: `Tiene más de ${MAX_IMPORT_TEXT_CHARS} caracteres; divídela.` });
      return;
    }
    let offset = 0;
    if (parsed.time) {
      const sec = secondsOfDay(parsed.time);
      if (prevSeconds !== null && prevSeconds - sec > MIDNIGHT_BACKWARD_JUMP_S) dayOffset += 1;
      prevSeconds = sec;
      offset = dayOffset;
    }
    entries.push({ line, raw, time: parsed.time, dayOffset: offset, speaker: parsed.speaker, text: parsed.text });
  });

  return { entries, issues };
}

/** Margen de reloj tolerado antes de suponer que la transcripción es de ayer. */
const FUTURE_TOLERANCE_MS = 10 * 60 * 1000;

/**
 * Fecha ISO de cada entrada: hoy (hora local de `now`) a la hora leída, más su `dayOffset`.
 * Si con eso la última hora quedaría en el futuro (p. ej. a las 00:10 se pega algo de las 23:50),
 * toda la transcripción se corre un día atrás. Las entradas sin hora devuelven null
 * (el servidor usa la hora de ingreso).
 */
export function resolveEntryDates(entries: readonly ParsedTranscriptEntry[], now: Date | number): (string | null)[] {
  const ref = new Date(now);
  const base = (e: ParsedTranscriptEntry, shiftDays: number): Date | null => {
    if (!e.time) return null;
    return new Date(
      ref.getFullYear(),
      ref.getMonth(),
      ref.getDate() + e.dayOffset - shiftDays,
      e.time.h,
      e.time.m,
      e.time.s,
      0,
    );
  };
  let latest = -Infinity;
  for (const e of entries) {
    const d = base(e, 0);
    if (d && d.getTime() > latest) latest = d.getTime();
  }
  const shift = latest > ref.getTime() + FUTURE_TOLERANCE_MS ? 1 : 0;
  return entries.map((e) => base(e, shift)?.toISOString() ?? null);
}

/** "21:14" o "21:14:05" (solo si trae segundos distintos de cero). */
export function formatClockTime(t: ClockTime): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return t.s ? `${p(t.h)}:${p(t.m)}:${p(t.s)}` : `${p(t.h)}:${p(t.m)}`;
}
