/**
 * Lógica pura del cargador de medios (sin React ni DOM): nota con chips, clasificación de
 * archivos, reglas de ubicación y textos de cada etapa. Se prueba con node:test.
 */
import { LIMITS } from "@/lib/domain";
import { formatBytes, formatDistance } from "@/lib/format";
import type { UploadStage, VideoOutcome } from "@/lib/client/upload";

/* ───────────── Nota: chips de un toque + texto libre ───────────── */

export interface NoteChip {
  id: string;
  label: string;
}

export const NOTE_CHIPS: readonly NoteChip[] = [
  { id: "people_inside", label: "Hay personas adentro" },
  { id: "injured", label: "Hay heridos" },
  { id: "gas_cylinders", label: "Hay cilindros de gas" },
  { id: "downed_wires", label: "Cables caídos" },
  { id: "vehicle_occupied", label: "Vehículo con gente adentro" },
];

const NOTE_SEPARATOR = ". ";

/** Frases de los chips elegidos, en el orden fijo de `NOTE_CHIPS`. */
export function chipText(selected: ReadonlySet<string> | readonly string[]): string {
  const set = selected instanceof Set ? selected : new Set(selected);
  return NOTE_CHIPS.filter((c) => set.has(c.id))
    .map((c) => c.label)
    .join(NOTE_SEPARATOR);
}

/** Caracteres disponibles para el texto libre dado lo que ya ocupan los chips. */
export function freeTextBudget(
  selected: ReadonlySet<string> | readonly string[],
  max: number = LIMITS.MAX_NOTE_CHARS,
): number {
  const chips = chipText(selected);
  if (!chips) return max;
  return Math.max(0, max - chips.length - NOTE_SEPARATOR.length);
}

/** Nota final: frases de los chips y luego el texto libre, sin pasar de `max`. */
export function composeNote(
  selected: ReadonlySet<string> | readonly string[],
  freeText: string,
  max: number = LIMITS.MAX_NOTE_CHARS,
): string {
  const chips = chipText(selected);
  let free = freeText.trim();
  if (!chips) return truncate(free, max);
  const budget = freeTextBudget(selected, max);
  free = truncate(free, budget);
  if (!free) return truncate(chips, max);
  return truncate(`${chips}${NOTE_SEPARATOR}${free}`, max);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  let out = s.slice(0, Math.max(0, max));
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out.trimEnd();
}

/** Alterna un chip; devuelve un Set nuevo (inmutable para React). */
export function toggleChip(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/* ───────────── Clasificación de archivos ───────────── */

export type MediaKind = "video" | "photo";

const VIDEO_EXT = new Set(["mp4", "m4v", "mov", "qt", "webm", "3gp", "3g2", "mkv", "avi"]);
const PHOTO_EXT = new Set(["jpg", "jpeg", "png", "webp", "gif", "heic", "heif", "avif"]);

export interface FileLike {
  name: string;
  type: string;
  size: number;
  lastModified?: number;
}

/** "video", "photo" o null si no es un formato que podamos enviar. */
export function classifyFile(file: Pick<FileLike, "name" | "type">): MediaKind | null {
  const type = (file.type ?? "").split(";")[0].trim().toLowerCase();
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("image/")) return "photo";
  const ext = (file.name ?? "").split(".").pop()?.toLowerCase() ?? "";
  if (VIDEO_EXT.has(ext)) return "video";
  if (PHOTO_EXT.has(ext)) return "photo";
  return null;
}

export type GallerySelection<F extends FileLike> =
  | { ok: true; kind: "video"; files: [F]; notice: string | null }
  | { ok: true; kind: "photo"; files: F[]; notice: string | null }
  | { ok: false; error: string };

/**
 * Elección desde la galería (vecino): si hay un video se usa solo ese; si son fotos, hasta
 * `LIMITS.MAX_FRAMES_PER_MEDIA`. Los archivos de otro tipo se ignoran con aviso.
 */
