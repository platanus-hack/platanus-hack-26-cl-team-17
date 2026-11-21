/**
 * Extracción de fotogramas en el servidor con ffmpeg (solo servidor).
 *
 * Se usa cuando un medio llegó con video pero sin fotogramas (el navegador del
 * vecino no pudo extraerlos). Elige los mismos instantes que el navegador
 * (`src/lib/client/frames-core.ts`), extrae JPEG con lado mayor
 * `LIMITS.FRAME_LONG_EDGE_PX`, los sube con `storagePaths.frame` y los registra
 * con `addFrames`. ffmpeg se invoca con execFile (sin shell) y los temporales
 * se borran siempre.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { config } from "@/lib/config";
import { LIMITS, type Media, type MediaFrame } from "@/lib/domain";
import { storagePaths, type FileStorage, type NewFrame, type Store } from "@/lib/store/types";

export class ServerFramesError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ServerFramesError";
  }
}

export const FFMPEG_UNAVAILABLE_MESSAGE =
  "El servidor no puede extraer fotogramas; extráelos desde el navegador del mando.";

export interface ServerFramesDeps {
  store?: Store;
  files?: FileStorage;
  ffmpegPath?: string;
  /** Carpeta donde crear el directorio temporal (por defecto os.tmpdir()). */
  tmpRoot?: string;
  /** Tope por invocación de ffmpeg/ffprobe, en ms (por defecto 60 s). */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TOOL_OUTPUT_BYTES = 4 * 1024 * 1024;
/** Margen inicial y final que se evita (igual que el navegador). */
const EDGE_MARGIN_FRACTION = 0.03;
const MIN_FRAMES = 4;
const JPEG_QUALITY = 3;
/** Retrocesos (s) para reintentar un instante que no entregó cuadro. */
const EARLIER_RETRY_S = [0.25, 1] as const;
/** Si un cuadro excede LIMITS.MAX_FRAME_BYTES se reintenta con esta calidad (escala 2–31, mayor = más compresión). */
const JPEG_QUALITY_RETRY = 10;

/* ───────────────────────────── Instantes ───────────────────────────── */

/**
 * Instantes (s) a extraer de un video de `durationS` segundos. Igual que el
 * navegador: n = clamp(round(dur/3), 4, LIMITS.MAX_FRAMES_PER_MEDIA), repartidos
 * de forma pareja evitando el primer y el último 3 %, redondeados al milisegundo
 * y sin duplicados. Duración ≤ 0 o no finita → [0].
 */
export function chooseFrameTimes(durationS: number): number[] {
  if (typeof durationS !== "number" || !Number.isFinite(durationS) || durationS <= 0) return [0];
  const cap = LIMITS.MAX_FRAMES_PER_MEDIA;
  const n = Math.min(cap, Math.max(Math.min(MIN_FRAMES, cap), Math.round(durationS / 3)));
  const a = durationS * EDGE_MARGIN_FRACTION;
  const b = durationS - durationS * EDGE_MARGIN_FRACTION;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? (a + b) / 2 : a + ((b - a) * i) / (n - 1);
    const r = Math.round(t * 1000) / 1000;
    if (out.length === 0 || r > out[out.length - 1]) out.push(r);
  }
  return out;
}

/** Sin duración conocida: segundos fijos (0,5; 2,5; 4,5; …) que se prueban hasta el final (como el navegador). */
function probeTimes(): number[] {
  return Array.from({ length: LIMITS.MAX_FRAMES_PER_MEDIA }, (_, i) => 0.5 + i * 2);
}

/* ───────────────────────────── JPEG ───────────────────────────── */

