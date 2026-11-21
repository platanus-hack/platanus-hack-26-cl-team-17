/**
 * Núcleo de la subida de reportes: lógica pura (backoff, progreso, armado del cuerpo)
 * y la orquestación de `submitReport` con dependencias inyectadas, para probarla en node.
 * `upload.ts` conecta esto con `frames.ts` y el cliente `api`.
 * No toca globals del navegador al importarse.
 */
import { ApiClientError, type ApiErrorCode, type CreateReportBody } from "@/lib/client/api";
import type { CompleteReportRequest, CreateReportResponse, UploadTarget } from "@/lib/contract";
import { LIMITS, type FrameMeta, type IncidentType } from "@/lib/domain";

/* ════════════════════════════ Tipos públicos ════════════════════════════ */

export type UploadStage =
  | "extracting"
  | "registering"
  | "uploading_frames"
  | "analyzing_started"
  | "uploading_video"
  | "done";

export interface UploadProgress {
  stage: UploadStage;
  /** Avance total 0..1, nunca retrocede. */
  fraction: number;
  /** Avance dentro de la etapa actual 0..1, si se conoce. */
  stageFraction?: number;
  message: string;
}

export interface ReportPosition {
  lat: number;
  lng: number;
  accuracy_m?: number | null;
}

export interface FramesUploadedInfo {
  mediaId: string;
  incidentCode: string;
  createdIncident: boolean;
  framesSent: number;
}

export interface SubmitReportOptions {
  file?: File;
  /** Varias fotos (kind "photo"). */
  files?: File[];
  kind: "video" | "photo";
  incidentCode?: string;
  typeHint?: IncidentType;
  note: string;
  position?: ReportPosition | null;
  heading?: number | null;
  /** Instante de captura conocido; `file.lastModified` de la galería no es confiable y no se usa. */
  capturedAt?: string | Date | null;
  asResponder?: boolean;
  signal?: AbortSignal;
  onProgress?: (p: UploadProgress) => void;
  /** Se llama apenas los fotogramas llegaron y el análisis empezó. */
  onFramesUploaded?: (r: FramesUploadedInfo) => void;
  /** Subir también el video original (por defecto true para video). */
  uploadVideo?: boolean;
}

export type VideoOutcome = "uploaded" | "skipped_too_large" | "failed" | "none";

export interface SubmitReportResult {
  mediaId: string;
  incidentCode: string;
  createdIncident: boolean;
  framesSent: number;
  /** true si el navegador no pudo sacar fotogramas y se envió solo el video. */
  framesUnsupported: boolean;
  video: VideoOutcome;
  videoError?: string;
}

export type SubmitReportErrorCode =
  | ApiErrorCode
  | "unsupported"
  | "empty"
  | "timeout"
  | "failed";

export class SubmitReportError extends Error {
  readonly stage: UploadStage;
  readonly code: SubmitReportErrorCode;
  readonly status: number;
  /** true si tiene sentido mostrar "Reintentar". */
  readonly retryable: boolean;
  /** Medio ya registrado en el servidor (null si falló antes). */
  readonly mediaId: string | null;
  /** true si Bomberos ya recibió los fotogramas (no hace falta reenviar todo). */
  readonly framesDelivered: boolean;

  constructor(
    message: string,
    init: {
      stage: UploadStage;
      code: SubmitReportErrorCode;
      status?: number;
      retryable?: boolean;
      mediaId?: string | null;
      framesDelivered?: boolean;
      cause?: unknown;
    },
  ) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "SubmitReportError";
    this.stage = init.stage;
    this.code = init.code;
    this.status = init.status ?? 0;
    this.retryable = init.retryable ?? isRetryableCode(init.code);
    this.mediaId = init.mediaId ?? null;
    this.framesDelivered = init.framesDelivered ?? false;
  }
}

export function isSubmitReportError(err: unknown): err is SubmitReportError {
  return err instanceof SubmitReportError;
}

/* ════════════════════════════ Helpers puros ════════════════════════════ */

/**
 * Espera antes del reintento `attempt` (0 = primer reintento): exponencial con tope
 * y "equal jitter" (entre la mitad y el total del tramo) para no sincronizar clientes.
 */
export function backoffDelay(
  attempt: number,
  base = 500,
  max = 8000,
  rand: () => number = Math.random,
): number {
  const a = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  const cap = Math.max(0, Math.min(max, base * 2 ** Math.min(a, 30)));
  const r = Math.min(1, Math.max(0, rand()));
  return Math.round(cap / 2 + (r * cap) / 2);
}

/** Reintentar solo errores de red (status 0), 408, 429 y 5xx. */
export function isRetryableStatus(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || (status >= 500 && status <= 599);
}

const NON_RETRYABLE_CODES: ReadonlySet<string> = new Set([
  "invalid",
  "too_large",
  "conflict",
  "forbidden",
  "not_found",
  "unsupported",
  "empty",
]);