export function pickGallerySelection<F extends FileLike>(
  files: readonly F[],
  maxPhotos: number = LIMITS.MAX_FRAMES_PER_MEDIA,
): GallerySelection<F> {
  if (files.length === 0) return { ok: false, error: "No elegiste ningún archivo." };
  const videos = files.filter((f) => classifyFile(f) === "video");
  const photos = files.filter((f) => classifyFile(f) === "photo");
  const ignored = files.length - videos.length - photos.length;

  if (videos.length > 0) {
    const extra = files.length - 1;
    const notice =
      extra > 0 ? "Elegiste varios archivos: enviaremos solo el primer video. Puedes enviar los otros después." : null;
    return { ok: true, kind: "video", files: [videos[0]], notice };
  }
  if (photos.length > 0) {
    const kept = photos.slice(0, maxPhotos);
    const parts: string[] = [];
    if (photos.length > maxPhotos) {
      parts.push(`Puedes enviar hasta ${maxPhotos} fotos a la vez: enviaremos las primeras ${maxPhotos}.`);
    }
    if (ignored > 0) parts.push(ignoredNotice(ignored));
    return { ok: true, kind: "photo", files: kept, notice: parts.length > 0 ? parts.join(" ") : null };
  }
  return { ok: false, error: "Ese archivo no es un video ni una foto. Elige un video o fotos de tu galería." };
}

function ignoredNotice(n: number): string {
  return n === 1 ? "Un archivo no era video ni foto y lo dejamos fuera." : `${n} archivos no eran video ni foto y los dejamos fuera.`;
}

/** Aviso previo si el video pesa más de lo que se puede subir completo. */
export function videoSizeNotice(sizeBytes: number, max: number = LIMITS.MAX_VIDEO_BYTES): string | null {
  if (!(sizeBytes > max)) return null;
  return `El video pesa ${formatBytes(sizeBytes)} (máximo ${formatBytes(max)}): enviaremos imágenes sacadas del video, pero no el video completo.`;
}

/** Ventana en la que un archivo de la galería cuenta como recién grabado. */
export const RECENT_CAPTURE_MS = 10 * 60 * 1000;

/**
 * El rumbo de la brújula al enviar solo describe la toma si se grabó recién en este lugar:
 * con la cámara de la página, o un archivo de galería modificado hace pocos minutos.
 */
export function headingApplies(
  source: "capture" | "gallery",
  lastModified: number | undefined,
  now: number,
  windowMs: number = RECENT_CAPTURE_MS,
): boolean {
  if (source === "capture") return true;
  if (typeof lastModified !== "number" || !Number.isFinite(lastModified)) return false;
  const age = now - lastModified;
  return age >= 0 && age <= windowMs;
}

/* ───────────── Ubicación ───────────── */

/** "Precisión: ±25 m" (redondeada a 5 m bajo 100 m para no aparentar más exactitud). */
export function accuracyText(accuracyM: number | null | undefined): string | null {
  if (accuracyM == null || !Number.isFinite(accuracyM) || accuracyM < 0) return null;
  const rounded = accuracyM < 100 ? Math.max(5, Math.round(accuracyM / 5) * 5) : Math.round(accuracyM / 10) * 10;
  return `Precisión: ±${formatDistance(rounded)}`;
}

/** Sobre esta precisión se sugiere salir a un lugar abierto y actualizar. */
export const POOR_ACCURACY_M = 150;

export function isPoorAccuracy(accuracyM: number | null | undefined): boolean {
  return typeof accuracyM === "number" && Number.isFinite(accuracyM) && accuracyM > POOR_ACCURACY_M;
}

/** ¿Se puede enviar sin ubicación? Solo si el reporte va a una emergencia ya identificada por código. */
export function canSendWithoutLocation(incidentCode: string | null | undefined): boolean {
  return typeof incidentCode === "string" && incidentCode.trim().length > 0;
}

/* ───────────── Etapas del envío (vecino) ───────────── */

export interface StageView {
  /** Texto principal grande. */
  title: string;
  /** Detalle bajo el título. */
  detail: string | null;
  /** true cuando Bomberos ya tiene las imágenes. */
  delivered: boolean;
  /** Valor de la barra 0..1. */
  value: number;
  /** Rótulo accesible de la barra. */
  barLabel: string;
}

export interface StageInput {
  stage: UploadStage;
  kind: MediaKind;
  fraction: number;
  stageFraction?: number;
  /** Bomberos confirmó la recepción de los fotogramas (onFramesUploaded). */
  framesDelivered: boolean;
}

