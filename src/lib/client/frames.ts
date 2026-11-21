/**
 * Extracción de fotogramas en el navegador: videos (muestreo con <video> + canvas),
 * fotos (con orientación EXIF) y captura de un <video> en vivo.
 * Se puede importar en SSR/node: los globals del navegador se tocan solo dentro de las funciones.
 */
import { LIMITS } from "@/lib/domain";
import {
  FrameExtractionError,
  HEIC_UNSUPPORTED_MESSAGE,
  type LumaStats,
  computeLumaStats,
  filterDarkFrames,
  jpegQualityLadder,
  mediaErrorToCode,
  MIN_FRAMES,
  probeInstants,
  progressFraction,
  roundTime,
  sampleInstants,
  sampleInstantsInRange,
  scaleToLongEdge,
  seekableSpan,
  usableDuration,
} from "@/lib/client/frames-core";

export {
  FrameExtractionError,
  isFrameExtractionError,
  type FrameExtractionErrorCode,
  type LumaStats,
  computeLumaStats,
  filterDarkFrames,
  shouldDropDarkFrames,
  isNearBlack,
  jpegQualityLadder,
  probeInstants,
  roundTime,
  sampleInstants,
  sampleInstantsInRange,
  scaleToLongEdge,
  seekableSpan,
  usableDuration,
} from "@/lib/client/frames-core";

export interface ExtractedFrame {
  /** 0..n-1 tras el filtrado. */
  idx: number;
  /** Segundo del video (centésimas); 0 en fotos. */
  t_s: number;
  /** JPEG ≤ LIMITS.MAX_FRAME_BYTES. */
  blob: Blob;
  width: number;
  height: number;
}

export interface ExtractedVideo {
  frames: ExtractedFrame[];
  /** null si el navegador nunca informó una duración finita. */
  duration_s: number | null;
  /** Dimensiones originales del video (ya rotadas según sus metadatos). */
  width: number;
  height: number;
}

export interface ExtractVideoFramesOptions {
  signal?: AbortSignal;
  /** Fracción 0..1. */
  onProgress?: (fraction: number) => void;
  /** Por defecto LIMITS.MAX_FRAMES_PER_MEDIA. */
  maxFrames?: number;
  /** Por defecto LIMITS.FRAME_LONG_EDGE_PX. */
  longEdge?: number;
  /** Espera de metadatos (ms). Por defecto 15 000. */
  metadataTimeoutMs?: number;
  /** Espera de cada seek (ms). Por defecto 8 000. */
  seekTimeoutMs?: number;
}

export interface ImageToFrameOptions {
  signal?: AbortSignal;
  longEdge?: number;
  /** Espera de decodificación con <img> (ms). Por defecto 20 000. */
  timeoutMs?: number;
}

const HAVE_METADATA = 1;
const HAVE_CURRENT_DATA = 2;
const STATS_SIZE = 16;
const MAX_CONSECUTIVE_TIMEOUTS = 2;

/* ---------- utilidades comunes ---------- */

/** Entre 1 y LIMITS.MAX_FRAMES_PER_MEDIA (el contrato rechaza más); NaN o ausente → el máximo. */
function clampMaxFrames(v: number | undefined): number {
  if (v === undefined || !Number.isFinite(v)) return LIMITS.MAX_FRAMES_PER_MEDIA;
  return Math.min(LIMITS.MAX_FRAMES_PER_MEDIA, Math.max(1, Math.floor(v)));
}

function assertDom(): void {
  if (
    typeof document === "undefined" ||
    typeof URL === "undefined" ||
    typeof URL.createObjectURL !== "function"
  ) {
    throw new FrameExtractionError("unsupported");
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new FrameExtractionError("aborted");
}

function toFrameError(err: unknown, fallback: FrameExtractionError["code"] = "failed"): FrameExtractionError {
  if (err instanceof FrameExtractionError) return err;
  return new FrameExtractionError(fallback, undefined, { cause: err });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/** iOS retiene la memoria de los canvas hasta que se reducen a 0×0. */
function releaseCanvas(canvas: HTMLCanvasElement | null): void {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
}

function get2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new FrameExtractionError("failed");
  return ctx;
}

function canvasToBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new FrameExtractionError("failed"))),
        "image/jpeg",
        quality,
      );
    } catch (err) {
      reject(toFrameError(err));
    }
  });
}

/**
 * Dibuja `source` escalado a (width, height) y lo codifica como JPEG ≤ LIMITS.MAX_FRAME_BYTES,
 * bajando la calidad y, si aún no cabe, la resolución.
 */