function isRetryableCode(code: string): boolean {
  return !NON_RETRYABLE_CODES.has(code);
}

type StageSpan = readonly [start: number, end: number];

const SPANS_WITH_VIDEO: Record<UploadStage, StageSpan> = {
  extracting: [0, 0.12],
  registering: [0.12, 0.15],
  uploading_frames: [0.15, 0.35],
  analyzing_started: [0.35, 0.37],
  uploading_video: [0.37, 0.99],
  done: [1, 1],
};

const SPANS_NO_VIDEO: Record<UploadStage, StageSpan> = {
  extracting: [0, 0.3],
  registering: [0.3, 0.38],
  uploading_frames: [0.38, 0.95],
  analyzing_started: [0.95, 0.99],
  // Sin video esta etapa no ocurre; se ubica al final para no retroceder si aparece.
  uploading_video: [0.99, 0.99],
  done: [1, 1],
};

/** Avance total 0..1 para una etapa y su avance interno. */
export function overallFraction(
  stage: UploadStage,
  stageFraction: number | null | undefined,
  hasVideo: boolean,
): number {
  const [start, end] = (hasVideo ? SPANS_WITH_VIDEO : SPANS_NO_VIDEO)[stage];
  const f =
    typeof stageFraction === "number" && Number.isFinite(stageFraction)
      ? Math.min(1, Math.max(0, stageFraction))
      : 0;
  return start + (end - start) * f;
}

/** Etiqueta en español para cada etapa. */
export function stageMessage(
  stage: UploadStage,
  ctx: { kind: "video" | "photo"; framesSent?: number } = { kind: "video" },
): string {
  const hasFrames = (ctx.framesSent ?? 1) > 0;
  switch (stage) {
    case "extracting":
      return ctx.kind === "photo" ? "Preparando fotos…" : "Preparando imágenes…";
    case "registering":
      return "Registrando tu reporte…";
    case "uploading_frames":
      return ctx.kind === "photo" ? "Enviando fotos…" : "Enviando imágenes…";
    case "analyzing_started":
      return hasFrames
        ? "Bomberos ya recibió tus imágenes"
        : "Preparando el envío del video…";
    case "uploading_video":
      return hasFrames
        ? "Bomberos ya recibió tus imágenes. Subiendo el video completo, no cierres esta página…"
        : "Subiendo el video, no cierres esta página…";
    case "done":
      return "Listo, tu reporte llegó a Bomberos.";
  }
}

/** Emite progreso con fracción total monótona; los errores del callback no cortan la subida. */
export function createProgressReporter(
  hasVideo: boolean,
  onProgress: ((p: UploadProgress) => void) | undefined,
): (stage: UploadStage, stageFraction: number | undefined, message: string) => void {
  let last = 0;
  return (stage, stageFraction, message) => {
    const overall = Math.max(last, overallFraction(stage, stageFraction, hasVideo));
    last = overall;
    if (!onProgress) return;
    const p: UploadProgress = { stage, fraction: overall, message };
    if (typeof stageFraction === "number" && Number.isFinite(stageFraction)) {
      p.stageFraction = Math.min(1, Math.max(0, stageFraction));
    }
    try {
      onProgress(p);
    } catch {
      /* la UI no debe poder romper el envío */
    }
  };
}

/**
 * Ejecuta `fn` sobre `items` con a lo más `limit` tareas a la vez, preservando el orden.
 * Ante el primer error deja de lanzar tareas nuevas, espera las que están en curso y lo rechaza.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const workers = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  let next = 0;
  let failed = false;
  let firstError: unknown;
  const worker = async () => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        if (!failed) {
          failed = true;
          firstError = err;
        }
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: workers }, worker));
  if (failed) throw firstError;
  return results;
}

/** Rumbo 0..360 (exclusivo) o null si no es un número válido. */
export function normalizeHeading(heading: number | null | undefined): number | null {
  if (typeof heading !== "number" || !Number.isFinite(heading)) return null;
  const h = ((heading % 360) + 360) % 360;
  return h === 360 ? 0 : h;
}

/** ISO 8601 en UTC ("Z", como exige el esquema) o null. */
export function toIsoOrNull(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  const t = d.getTime();
  return Number.isFinite(t) ? d.toISOString() : null;
}

/** Recorta y limita la nota sin dejar medio emoji al final. */
export function cleanNote(note: string | null | undefined, max: number = LIMITS.MAX_NOTE_CHARS): string {
  let s = (note ?? "").trim();
  if (s.length <= max) return s;
  s = s.slice(0, max);
  const lastCode = s.charCodeAt(s.length - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) s = s.slice(0, -1);
  return s.trimEnd();
}