export function vecinoStageView(p: StageInput): StageView {
  const photo = p.kind === "photo";
  const overall = clamp01(p.fraction);
  switch (p.stage) {
    case "extracting":
      return {
        title: photo ? "Preparando fotos…" : "Preparando imágenes…",
        detail: photo ? null : "Sacamos algunas imágenes del video para que Bomberos las vea primero.",
        delivered: false,
        value: overall,
        barLabel: "Avance del envío",
      };
    case "registering":
    case "uploading_frames":
    case "analyzing_started":
      if (p.stage === "analyzing_started" && p.framesDelivered) return deliveredView(p, photo);
      return {
        title: photo ? "Enviando fotos…" : "Enviando imágenes…",
        detail: "No cierres esta página.",
        delivered: false,
        value: overall,
        barLabel: "Avance del envío",
      };
    case "uploading_video":
      if (p.framesDelivered) return deliveredView(p, photo);
      // Sin fotogramas (el navegador no pudo leer el video): se sube el video entero.
      return {
        title: "Enviando el video…",
        detail: "Este navegador no puede leer el formato de tu video, así que lo enviamos completo. No cierres esta página.",
        delivered: false,
        value: clamp01(p.stageFraction ?? 0),
        barLabel: "Subida del video",
      };
    case "done":
      return {
        title: "Listo, tu reporte llegó a Bomberos.",
        detail: null,
        delivered: true,
        value: 1,
        barLabel: "Avance del envío",
      };
  }
}

function deliveredView(p: StageInput, photo: boolean): StageView {
  return {
    title: photo ? "Bomberos ya recibió tus fotos ✔" : "Bomberos ya recibió tus imágenes ✔",
    detail: photo ? null : "Subiendo el video completo, no cierres esta página.",
    delivered: true,
    value: p.stage === "uploading_video" ? clamp01(p.stageFraction ?? 0) : 0,
    barLabel: "Subida del video completo",
  };
}

function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0;
}

/** Frase sobre el video original en la confirmación final (null si no aplica). */
export function videoOutcomeText(input: {
  kind: MediaKind;
  video: VideoOutcome;
  framesUnsupported: boolean;
  videoError?: string;
}): { text: string; tone: "ok" | "warning" } | null {
  if (input.kind === "photo") return null;
  if (input.framesUnsupported && input.video === "uploaded") {
    return {
      text: "Tu navegador no pudo mostrarnos el video, así que lo enviamos completo. Bomberos lo revisará igual.",
      tone: "ok",
    };
  }
  switch (input.video) {
    case "uploaded":
      return { text: "El video completo también llegó.", tone: "ok" };
    case "skipped_too_large":
      return {
        text: input.videoError ?? "El video era muy pesado: Bomberos recibió las imágenes, pero no el video completo.",
        tone: "warning",
      };
    case "failed":
      return {
        text: "El video completo no se pudo subir, pero Bomberos ya tiene las imágenes.",
        tone: "warning",
      };
    case "none":
      return null;
  }
}

/* ───────────── Fila de archivo (mando) ───────────── */

export type MandoItemStatus = "staged" | "queued" | "running" | "done" | "error";

/** Estado corto de una fila del cargador del puesto de mando. */
export function mandoStatusLabel(status: MandoItemStatus): string {
  switch (status) {
    case "staged":
      return "Listo para enviar";
    case "queued":
      return "En cola";
    case "running":
      return "Enviando";
    case "done":
      return "Recibido";
    case "error":
      return "Error";
  }
}

/** Resumen del resultado de un archivo en el mando: código del incidente y qué pasó con el video. */
export function mandoResultText(r: {
  kind: MediaKind;
  incidentCode: string;
  framesSent: number;
  video: VideoOutcome;
  framesUnsupported: boolean;
}): string {
  const head = `${r.incidentCode} · análisis en curso`;
  if (r.kind === "photo") return `${head} · ${r.framesSent === 1 ? "1 foto" : `${r.framesSent} fotos`}`;
  if (r.framesUnsupported) {
    return r.video === "uploaded"
      ? `${head} · sin fotogramas en el navegador; el servidor los extraerá del video`
      : `${head} · el video no subió`;
  }
  const frames = `${r.framesSent} fotogramas`;
  switch (r.video) {
    case "uploaded":
      return `${head} · ${frames} · video original subido`;
    case "skipped_too_large":
      return `${head} · ${frames} · video original omitido por tamaño`;
    case "failed":
      return `${head} · ${frames} · el video original no subió`;
    case "none":
      return `${head} · ${frames}`;
  }
}