async function encodeJpeg(
  source: CanvasImageSource,
  width: number,
  height: number,
): Promise<{ blob: Blob; width: number; height: number; canvas: HTMLCanvasElement }> {
  let w = width;
  let h = height;
  for (let attempt = 0; attempt < 4; attempt++) {
    const canvas = createCanvas(w, h);
    try {
      get2d(canvas).drawImage(source, 0, 0, w, h);
      for (const q of jpegQualityLadder(LIMITS.FRAME_JPEG_QUALITY)) {
        const blob = await canvasToBlob(canvas, q);
        if (blob.size <= LIMITS.MAX_FRAME_BYTES) return { blob, width: w, height: h, canvas };
      }
    } catch (err) {
      releaseCanvas(canvas);
      throw toFrameError(err);
    }
    releaseCanvas(canvas);
    w = Math.max(1, Math.round(w * 0.7));
    h = Math.max(1, Math.round(h * 0.7));
  }
  throw new FrameExtractionError("failed");
}

/** Estadística de luminancia sobre una miniatura 16×16; null si el canvas no la entrega. */
function tinyStats(source: CanvasImageSource): LumaStats | null {
  let canvas: HTMLCanvasElement | null = null;
  try {
    canvas = createCanvas(STATS_SIZE, STATS_SIZE);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(source, 0, 0, STATS_SIZE, STATS_SIZE);
    return computeLumaStats(ctx.getImageData(0, 0, STATS_SIZE, STATS_SIZE).data);
  } catch {
    return null;
  } finally {
    releaseCanvas(canvas);
  }
}

/* ---------- espera de eventos del <video> ---------- */

interface WaitOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  /** Se resuelve solo cuando se cumple (se revisa al inicio y en cada evento). */
  until?: () => boolean;
  /**
   * Acción que dispara el evento (p. ej. fijar `currentTime`). Corre ya con los listeners puestos;
   * si lanza, la espera se rechaza y se limpia (sin promesas colgadas ni rechazos sin manejar).
   */
  start?: () => void;
}

function waitForMedia(video: HTMLVideoElement, events: readonly string[], opts: WaitOptions): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const { signal, until, start } = opts;
    if (signal?.aborted) return reject(new FrameExtractionError("aborted"));
    // un 'error' ocurrido fuera de una espera no se vuelve a emitir: sin esto se esperaría hasta el timeout
    if (video.error) return reject(new FrameExtractionError(mediaErrorToCode(video.error.code)));
    if (!start && until?.()) return resolve();
    // eslint-disable-next-line prefer-const -- lo lee `done`, definida antes de armar el temporizador
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (err?: FrameExtractionError) => {
      if (timer !== undefined) clearTimeout(timer);
      for (const e of events) video.removeEventListener(e, onEvent);
      video.removeEventListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
      if (err) reject(err);
      else resolve();
    };
    const onEvent = () => {
      if (!until || until()) done();
    };
    const onError = () => done(new FrameExtractionError(mediaErrorToCode(video.error?.code)));
    const onAbort = () => done(new FrameExtractionError("aborted"));
    for (const e of events) video.addEventListener(e, onEvent);
    video.addEventListener("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => done(new FrameExtractionError("timeout")), opts.timeoutMs);
    if (start) {
      try {
        start();
      } catch (err) {
        done(toFrameError(err));
        return;
      }
      if (until?.()) done();
    }
  });
}

function setupHiddenVideo(): HTMLVideoElement {
  const video = document.createElement("video");
  // iOS exige muted + playsinline (también como atributos) para decodificar sin pantalla completa
  video.muted = true;
  video.defaultMuted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.setAttribute("muted", "");
  video.setAttribute("playsinline", "");
  video.setAttribute("webkit-playsinline", "");
  video.setAttribute("preload", "auto");
  video.setAttribute("disablepictureinpicture", "");
  video.setAttribute("disableremoteplayback", "");
  video.setAttribute("aria-hidden", "true");
  video.style.cssText =
    "position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none;z-index:-1;";
  // algunos Safari no pintan cuadros de un <video> fuera del documento
  document.body?.appendChild(video);
  return video;
}

function cleanupVideo(video: HTMLVideoElement, url: string | null): void {
  try {
    video.pause();
  } catch {
    /* ya detenido */
  }
  video.removeAttribute("src");
  try {
    video.load();
  } catch {
    /* sin efecto en algunos navegadores */
  }
  video.remove();
  if (url !== null) URL.revokeObjectURL(url);
}