export function sanitizePosition(
  position: ReportPosition | null | undefined,
): { lat: number | null; lng: number | null; accuracy_m: number | null } {
  if (
    !position ||
    !Number.isFinite(position.lat) ||
    !Number.isFinite(position.lng) ||
    Math.abs(position.lat) > 90 ||
    Math.abs(position.lng) > 180
  ) {
    return { lat: null, lng: null, accuracy_m: null };
  }
  const acc = position.accuracy_m;
  return {
    lat: position.lat,
    lng: position.lng,
    accuracy_m: typeof acc === "number" && Number.isFinite(acc) && acc >= 0 ? acc : null,
  };
}

const MIME_BY_EXT: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  qt: "video/quicktime",
  webm: "video/webm",
  "3gp": "video/3gpp",
  "3g2": "video/3gpp2",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  heic: "image/heic",
  heif: "image/heif",
  avif: "image/avif",
};

/**
 * Tipo MIME del archivo: `file.type` sin parámetros (p. ej. "video/webm;codecs=vp9" → "video/webm");
 * si viene vacío (pasa en Android con algunos .3gp/.mov), se deduce por la extensión.
 */
export function guessMime(name: string, type: string, kind: "video" | "photo"): string {
  const base = (type ?? "").split(";")[0].trim().toLowerCase();
  if (base && base.length <= 120 && base !== "application/octet-stream") return base;
  const ext = (name ?? "").split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? (kind === "video" ? "video/mp4" : "image/jpeg");
}

/** Extensión de archivo para un MIME de video (la misma convención que usa el servidor). */
export function videoExtension(mime: string): "mp4" | "mov" | "webm" | "3gp" {
  const m = mime.split(";")[0].trim().toLowerCase();
  if (m === "video/quicktime") return "mov";
  if (m === "video/webm") return "webm";
  if (m === "video/3gpp" || m === "video/3gpp2") return "3gp";
  return "mp4";
}

export function formatMb(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;
}

/** true si `url` es absoluta y de otro origen que `origin` (sin origen conocido, toda URL absoluta lo es). */
export function isCrossOrigin(url: string, origin?: string | null): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false; // relativa → mismo origen
  }
  const here =
    origin !== undefined
      ? origin
      : typeof location !== "undefined" && typeof location.origin === "string"
        ? location.origin
        : null;
  return here === null || parsed.origin !== here;
}

/**
 * Cuerpo a enviar: si el Blob trae `type`, el navegador agregaría un Content-Type que no está
 * en la firma de la URL y Cloud Storage rechazaría la subida. Se re-etiqueta sin tipo
 * (slice no copia los bytes) y solo viajan las cabeceras del destino.
 */
export function bodyForTarget(body: Blob): Blob {
  return body.type ? body.slice(0, body.size, "") : body;
}

export interface LocalFrame {
  idx: number;
  t_s: number;
  blob: Blob;
  width: number;
  height: number;
}

/** Deja fotogramas válidos para el esquema: máx. N, tamaño ≤ MAX_FRAME_BYTES, idx únicos 0..63. */
export function prepareFrames(frames: readonly LocalFrame[]): LocalFrame[] {
  const seen = new Set<number>();
  const out: LocalFrame[] = [];
  for (const f of frames) {
    if (out.length >= LIMITS.MAX_FRAMES_PER_MEDIA) break;
    if (!f || !(f.blob.size > 0) || f.blob.size > LIMITS.MAX_FRAME_BYTES) continue;
    const width = Math.round(f.width);
    const height = Math.round(f.height);
    if (!(width >= 1 && width <= 8000 && height >= 1 && height <= 8000)) continue;
    let idx = Number.isInteger(f.idx) && f.idx >= 0 && f.idx <= 63 ? f.idx : -1;
    if (idx < 0 || seen.has(idx)) {
      idx = 0;
      while (seen.has(idx)) idx++;
    }
    seen.add(idx);
    out.push({
      idx,
      t_s: Number.isFinite(f.t_s) && f.t_s > 0 ? f.t_s : 0,
      blob: f.blob,
      width,
      height,
    });
  }
  return out;
}

export function frameMeta(frames: readonly LocalFrame[]): FrameMeta[] {
  return frames.map((f) => ({ idx: f.idx, t_s: f.t_s, width: f.width, height: f.height }));
}

export function buildCreateReportBody(input: {
  kind: "video" | "photo";
  mime: string;
  sizeBytes: number;
  durationS: number | null;
  position?: ReportPosition | null;
  heading?: number | null;
  capturedAt?: string | Date | null;
  note: string;
  frames: readonly LocalFrame[];
  uploadVideo: boolean;
  incidentCode?: string;
  typeHint?: IncidentType;
  asResponder?: boolean;
}): CreateReportBody {
  const pos = sanitizePosition(input.position);
  const body: CreateReportBody = {
    kind: input.kind,
    mime: input.mime.slice(0, 120),
    size_bytes: Math.max(0, Math.round(input.sizeBytes || 0)),
    duration_s:
      typeof input.durationS === "number" && Number.isFinite(input.durationS) && input.durationS >= 0
        ? input.durationS
        : null,
    lat: pos.lat,
    lng: pos.lng,
    accuracy_m: pos.accuracy_m,
    heading_deg: normalizeHeading(input.heading),
    captured_at: toIsoOrNull(input.capturedAt),
    note: cleanNote(input.note),
    frames: frameMeta(input.frames),
    upload_video: input.uploadVideo,
  };
  const code = input.incidentCode?.trim();
  if (code) body.incident_code = code.slice(0, 16);
  if (input.typeHint) body.type_hint = input.typeHint;
  if (input.asResponder) body.as_responder = true;
  return body;
}