export function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/** Ancho y alto reales leídos del marcador SOF del JPEG, o null si no se encuentra. */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (!isJpeg(bytes)) return null;
  let i = 2;
  while (i + 3 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = bytes[i + 1];
    // Relleno 0xFF, marcadores sin longitud (TEM, RSTn)
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // fin o inicio de datos sin SOF
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (len < 2) return null;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (i + 8 >= bytes.length) return null;
      const height = (bytes[i + 5] << 8) | bytes[i + 6];
      const width = (bytes[i + 7] << 8) | bytes[i + 8];
      return width > 0 && height > 0 ? { width, height } : null;
    }
    i += 2 + len;
  }
  return null;
}

/* ───────────────────────────── Procesos ───────────────────────────── */

interface ToolResult {
  stdout: string;
  stderr: string;
}

type ToolError = Error & { code?: unknown; stdout?: unknown; stderr?: unknown };

function runTool(file: string, args: string[], timeoutMs: number): Promise<ToolResult> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        encoding: "utf8",
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: MAX_TOOL_OUTPUT_BYTES,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          const e = error as ToolError;
          e.stdout = stdout;
          e.stderr = stderr;
          reject(e);
        } else {
          resolve({ stdout, stderr });
        }
      },
    );
  });
}

/** El ejecutable no existe o no se puede ejecutar. */
function isSpawnFailure(err: unknown): boolean {
  const code = (err as ToolError | null)?.code;
  return code === "ENOENT" || code === "EACCES" || code === "ENOTDIR";
}

function stderrOf(err: unknown): string {
  const s = (err as ToolError | null)?.stderr;
  return typeof s === "string" ? s : "";
}

/** Ruta de ffprobe junto a ffmpeg ("/usr/bin/ffmpeg" → "/usr/bin/ffprobe"; "ffmpeg" → "ffprobe"). */
export function ffprobePathFor(ffmpegPath: string): string {
  const base = path.basename(ffmpegPath);
  const prefix = ffmpegPath.slice(0, ffmpegPath.length - base.length);
  const idx = base.toLowerCase().lastIndexOf("ffmpeg");
  const probe = idx >= 0 ? `${base.slice(0, idx)}ffprobe${base.slice(idx + 6)}` : "ffprobe";
  return prefix + probe;
}