/** play() + pause(): iOS Safari a veces no pinta cuadros tras un seek si nunca se reprodujo. */
async function primePlayback(video: HTMLVideoElement): Promise<void> {
  try {
    const p = video.play();
    if (p && typeof p.then === "function") {
      await Promise.race([p.catch(() => undefined), sleep(1500)]);
    }
  } catch {
    /* autoplay rechazado: seguimos igual */
  }
  try {
    video.pause();
  } catch {
    /* nada */
  }
}

function readSeekable(video: HTMLVideoElement): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  try {
    const r = video.seekable;
    for (let i = 0; i < (r?.length ?? 0); i++) out.push([r.start(i), r.end(i)]);
  } catch {
    /* sin rangos */
  }
  return out;
}

async function seekTo(video: HTMLVideoElement, t: number, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  const already = Math.abs(video.currentTime - t) < 0.001 && !video.seeking;
  if (!already) {
    await waitForMedia(video, ["seeked"], {
      timeoutMs,
      signal,
      start: () => {
        video.currentTime = t;
      },
    });
  }
  if (video.readyState < HAVE_CURRENT_DATA) {
    await waitForMedia(video, ["loadeddata", "canplay", "seeked"], {
      timeoutMs: Math.min(timeoutMs, 4000),
      signal,
      until: () => video.readyState >= HAVE_CURRENT_DATA,
    }).catch((err: unknown) => {
      if (err instanceof FrameExtractionError && err.code !== "timeout") throw err;
    });
  }
}

/**
 * Duración del video. Si es Infinity/NaN (webm de MediaRecorder), se fuerza su cálculo
 * buscando un tiempo enorme y luego se vuelve al inicio; si aún falta, se usa `seekable`.
 */
async function resolveDuration(
  video: HTMLVideoElement,
  signal?: AbortSignal,
): Promise<{ duration: number | null; span: { start: number; end: number } | null }> {
  const known = usableDuration(video.duration);
  if (known !== null) return { duration: known, span: { start: 0, end: known } };

  // 'seeked' termina la espera aunque la duración siga desconocida; se registra antes que la espera
  let seeked = false;
  const onSeeked = () => {
    seeked = true;
  };
  video.addEventListener("seeked", onSeeked);
  try {
    await waitForMedia(video, ["durationchange", "timeupdate", "seeked"], {
      timeoutMs: 5000,
      signal,
      until: () => seeked || usableDuration(video.duration) !== null,
      start: () => {
        video.currentTime = 1e7;
      },
    });
  } catch (err) {
    if (err instanceof FrameExtractionError && err.code !== "timeout") throw err;
  } finally {
    video.removeEventListener("seeked", onSeeked);
  }
  try {
    await seekTo(video, 0, 4000, signal);
  } catch (err) {
    if (err instanceof FrameExtractionError && err.code !== "timeout") throw err;
  }

  const d = usableDuration(video.duration);
  if (d !== null) return { duration: d, span: { start: 0, end: d } };
  return { duration: null, span: seekableSpan(readSeekable(video)) };
}

interface RawFrame {
  t_s: number;
  blob: Blob;
  width: number;
  height: number;
  stats: LumaStats | null;
}

async function captureAt(
  video: HTMLVideoElement,
  t: number,
  size: { width: number; height: number },
  seekTimeoutMs: number,
  signal?: AbortSignal,
): Promise<RawFrame> {
  await seekTo(video, t, seekTimeoutMs, signal);
  let stats = tinyStats(video);
  if (stats && stats.alpha < 1) {
    // lienzo vacío (iOS sin cuadro pintado): reproducir un instante y volver a buscar
    await primePlayback(video);
    await seekTo(video, t, seekTimeoutMs, signal);
    stats = tinyStats(video);
  }
  throwIfAborted(signal);
  const enc = await encodeJpeg(video, size.width, size.height);
  releaseCanvas(enc.canvas);
  const actual = Number.isFinite(video.currentTime) ? video.currentTime : t;
  return { t_s: roundTime(Math.max(0, actual)), blob: enc.blob, width: enc.width, height: enc.height, stats };
}

/**
 * Extrae fotogramas JPEG repartidos a lo largo del video. Lanza `FrameExtractionError`
 * ("unsupported" si el navegador no puede decodificarlo: el servidor lo hará con ffmpeg).
 */