/** Error de una subida a un `UploadTarget` según el status final (0 = sin conexión). */
export function uploadErrorFor(status: number): ApiClientError {
  if (status === 0) {
    return new ApiClientError(0, "network", "Se perdió la conexión. Revisa tu señal e intenta de nuevo.");
  }
  if (status === 401 || status === 403) {
    return new ApiClientError(status, "forbidden", "El permiso de subida venció. Intenta enviar de nuevo.");
  }
  if (status === 413) {
    return new ApiClientError(status, "too_large", "El archivo es demasiado grande para enviarlo.");
  }
  if (status === 408 || status === 429 || status >= 500) {
    return new ApiClientError(
      status,
      status === 429 ? "rate_limited" : "internal",
      "El servidor no pudo recibir el archivo. Intenta de nuevo en un momento.",
    );
  }
  return new ApiClientError(status, "invalid", "No pudimos subir el archivo. Intenta de nuevo.");
}

/* ════════════════════════════ Señales y esperas ════════════════════════════ */

export function abortedError(): ApiClientError {
  return new ApiClientError(0, "aborted", "Envío cancelado.");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortedError();
}

/** Espera `ms` o rechaza apenas se cancele `signal`. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortedError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortedError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Controlador que también se cancela cuando se cancela `parent`. */
function linkedController(parent: AbortSignal | undefined): { controller: AbortController; unlink: () => void } {
  const controller = new AbortController();
  if (!parent) return { controller, unlink: () => {} };
  if (parent.aborted) {
    controller.abort();
    return { controller, unlink: () => {} };
  }
  const onAbort = () => controller.abort();
  parent.addEventListener("abort", onAbort, { once: true });
  return { controller, unlink: () => parent.removeEventListener("abort", onAbort) };
}

/** Rechaza con `abortedError()` apenas se cancele `signal`, aunque `p` ignore la señal. */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    p.catch(() => {});
    return Promise.reject(abortedError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortedError());
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

export function isAbortError(err: unknown): boolean {
  if (err instanceof ApiClientError) return err.code === "aborted";
  if (typeof DOMException !== "undefined" && err instanceof DOMException) return err.name === "AbortError";
  return err instanceof Error && err.name === "AbortError";
}

/* ════════════════════════════ PUT a UploadTarget ════════════════════════════ */

export interface PutOptions {
  /** Avance 0..1 del intento en curso; si se pasa, en el navegador se usa XMLHttpRequest. */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  /** Reintentos tras el primer intento (por defecto 3). */
  retries?: number;
  /** Corta el intento si pasan estos ms sin avance (con fetch: duración total del intento). */
  idleTimeoutMs?: number;
  /** Base del backoff exponencial (por defecto 500 ms). */
  retryBaseMs?: number;
}

interface SendOptions {
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  idleTimeoutMs?: number;
}

/** Un intento: resuelve con el status HTTP (0 = red caída o tiempo agotado); rechaza solo si se canceló. */
type Send = (target: UploadTarget, body: Blob, o: SendOptions) => Promise<number>;

const sendWithFetch: Send = async (target, body, o) => {
  const { controller, unlink } = linkedController(o.signal);
  const timer =
    o.idleTimeoutMs && o.idleTimeoutMs > 0 ? setTimeout(() => controller.abort(), o.idleTimeoutMs) : undefined;
  try {
    const res = await fetch(target.url, {
      method: target.method,
      headers: { ...target.headers },
      body,
      credentials: isCrossOrigin(target.url) ? "omit" : "same-origin",
      signal: controller.signal,
    });
    try {
      await res.arrayBuffer(); // libera la conexión
    } catch {
      /* cuerpo irrelevante */
    }
    if (res.status >= 200 && res.status < 300) {
      try {
        o.onProgress?.(1);
      } catch {
        /* un callback que falla no debe convertir un 200 en reintento */
      }
    }
    return res.status;
  } catch {
    if (o.signal?.aborted) throw abortedError();
    return 0;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    unlink();
  }
};