/** "HH:MM:SS.xx" → segundos, o null. */
export function parseClock(s: string): number | null {
  const m = /(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(s);
  if (!m) return null;
  const t = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  return Number.isFinite(t) ? t : null;
}

const positive = (v: number | null | undefined): number | null =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;

/**
 * Duración del video: ffprobe; si no hay ffprobe, la cabecera que imprime
 * `ffmpeg -i`; si el contenedor no la declara (webm de MediaRecorder), recorre
 * el flujo copiándolo sin decodificar. null si no se pudo saber.
 */
async function probeDuration(ffmpeg: string, input: string, timeoutMs: number): Promise<number | null> {
  try {
    const { stdout } = await runTool(
      ffprobePathFor(ffmpeg),
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", input],
      timeoutMs,
    );
    const d = positive(Number.parseFloat(stdout.trim()));
    if (d !== null) return d;
  } catch {
    // Sin ffprobe o no pudo leer: se intenta con ffmpeg.
  }

  let header = "";
  try {
    const r = await runTool(ffmpeg, ["-hide_banner", "-nostdin", "-i", input], timeoutMs);
    header = r.stderr;
  } catch (err) {
    if (isSpawnFailure(err)) throw new ServerFramesError(FFMPEG_UNAVAILABLE_MESSAGE, { cause: err });
    // `ffmpeg -i` sin salida termina con error, pero igual imprime la cabecera.
    header = stderrOf(err);
  }
  const dm = /Duration:\s*([0-9:.]+)/.exec(header);
  const fromHeader = dm ? positive(parseClock(dm[1])) : null;
  if (fromHeader !== null) return fromHeader;

  try {
    const { stdout } = await runTool(
      ffmpeg,
      [
        "-hide_banner", "-nostdin", "-nostats", "-loglevel", "error",
        "-i", input, "-map", "0:v:0", "-c", "copy", "-f", "null", "-progress", "pipe:1", "-",
      ],
      timeoutMs,
    );
    let best: number | null = null;
    for (const m of stdout.matchAll(/^out_time=(\S+)$/gm)) {
      const t = positive(parseClock(m[1]));
      if (t !== null && (best === null || t > best)) best = t;
    }
    return best;
  } catch (err) {
    if (isSpawnFailure(err)) throw new ServerFramesError(FFMPEG_UNAVAILABLE_MESSAGE, { cause: err });
    return null;
  }
}

/** Escala para que el lado mayor quede ≤ FRAME_LONG_EDGE_PX, sin agrandar y conservando la proporción. */
const SCALE_FILTER = (() => {
  const e = LIMITS.FRAME_LONG_EDGE_PX;
  return `scale=w='if(gt(iw,ih),min(${e},iw),-2)':h='if(gt(iw,ih),-2,min(${e},ih))'`;
})();

interface ExtractedFrame {
  t_s: number;
  bytes: Uint8Array;
  width: number;
  height: number;
}

/** Un cuadro en el instante `t`; null si ffmpeg no entregó imagen (p. ej. pasado el final). */
async function extractOne(
  ffmpeg: string,
  input: string,
  outFile: string,
  t: number,
  timeoutMs: number,
): Promise<ExtractedFrame | null> {
  for (const q of [JPEG_QUALITY, JPEG_QUALITY_RETRY]) {
    await rm(outFile, { force: true });
    try {
      await runTool(
        ffmpeg,
        [
          "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
          "-ss", t.toFixed(3), "-i", input,
          "-map", "0:v:0", "-frames:v", "1", "-an", "-sn",
          "-vf", SCALE_FILTER, "-q:v", String(q), outFile,
        ],
        timeoutMs,
      );
    } catch (err) {
      if (isSpawnFailure(err)) throw new ServerFramesError(FFMPEG_UNAVAILABLE_MESSAGE, { cause: err });
      return null;
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(outFile));
    } catch {
      return null; // ffmpeg terminó sin escribir (instante fuera del video)
    }
    const size = jpegSize(bytes);
    if (!size) return null;
    if (bytes.length <= LIMITS.MAX_FRAME_BYTES) return { t_s: t, bytes, ...size };
  }
  return null;
}

function inputExtension(videoPath: string): string {
  const ext = path.extname(videoPath).slice(1).toLowerCase();
  return /^[a-z0-9]{1,5}$/.test(ext) ? ext : "bin";
}

/* ───────────────────────────── API ───────────────────────────── */

/**
 * Extrae fotogramas del video del medio, los sube y los registra.
 * Lanza ServerFramesError (mensaje en español para el operador) si no hay
 * video, si ffmpeg no está disponible o si no salió ningún cuadro.
 */
interface VideoWork {
  ffmpeg: string;
  input: string;
  outFile: string;
  timeoutMs: number;
}

/**
 * Descarga el video del medio a un directorio temporal, ejecuta `fn` y borra
 * siempre los temporales. Resuelve store/files por defecto.
 */