export async function extractVideoFrames(
  file: File | Blob,
  opts: ExtractVideoFramesOptions = {},
): Promise<ExtractedVideo> {
  const { signal, onProgress } = opts;
  const maxFrames = clampMaxFrames(opts.maxFrames);
  const longEdge = opts.longEdge ?? LIMITS.FRAME_LONG_EDGE_PX;
  const seekTimeoutMs = opts.seekTimeoutMs ?? 8000;
  const report = (f: number) => {
    try {
      onProgress?.(f);
    } catch {
      /* un callback con errores no debe cortar la extracción */
    }
  };

  throwIfAborted(signal);
  assertDom();
  report(0);

  let url: string | null = null;
  let video: HTMLVideoElement | null = null;
  try {
    const src = URL.createObjectURL(file);
    url = src;
    video = setupHiddenVideo();
    const v = video;
    await waitForMedia(v, ["loadedmetadata"], {
      timeoutMs: opts.metadataTimeoutMs ?? 15000,
      signal,
      until: () => v.readyState >= HAVE_METADATA,
      start: () => {
        v.src = src;
      },
    });
    if (!v.videoWidth || !v.videoHeight) throw new FrameExtractionError("unsupported");

    await primePlayback(v);
    throwIfAborted(signal);

    const { duration, span } = await resolveDuration(v, signal);
    const size = scaleToLongEdge(v.videoWidth, v.videoHeight, longEdge);
    const probing = span === null;
    const instants =
      span === null
        ? probeInstants(maxFrames)
        : duration !== null
          ? sampleInstants(duration, maxFrames)
          : sampleInstantsInRange(span.start, span.end, maxFrames);
    report(progressFraction(0, instants.length));

    const raw: RawFrame[] = [];
    let lastError: FrameExtractionError | null = null;
    let consecutiveTimeouts = 0;
    for (let i = 0; i < instants.length; i++) {
      throwIfAborted(signal);
      const t = instants[i];
      try {
        const frame = await captureAt(v, t, size, probing ? Math.min(seekTimeoutMs, 4000) : seekTimeoutMs, signal);
        const prev = raw[raw.length - 1];
        const reachedEnd = probing && (v.ended || v.currentTime + 0.25 < t);
        if (!prev || frame.t_s > prev.t_s) raw.push(frame);
        consecutiveTimeouts = 0;
        if (reachedEnd) break;
      } catch (err) {
        const e = toFrameError(err);
        if (e.code === "aborted") throw e;
        lastError = e;
        // decodificador trabado (p. ej. HEVC sin soporte): no esperar el timeout de cada cuadro restante
        if (e.code === "timeout" && ++consecutiveTimeouts >= MAX_CONSECUTIVE_TIMEOUTS) break;
        // el decodificador murió: se devuelve lo que haya
        if (e.code === "unsupported") break;
        // al sondear a ciegas, un seek que no termina indica que se pasó del final
        if (probing && raw.length > 0) break;
      }
      report(progressFraction(i + 1, instants.length));
    }

    throwIfAborted(signal);
    if (raw.length === 0) throw lastError ?? new FrameExtractionError("empty");

    const keep = filterDarkFrames(
      raw.map((f) => f.stats),
      Math.min(MIN_FRAMES, raw.length),
    );
    const frames: ExtractedFrame[] = keep.map((k, idx) => {
      const f = raw[k];
      return { idx, t_s: f.t_s, blob: f.blob, width: f.width, height: f.height };
    });
    report(1);
    const finalDuration = duration ?? usableDuration(v.duration);
    return {
      frames,
      duration_s: finalDuration !== null ? roundTime(finalDuration) : null,
      width: v.videoWidth,
      height: v.videoHeight,
    };
  } catch (err) {
    throw toFrameError(err);
  } finally {
    if (video) cleanupVideo(video, url);
    else if (url !== null) URL.revokeObjectURL(url);
  }
}

/* ---------- fotos ---------- */

function looksHeic(file: Blob): boolean {
  const type = (file.type || "").toLowerCase();
  const name = typeof File !== "undefined" && file instanceof File ? file.name.toLowerCase() : "";
  return type.includes("heic") || type.includes("heif") || /\.(heic|heif)$/.test(name);
}

async function decodeWithImageBitmap(file: Blob): Promise<ImageBitmap | null> {
  if (typeof createImageBitmap !== "function") return null;
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    /* navegadores antiguos rechazan la opción */
  }
  try {
    return await createImageBitmap(file);
  } catch {
    return null;
  }
}