const sendWithXhr: Send = (target, body, o) =>
  new Promise<number>((resolve, reject) => {
    if (o.signal?.aborted) {
      reject(abortedError());
      return;
    }
    const xhr = new XMLHttpRequest();
    let settled = false;
    let timedOut = false;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => xhr.abort();
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (idle !== undefined) clearTimeout(idle);
      o.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const arm = () => {
      if (!o.idleTimeoutMs || o.idleTimeoutMs <= 0) return;
      if (idle !== undefined) clearTimeout(idle);
      idle = setTimeout(() => {
        timedOut = true;
        xhr.abort();
      }, o.idleTimeoutMs);
    };
    try {
      xhr.open(target.method, target.url, true);
      for (const [k, v] of Object.entries(target.headers)) xhr.setRequestHeader(k, v);
    } catch {
      finish(() => reject(new ApiClientError(0, "invalid", "No pudimos preparar la subida del archivo.")));
      return;
    }
    xhr.upload.addEventListener("progress", (e) => {
      arm();
      if (e.lengthComputable && e.total > 0) {
        try {
          o.onProgress?.(Math.min(1, e.loaded / e.total));
        } catch {
          /* la UI no debe poder romper la subida */
        }
      }
    });
    xhr.addEventListener("load", () =>
      finish(() => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            o.onProgress?.(1);
          } catch {
            /* idem */
          }
        }
        resolve(xhr.status);
      }),
    );
    xhr.addEventListener("error", () => finish(() => resolve(0)));
    xhr.addEventListener("timeout", () => finish(() => resolve(0)));
    xhr.addEventListener("abort", () =>
      finish(() => (timedOut || !o.signal?.aborted ? resolve(0) : reject(abortedError()))),
    );
    o.signal?.addEventListener("abort", onAbort, { once: true });
    arm();
    try {
      xhr.send(body);
    } catch {
      // Sin esto quedarían colgados el temporizador y el listener de la señal.
      finish(() => resolve(0));
    }
  });

/**
 * PUT de `body` a un `UploadTarget` (ruta relativa en modo local o URL firmada absoluta).
 * Envía exactamente `target.headers`, sin credenciales hacia otros orígenes, con reintentos
 * con backoff solo ante red caída / 408 / 429 / 5xx. Lanza `ApiClientError`.
 */
export async function putToTarget(target: UploadTarget, body: Blob, opts: PutOptions = {}): Promise<void> {
  const useXhr = opts.onProgress !== undefined && typeof XMLHttpRequest !== "undefined";
  return putWithSender(useXhr ? sendWithXhr : sendWithFetch, target, body, opts);
}

async function putWithSender(send: Send, target: UploadTarget, body: Blob, opts: PutOptions): Promise<void> {
  const retries = Math.max(0, Math.floor(opts.retries ?? 3));
  const payload = bodyForTarget(body);
  for (let attempt = 0; ; attempt++) {
    throwIfAborted(opts.signal);
    const status = await send(target, payload, {
      onProgress: opts.onProgress,
      signal: opts.signal,
      idleTimeoutMs: opts.idleTimeoutMs,
    });
    if (status >= 200 && status < 300) return;
    if (!isRetryableStatus(status) || attempt >= retries) throw uploadErrorFor(status);
    try {
      opts.onProgress?.(0);
    } catch {
      /* idem */
    }
    await sleep(backoffDelay(attempt, opts.retryBaseMs ?? 500), opts.signal);
  }
}

/* ════════════════════════════ Orquestación ════════════════════════════ */

export interface ExtractedVideo {
  frames: LocalFrame[];
  duration_s: number | null;
  width: number;
  height: number;
}

export interface SubmitReportDeps {
  extractVideoFrames: (
    file: File,
    opts: { signal?: AbortSignal; onProgress?: (fraction: number) => void },
  ) => Promise<ExtractedVideo>;
  imageToFrame: (file: File, signal?: AbortSignal) => Promise<{ blob: Blob; width: number; height: number }>;
  /** Código de `FrameExtractionError` o null si el error es de otro tipo. */
  extractionErrorCode: (err: unknown) => string | null;
  createReport: (body: CreateReportBody, signal?: AbortSignal) => Promise<CreateReportResponse>;
  completeReport: (
    mediaId: string,
    token: string,
    body: CompleteReportRequest,
    signal?: AbortSignal,
  ) => Promise<unknown>;
  putToTarget: (target: UploadTarget, body: Blob, opts: PutOptions) => Promise<void>;
  /** Base del backoff para reintentos de /complete (por defecto 500 ms). */
  retryBaseMs?: number;
  /** Tope por intento de /complete (por defecto 20 s); el cliente `api` no trae tiempo de espera. */
  completeTimeoutMs?: number;
  /** Tope total de un aviso de mejor esfuerzo (por defecto 15 s). */
  bestEffortTimeoutMs?: number;
}

const FRAME_CONCURRENCY = 3;
const FRAME_RETRIES = 3;
const FRAME_IDLE_TIMEOUT_MS = 60_000;
const VIDEO_RETRIES = 2;
const VIDEO_IDLE_TIMEOUT_MS = 90_000;
const COMPLETE_RETRIES = 3;
const COMPLETE_TIMEOUT_MS = 20_000;
const BEST_EFFORT_TIMEOUT_MS = 15_000;