async function withVideoFile<T>(
  media: Media,
  deps: ServerFramesDeps,
  fn: (work: VideoWork, io: { store: Store; files: FileStorage }) => Promise<T>,
): Promise<T> {
  const videoPath = media.video_path;
  if (!videoPath) {
    throw new ServerFramesError(
      `El medio ${media.label} no tiene video guardado en el servidor; no hay de dónde extraer fotogramas.`,
    );
  }
  const ffmpeg = (deps.ffmpegPath ?? config.ffmpegPath).trim();
  if (!ffmpeg) throw new ServerFramesError(FFMPEG_UNAVAILABLE_MESSAGE);
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let store = deps.store;
  let files = deps.files;
  if (!store || !files) {
    // Import diferido: las pruebas inyectan dependencias sin cargar Postgres/GCS.
    const mod = await import("@/lib/store");
    store ??= mod.getStore();
    files ??= mod.getFiles();
  }

  let video: Uint8Array;
  try {
    video = (await files.download(videoPath)).bytes;
  } catch (err) {
    throw new ServerFramesError(`No se pudo descargar el video de ${media.label} para extraer fotogramas.`, {
      cause: err,
    });
  }
  if (video.length === 0) {
    throw new ServerFramesError(`El video de ${media.label} está vacío; no se pueden extraer fotogramas.`);
  }

  const dir = await mkdtemp(path.join(deps.tmpRoot ?? os.tmpdir(), "vigia-frames-"));
  try {
    const input = path.join(dir, `input.${inputExtension(videoPath)}`);
    await writeFile(input, video);
    return await fn({ ffmpeg, input, outFile: path.join(dir, "frame.jpg"), timeoutMs }, { store, files });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function extractFramesOnServer(media: Media, deps: ServerFramesDeps = {}): Promise<MediaFrame[]> {
  return withVideoFile(media, deps, async ({ ffmpeg, input, outFile, timeoutMs }, { store, files }) => {
    let extracted: ExtractedFrame[] = [];

    let times: number[] = [0];
    let knownDuration = false;
    if (media.kind !== "photo") {
      const duration = positive(media.duration_s) ?? (await probeDuration(ffmpeg, input, timeoutMs));
      knownDuration = duration !== null;
      times = duration !== null ? chooseFrameTimes(duration) : probeTimes();
    }
    // Último intento si no salió nada (clip muy corto o duración informada errónea).
    const fallback = times.includes(0) ? [] : [0];

    for (const t of times) {
      let frame = await extractOne(ffmpeg, input, outFile, t, timeoutMs);
      // Cerca del final, el último cuadro puede empezar antes del instante pedido
      // (ffmpeg descarta cuadros anteriores al -ss): se reintenta un poco antes,
      // sin retroceder hasta el cuadro anterior ya extraído.
      const prev = extracted.length > 0 ? extracted[extracted.length - 1].t_s : -1;
      for (const back of knownDuration ? EARLIER_RETRY_S : []) {
        if (frame) break;
        const t2 = Math.round(Math.max(0, t - back) * 1000) / 1000;
        if (t2 <= prev) break;
        frame = await extractOne(ffmpeg, input, outFile, t2, timeoutMs);
      }
      if (frame) extracted.push(frame);
    }
    if (extracted.length === 0) {
      for (const t of fallback) {
        const frame = await extractOne(ffmpeg, input, outFile, t, timeoutMs);
        if (frame) extracted.push(frame);
      }
    }

    if (extracted.length === 0) {
      throw new ServerFramesError(
        `No se pudo extraer ningún fotograma del video de ${media.label} (formato no reconocido o archivo dañado).`,
      );
    }
    extracted = extracted.slice(0, LIMITS.MAX_FRAMES_PER_MEDIA);

    // Si el medio ya tuviera cuadros, los nuevos siguen la numeración sin pisarlos.
    const existing = Array.isArray(media.frames) ? media.frames : [];
    const firstIdx = existing.reduce((m, f) => Math.max(m, f.idx + 1), 0);

    const newFrames: NewFrame[] = [];
    try {
      for (const [i, f] of extracted.entries()) {
        const idx = firstIdx + i;
        const storage_path = storagePaths.frame(media.incident_id, media.id, idx);
        await files.upload(storage_path, f.bytes, "image/jpeg");
        newFrames.push({
          idx,
          t_s: f.t_s,
          storage_path,
          width: f.width,
          height: f.height,
          lat: null,
          lng: null,
          alt_m: null,
          heading_deg: null,
        });
      }
    } catch (err) {
      throw new ServerFramesError(`No se pudieron guardar los fotogramas extraídos de ${media.label}.`, {
        cause: err,
      });
    }
    return store.addFrames(media.id, newFrames);
  });
}