function decodeWithImg(file: Blob, timeoutMs: number, signal?: AbortSignal): Promise<HTMLImageElement> {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.decoding = "async";
    // eslint-disable-next-line prefer-const -- lo lee `finish`, definida antes de armar el temporizador
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (err?: FrameExtractionError) => {
      if (timer !== undefined) clearTimeout(timer);
      img.onload = null;
      img.onerror = null;
      signal?.removeEventListener("abort", onAbort);
      URL.revokeObjectURL(url);
      if (err) {
        img.removeAttribute("src");
        reject(err);
      } else resolve(img);
    };
    const onAbort = () => finish(new FrameExtractionError("aborted"));
    img.onload = () =>
      img.naturalWidth > 0 && img.naturalHeight > 0
        ? finish()
        : finish(new FrameExtractionError("unsupported"));
    img.onerror = () => finish(new FrameExtractionError("unsupported"));
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => finish(new FrameExtractionError("timeout")), timeoutMs);
    img.src = url;
  });
}

/**
 * Convierte una foto en un fotograma JPEG (idx 0, t_s 0) respetando la orientación EXIF.
 * HEIC u otros formatos que el navegador no abre → `FrameExtractionError("unsupported")`.
 */
export async function imageToFrame(file: File | Blob, opts: ImageToFrameOptions = {}): Promise<ExtractedFrame> {
  const { signal } = opts;
  const longEdge = opts.longEdge ?? LIMITS.FRAME_LONG_EDGE_PX;
  throwIfAborted(signal);
  if (typeof document === "undefined") throw new FrameExtractionError("unsupported");

  const unsupported = () =>
    new FrameExtractionError(
      "unsupported",
      looksHeic(file) ? HEIC_UNSUPPORTED_MESSAGE : "Este navegador no puede abrir esta foto. Prueba con otra foto en JPG o PNG.",
    );

  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await decodeWithImageBitmap(file);
    throwIfAborted(signal);
    let source: CanvasImageSource;
    let w: number;
    let h: number;
    if (bitmap && bitmap.width > 0 && bitmap.height > 0) {
      source = bitmap;
      w = bitmap.width;
      h = bitmap.height;
    } else {
      if (typeof Image === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
        throw unsupported();
      }
      let img: HTMLImageElement;
      try {
        img = await decodeWithImg(file, opts.timeoutMs ?? 20000, signal);
      } catch (err) {
        if (err instanceof FrameExtractionError && err.code === "unsupported") throw unsupported();
        throw err;
      }
      source = img;
      w = img.naturalWidth;
      h = img.naturalHeight;
    }
    const size = scaleToLongEdge(w, h, longEdge);
    const enc = await encodeJpeg(source, size.width, size.height);
    releaseCanvas(enc.canvas);
    return { idx: 0, t_s: 0, blob: enc.blob, width: enc.width, height: enc.height };
  } catch (err) {
    throw toFrameError(err);
  } finally {
    bitmap?.close();
  }
}

/* ---------- <video> en vivo (cámara del modo sensor) ---------- */

/**
 * Captura el cuadro visible de un <video> (p. ej. con un stream de getUserMedia) como JPEG,
 * con el lado mayor ≤ longEdge.
 */
export async function captureVideoElementFrame(
  videoEl: HTMLVideoElement,
  longEdge: number = LIMITS.FRAME_LONG_EDGE_PX,
): Promise<Blob> {
  if (typeof document === "undefined") throw new FrameExtractionError("unsupported");
  if (videoEl.readyState < HAVE_CURRENT_DATA || !videoEl.videoWidth) {
    await waitForMedia(videoEl, ["loadeddata", "canplay", "playing", "resize"], {
      timeoutMs: 5000,
      until: () => videoEl.readyState >= HAVE_CURRENT_DATA && videoEl.videoWidth > 0,
    }).catch((err: unknown) => {
      if (err instanceof FrameExtractionError && err.code === "timeout") {
        throw new FrameExtractionError("empty", "La cámara aún no entrega imagen. Espera un momento e inténtalo de nuevo.");
      }
      throw toFrameError(err);
    });
  }
  const size = scaleToLongEdge(videoEl.videoWidth, videoEl.videoHeight, longEdge);
  if (!size.width || !size.height) {
    throw new FrameExtractionError("empty", "La cámara aún no entrega imagen. Espera un momento e inténtalo de nuevo.");
  }
  try {
    const enc = await encodeJpeg(videoEl, size.width, size.height);
    releaseCanvas(enc.canvas);
    return enc.blob;
  } catch (err) {
    throw toFrameError(err);
  }
}