function stageFailMessage(stage: UploadStage, kind: "video" | "photo"): string {
  switch (stage) {
    case "extracting":
      return kind === "photo"
        ? "No pudimos leer las fotos. Prueba eligiéndolas de nuevo."
        : "No pudimos leer el video. Prueba grabando de nuevo o elige otro archivo.";
    case "registering":
      return "No pudimos registrar tu reporte. Revisa tu señal e intenta de nuevo.";
    case "uploading_frames":
      return "No pudimos enviar las imágenes. Revisa tu señal e intenta de nuevo.";
    case "analyzing_started":
      return "Las imágenes subieron, pero no pudimos avisarle a Bomberos. Intenta de nuevo.";
    case "uploading_video":
      return "No pudimos subir el video. Revisa tu señal e intenta de nuevo.";
    case "done":
      return "Ocurrió un error inesperado. Intenta de nuevo.";
  }
}

/** Mensajes del servidor que conviene mostrar tal cual (son claros para el vecino). */
const SERVER_MESSAGE_CODES: ReadonlySet<string> = new Set([
  "invalid",
  "conflict",
  "too_large",
  "rate_limited",
  "not_found",
  "forbidden",
]);

function toSubmitError(
  err: unknown,
  stage: UploadStage,
  ctx: { kind: "video" | "photo"; mediaId: string | null; framesDelivered: boolean },
): SubmitReportError {
  if (err instanceof SubmitReportError) return err;
  const base = { stage, mediaId: ctx.mediaId, framesDelivered: ctx.framesDelivered, cause: err };
  if (isAbortError(err)) {
    return new SubmitReportError("Envío cancelado.", { ...base, code: "aborted", retryable: true });
  }
  if (err instanceof ApiClientError) {
    const useServer = stage === "registering" && SERVER_MESSAGE_CODES.has(err.code) && err.message;
    const message = useServer
      ? err.message
      : err.code === "network"
        ? "Se perdió la conexión mientras enviábamos tu reporte. Revisa tu señal e intenta de nuevo."
        : stageFailMessage(stage, ctx.kind);
    return new SubmitReportError(message, { ...base, code: err.code, status: err.status });
  }
  return new SubmitReportError(stageFailMessage(stage, ctx.kind), { ...base, code: "failed" });
}

/** /complete es idempotente: se reintenta ante red caída / 408 / 429 / 5xx. */
async function completeWithRetry(
  deps: SubmitReportDeps,
  mediaId: string,
  token: string,
  body: CompleteReportRequest,
  signal: AbortSignal | undefined,
): Promise<void> {
  const timeoutMs = deps.completeTimeoutMs ?? COMPLETE_TIMEOUT_MS;
  for (let attempt = 0; ; attempt++) {
    throwIfAborted(signal);
    // Cada intento con tope propio: un fetch colgado (señal móvil caída) no debe trabar el envío.
    const { controller, unlink } = linkedController(signal);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    let failure: unknown;
    try {
      await untilAborted(deps.completeReport(mediaId, token, body, controller.signal), controller.signal);
      return;
    } catch (err) {
      failure = err;
    } finally {
      clearTimeout(timer);
      unlink();
    }
    if (signal?.aborted) throw abortedError();
    if (!timedOut && isAbortError(failure)) throw failure;
    const err = timedOut ? uploadErrorFor(0) : failure;
    const retryable = err instanceof ApiClientError ? isRetryableStatus(err.status) : true;
    if (!retryable || attempt >= COMPLETE_RETRIES) throw err;
    await sleep(backoffDelay(attempt, deps.retryBaseMs ?? 500), signal);
  }
}

/**
 * Aviso que no debe hacer fallar el envío (p. ej. "el video no llegará"), con tope total
 * de tiempo. `signal` permite cortarlo si la persona cancela mientras se espera.
 */
async function completeBestEffort(
  deps: SubmitReportDeps,
  mediaId: string,
  token: string,
  body: CompleteReportRequest,
  signal?: AbortSignal,
): Promise<void> {
  const { controller, unlink } = linkedController(signal);
  const timer = setTimeout(() => controller.abort(), deps.bestEffortTimeoutMs ?? BEST_EFFORT_TIMEOUT_MS);
  try {
    await completeWithRetry(deps, mediaId, token, body, controller.signal);
  } catch {
    /* el medio ya quedó con fotogramas o el servidor lo marcará al vencer */
  } finally {
    clearTimeout(timer);
    unlink();
  }
}

function shortReason(message: string): string {
  return message.length > 200 ? `${message.slice(0, 199)}…` : message;
}

/** Orquesta el envío completo de un reporte; ver `submitReport` en `upload.ts`. */
export async function runSubmitReport(
  opts: SubmitReportOptions,
  deps: SubmitReportDeps,
): Promise<SubmitReportResult> {
  const { signal, kind } = opts;
  const isVideo = kind === "video";
  let stage: UploadStage = "extracting";
  let mediaId: string | null = null;
  let framesDelivered = false;
  const fail = (err: unknown) => toSubmitError(err, stage, { kind, mediaId, framesDelivered });

  /* ── Archivos y plan ── */
  const sources: File[] = isVideo
    ? [opts.file ?? opts.files?.[0]].filter((f): f is File => !!f)
    : (opts.files && opts.files.length > 0 ? opts.files : opts.file ? [opts.file] : []).slice(
        0,
        LIMITS.MAX_FRAMES_PER_MEDIA,
      );
  if (sources.length === 0) {
    throw new SubmitReportError(isVideo ? "Elige un video para enviar." : "Elige al menos una foto para enviar.", {
      stage,
      code: "invalid",
    });
  }
  const main = sources[0];
  const wantsVideo = isVideo && opts.uploadVideo !== false;
  const tooLarge = isVideo && main.size > LIMITS.MAX_VIDEO_BYTES;
  const planVideo = wantsVideo && !tooLarge;
  const report = createProgressReporter(planVideo, opts.onProgress);

  /* ── (1) Fotogramas ── */
  let frames: LocalFrame[] = [];
  let durationS: number | null = null;
  let framesUnsupported = false;
  report("extracting", 0, stageMessage("extracting", { kind }));
  try {
    throwIfAborted(signal);
    if (isVideo) {
      try {
        const res = await deps.extractVideoFrames(main, {
          signal,
          onProgress: (f) => report("extracting", f, stageMessage("extracting", { kind })),
        });
        frames = prepareFrames(res.frames);
        durationS = res.duration_s;
        if (frames.length === 0) throw new SubmitReportError(stageFailMessage("extracting", kind), { stage, code: "empty" });
      } catch (err) {
        const code = err instanceof SubmitReportError ? err.code : deps.extractionErrorCode(err);
        if (signal?.aborted || code === "aborted" || isAbortError(err)) throw abortedError();
        // Sin fotogramas el servidor los saca del video original con ffmpeg.
        if (planVideo) {
          framesUnsupported = true;
          frames = [];
        } else if (code === "unsupported" || code === "empty") {
          const message = tooLarge
            ? `Tu navegador no pudo leer este video y pesa ${formatMb(main.size)} (máximo ${formatMb(LIMITS.MAX_VIDEO_BYTES)} para enviarlo completo). Prueba con un video más corto o envía fotos.`
            : "Tu navegador no pudo leer este video. Prueba con otro video o envía fotos.";
          throw new SubmitReportError(message, { stage, code, cause: err });
        } else {
          throw new SubmitReportError(stageFailMessage("extracting", kind), {
            stage,
            code: code ?? "failed",
            cause: err,
          });
        }
      }
    } else {
      const converted: LocalFrame[] = [];
      for (let i = 0; i < sources.length; i++) {
        throwIfAborted(signal);
        try {
          const f = await deps.imageToFrame(sources[i], signal);
          converted.push({ idx: i, t_s: 0, blob: f.blob, width: f.width, height: f.height });
        } catch (err) {
          if (signal?.aborted || deps.extractionErrorCode(err) === "aborted" || isAbortError(err)) {
            throw abortedError();
          }
          /* una foto ilegible no impide enviar las demás */
        }
        report("extracting", (i + 1) / sources.length, stageMessage("extracting", { kind }));
      }
      frames = prepareFrames(converted);
      if (frames.length === 0) {
        throw new SubmitReportError(stageFailMessage("extracting", kind), { stage, code: "empty" });
      }
    }
    report("extracting", 1, stageMessage("extracting", { kind }));
  } catch (err) {
    throw fail(err);
  }

  /* ── (2) Registro ── */
  stage = "registering";
  report(stage, 0, stageMessage(stage, { kind }));
  const created = await (async (): Promise<CreateReportResponse> => {
    try {
      throwIfAborted(signal);
      const body = buildCreateReportBody({
        kind,
        mime: guessMime(main.name, main.type, kind),
        sizeBytes: sources.reduce((acc, f) => acc + f.size, 0),
        durationS,
        position: opts.position,
        heading: opts.heading,
        capturedAt: opts.capturedAt,
        note: opts.note,
        frames,
        uploadVideo: planVideo,
        incidentCode: opts.incidentCode,
        typeHint: opts.typeHint,
        asResponder: opts.asResponder,
      });
      const res = await deps.createReport(body, signal);
      mediaId = res.media_id;
      if (!Array.isArray(res.frame_uploads) || res.frame_uploads.length !== frames.length) {
        throw new SubmitReportError("Respuesta inesperada del servidor. Intenta de nuevo.", {
          stage,
          code: "internal",
          mediaId,
        });
      }
      return res;
    } catch (err) {
      throw fail(err);
    }
  })();
  report(stage, 1, stageMessage(stage, { kind }));
  const token = created.upload_token;
  const createdMediaId = created.media_id;
  const videoTarget = planVideo ? created.video_upload : null;

  if (frames.length === 0 && !videoTarget) {
    await completeBestEffort(
      deps,
      createdMediaId,
      token,
      { part: "video", ok: false, error: "El servidor no habilitó la subida del video." },
      signal,
    );
    throw new SubmitReportError("No pudimos preparar el envío del video. Intenta de nuevo.", {
      stage,
      code: "internal",
      mediaId,
    });
  }

  /* ── (3) Subida de fotogramas ── */
  if (frames.length > 0) {
    stage = "uploading_frames";
    report(stage, 0, stageMessage(stage, { kind }));
    const { controller, unlink } = linkedController(signal);
    let sent = 0;
    try {
      await mapWithConcurrency(frames, FRAME_CONCURRENCY, async (frame, i) => {
        try {
          await deps.putToTarget(created.frame_uploads[i], frame.blob, {
            signal: controller.signal,
            retries: FRAME_RETRIES,
            idleTimeoutMs: FRAME_IDLE_TIMEOUT_MS,
            retryBaseMs: deps.retryBaseMs,
          });
        } catch (err) {
          controller.abort(); // corta las demás subidas en curso
          throw err;
        }
        sent++;
        report("uploading_frames", sent / frames.length, stageMessage("uploading_frames", { kind }));
      });
    } catch (err) {
      throw fail(signal?.aborted ? abortedError() : err);
    } finally {
      unlink();
    }
  }

  /* ── (4) Aviso: fotogramas listos → empieza el análisis ── */
  stage = "analyzing_started";
  try {
    await completeWithRetry(deps, createdMediaId, token, { part: "frames", ok: frames.length > 0 }, signal);
  } catch (err) {
    throw fail(err);
  }
  framesDelivered = frames.length > 0;
  report(stage, 1, stageMessage(stage, { kind, framesSent: frames.length }));
  const info: FramesUploadedInfo = {
    mediaId: createdMediaId,
    incidentCode: created.incident_code,
    createdIncident: created.created_incident,
    framesSent: frames.length,
  };
  if (framesDelivered && opts.onFramesUploaded) {
    try {
      opts.onFramesUploaded(info);
    } catch {
      /* la UI no debe poder romper el envío */
    }
  }

  /* ── (5) y (6) Video original ── */
  let video: VideoOutcome = "none";
  let videoError: string | undefined;
  if (isVideo && wantsVideo) {
    if (tooLarge) {
      // Se registró con upload_video false: el servidor ya sabe que no hay video y
      // rechazaría (400) un aviso "video", así que no se envía.
      video = "skipped_too_large";
      videoError = `El video pesa ${formatMb(main.size)} y supera el máximo de ${formatMb(LIMITS.MAX_VIDEO_BYTES)}; se enviaron solo las imágenes.`;
    } else if (!videoTarget) {
      video = "failed";
      videoError = "El servidor no habilitó la subida del video; se enviaron solo las imágenes.";
      await completeBestEffort(deps, createdMediaId, token, { part: "video", ok: false, error: videoError }, signal);
    } else {
      stage = "uploading_video";
      const message = stageMessage(stage, { kind, framesSent: frames.length });
      report(stage, 0, message);
      let uploaded = false;
      try {
        await deps.putToTarget(videoTarget, main, {
          signal,
          retries: VIDEO_RETRIES,
          idleTimeoutMs: VIDEO_IDLE_TIMEOUT_MS,
          retryBaseMs: deps.retryBaseMs,
          onProgress: (f) => report("uploading_video", f, message),
        });
        uploaded = true;
        await completeWithRetry(deps, createdMediaId, token, { part: "video", ok: true }, signal);
        video = "uploaded";
      } catch (err) {
        if (signal?.aborted || isAbortError(err)) {
          // Aviso sin esperar: quien cancela no debe quedar bloqueado por la red.
          // Si el video ya había subido entero, se confirma en vez de darlo por perdido.
          void completeBestEffort(
            deps,
            createdMediaId,
            token,
            uploaded
              ? { part: "video", ok: true }
              : { part: "video", ok: false, error: "La persona canceló la subida del video." },
          );
          throw fail(abortedError());
        }
        const reason = uploaded
          ? "El video subió, pero no pudimos confirmarlo."
          : shortReason(err instanceof Error && err.message ? err.message : stageFailMessage(stage, kind));
        if (!uploaded) {
          await completeBestEffort(deps, createdMediaId, token, { part: "video", ok: false, error: reason }, signal);
        }
        if (signal?.aborted) throw fail(abortedError());
        if (frames.length === 0) throw fail(err);
        video = "failed";
        videoError = reason;
      }
    }
  }

  stage = "done";
  report(stage, 1, stageMessage(stage, { kind }));
  const result: SubmitReportResult = {
    mediaId: createdMediaId,
    incidentCode: created.incident_code,
    createdIncident: created.created_incident,
    framesSent: frames.length,
    framesUnsupported,
    video,
  };
  if (videoError !== undefined) result.videoError = videoError;
  return result;
}
