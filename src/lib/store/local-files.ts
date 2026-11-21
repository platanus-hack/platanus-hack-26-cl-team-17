/**
 * Almacenamiento de archivos del modo local: todo vive bajo <dataDir>/files
 * con las mismas rutas relativas que usa el bucket de Cloud Storage.
 *
 * El navegador sube con un PUT firmado a /api/local-upload/<ruta> y lee por
 * /api/files/<ruta>; ambas rutas usan los helpers de este módulo.
 * Solo servidor (usa node:fs).
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { config } from "../config";
import type { UploadTarget } from "../contract";
import { hmacHex, safeEqual } from "../ids";
import { StoreNotFoundError, type FileStorage } from "./types";

/** Vigencia del enlace firmado de subida. */
export const LOCAL_UPLOAD_TTL_S = 15 * 60;

const READ_CHUNK_BYTES = 256 * 1024;
const MAX_PATH_CHARS = 512;
const MAX_PATH_SEGMENTS = 12;
/** Un segmento no puede partir con punto (descarta ".", ".." y ocultos) ni traer separadores. */
const SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** Lista blanca: solo estas extensiones se sirven con su tipo real. */
const CONTENT_TYPES = new Map<string, string>([
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["png", "image/png"],
  ["webp", "image/webp"],
  ["svg", "image/svg+xml"],
  ["mp4", "video/mp4"],
  ["mov", "video/quicktime"],
  ["webm", "video/webm"],
  ["3gp", "video/3gpp"],
]);

const UPLOAD_FRAME_EXTENSIONS = new Set(["jpg", "jpeg"]);
const UPLOAD_VIDEO_EXTENSIONS = new Set(["mp4", "mov", "webm", "3gp"]);

export class LocalPathError extends Error {
  constructor(storagePath: string) {
    super(`Ruta de archivo inválida: ${JSON.stringify(String(storagePath).slice(0, 80))}`);
    this.name = "LocalPathError";
  }
}

export type LocalUploadFailure = "too_large" | "empty" | "bad_type" | "incomplete" | "aborted";

export class LocalUploadError extends Error {
  constructor(
    public reason: LocalUploadFailure,
    message: string,
  ) {
    super(message);
    this.name = "LocalUploadError";
  }
}

function extensionOf(storagePath: string): string {
  const name = storagePath.slice(storagePath.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** Content-Type según la lista blanca de extensiones; null si la extensión no está permitida. */
export function contentTypeForPath(storagePath: string): string | null {
  return CONTENT_TYPES.get(extensionOf(storagePath)) ?? null;
}

/** Qué puede subir el navegador por PUT: fotogramas JPEG y el video original. */
export function uploadKindForPath(storagePath: string): "frame" | "video" | null {
  const ext = extensionOf(storagePath);
  if (UPLOAD_FRAME_EXTENSIONS.has(ext)) return "frame";
  if (UPLOAD_VIDEO_EXTENSIONS.has(ext)) return "video";
  return null;
}

/**
 * true si la ruta es relativa, sin traversal y solo con caracteres seguros.
 * Vale para ambos modos (también se usa antes de pedir una URL firmada a Cloud Storage).
 */
export function isSafeStoragePath(storagePath: unknown): storagePath is string {
  if (typeof storagePath !== "string") return false;
  if (storagePath.length === 0 || storagePath.length > MAX_PATH_CHARS) return false;
  const segments = storagePath.split("/");
  if (segments.length > MAX_PATH_SEGMENTS) return false;
  return segments.every((s) => SEGMENT_RE.test(s));
}

export function localFilesRoot(): string {
  return path.resolve(config.localDataDir, "files");
}

/**
 * Ruta absoluta del archivo dentro de <dataDir>/files.
 * Lanza LocalPathError ante rutas absolutas, "..", separadores extraños o
 * cualquier cosa que termine fuera de la carpeta de archivos.
 */
export function resolveLocalPath(storagePath: string): string {
  if (!isSafeStoragePath(storagePath)) throw new LocalPathError(storagePath);
  const root = localFilesRoot();
  const abs = path.resolve(root, ...storagePath.split("/"));
  // Segunda barrera: aunque cambie la validación de arriba, nunca se sale de la raíz.
  const rel = path.relative(root, abs);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new LocalPathError(storagePath);
  }
  return abs;
}

const MAX_CONTENT_TYPE_CHARS = 128;

/**
 * Forma canónica del Content-Type que se firma y se compara. Igual que la URL
 * firmada V4 de Cloud Storage, el PUT debe traer el mismo tipo que se firmó;
 * solo se toleran mayúsculas y espacios en los extremos. Sin cabecera = "".
 */
export function normalizeUploadContentType(contentType: string | null | undefined): string {
  return (contentType ?? "").trim().toLowerCase();
}

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/** Firma HMAC (hex) que autoriza un PUT a `storagePath` con `contentType` hasta `expEpochS` (segundos Unix). */
export function signLocalUpload(storagePath: string, expEpochS: number, contentType: string): string {
  return hmacHex(
    config.fileSecret,
    `vigia:local-upload:v2\n${storagePath}\n${expEpochS}\n${normalizeUploadContentType(contentType)}`,
  );
}

/** Valida firma, vigencia y que el Content-Type recibido sea el firmado. */
export function verifyLocalUpload(
  storagePath: string,
  expEpochS: number,
  sig: string,
  contentType: string | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (typeof storagePath !== "string" || typeof sig !== "string") return false;
  if (!Number.isSafeInteger(expEpochS) || expEpochS <= 0) return false;
  if (expEpochS * 1000 < nowMs) return false;
  return safeEqual(sig, signLocalUpload(storagePath, expEpochS, contentType ?? ""));
}

/** Rango de bytes con ambos extremos incluidos. */
export interface ByteRange {
  start: number;
  end: number;
}

/**
 * Interpreta el header Range para un archivo de `size` bytes.
 * null = ignorar y responder completo (sin header, mal formado o multi-rango);
 * "unsatisfiable" = responder 416.
 */
export function parseByteRange(
  header: string | null | undefined,
  size: number,
): ByteRange | "unsatisfiable" | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, rawStart, rawEnd] = m;
  if (rawStart === "" && rawEnd === "") return null;
  if (rawStart === "") {
    // "bytes=-N": los últimos N bytes.
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix)) return null;
    if (suffix === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(rawStart);
  if (!Number.isSafeInteger(start)) return null;
  if (start >= size) return "unsatisfiable";
  if (rawEnd === "") return { start, end: size - 1 };
  const end = Number(rawEnd);
  if (!Number.isSafeInteger(end) || end < start) return null;
  return { start, end: Math.min(end, size - 1) };
}

export interface LocalFile {
  stat: { size: number; mtimeMs: number };
  contentType: string;
  /** Flujo del archivo completo o de un rango (extremos incluidos). Se abre recién al leer. */
  stream(range?: ByteRange): ReadableStream<Uint8Array>;
}

function errnoCode(err: unknown): string {
  return typeof err === "object" && err !== null && "code" in err
    ? String((err as { code: unknown }).code)
    : "";
}

function readRange(abs: string, start: number, end: number): ReadableStream<Uint8Array> {
  let handle: fsp.FileHandle | null = null;
  let pos = start;
  let finished = false;

  const finish = async () => {
    finished = true;
    const h = handle;
    handle = null;
    if (h) await h.close().catch(() => undefined);
  };

  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (finished) return;
        try {
          if (!handle) {
            const opened = await fsp.open(abs, "r");
            // Si cancelaron mientras se abría (seek del <video>), no dejar el descriptor abierto.
            if (finished) {
              await opened.close().catch(() => undefined);
              return;
            }
            handle = opened;
          }
          const remaining = end - pos + 1;
          if (remaining <= 0) {
            await finish();
            controller.close();
            return;
          }
          const buf = new Uint8Array(Math.min(READ_CHUNK_BYTES, remaining));
          const { bytesRead } = await handle.read(buf, 0, buf.length, pos);
          if (finished) return;
          if (bytesRead === 0) {
            await finish();
            controller.close();
            return;
          }
          pos += bytesRead;
          controller.enqueue(bytesRead === buf.length ? buf : buf.subarray(0, bytesRead));
          if (pos > end) {
            await finish();
            controller.close();
          }
        } catch (err) {
          const wasFinished = finished;
          await finish();
          if (!wasFinished) controller.error(err);
        }
      },
      async cancel() {
        await finish();
      },
    },
    // Sin lectura anticipada: el archivo solo se abre cuando alguien consume el flujo.
    { highWaterMark: 0 },
  );
}

/** Abre un archivo local para transmitirlo; null si no existe o la ruta no es válida. */
export async function openLocal(storagePath: string): Promise<LocalFile | null> {
  if (!isSafeStoragePath(storagePath)) return null;
  const abs = resolveLocalPath(storagePath);
  let size: number;
  let mtimeMs: number;
  try {
    const st = await fsp.stat(abs);
    if (!st.isFile()) return null;
    size = st.size;
    mtimeMs = st.mtimeMs;
  } catch (err) {
    const code = errnoCode(err);
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw err;
  }
  return {
    stat: { size, mtimeMs },
    contentType: contentTypeForPath(storagePath) ?? "application/octet-stream",
    stream: (range) => readRange(abs, range?.start ?? 0, range?.end ?? size - 1),
  };
}

let tmpCounter = 0;
function tmpPathFor(abs: string): string {
  tmpCounter += 1;
  return `${abs}.${process.pid}.${Date.now().toString(36)}.${tmpCounter}.part`;
}

async function writeAll(handle: fsp.FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
    offset += bytesWritten;
  }
}

export interface WriteLocalStreamOptions {
  maxBytes: number;
  /** Content-Length declarado por el cliente; si viene, lo recibido debe calzar exacto. */
  expectedBytes?: number | null;
  /** Exige la firma de un JPEG (FF D8 FF) al inicio del contenido. */
  requireJpeg?: boolean;
}

/**
 * Escribe un cuerpo de solicitud a disco por streaming (sin cargarlo en memoria),
 * a un archivo temporal que solo reemplaza al definitivo si llegó completo y válido.
 * Lanza LocalUploadError si excede el tamaño, llega vacío, incompleto o no es del tipo esperado.
 */
export async function writeLocalStream(
  storagePath: string,
  body: ReadableStream<Uint8Array>,
  opts: WriteLocalStreamOptions,
): Promise<{ size: number }> {
  const abs = resolveLocalPath(storagePath);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  const tmp = tmpPathFor(abs);
  const handle = await fsp.open(tmp, "w");
  const reader = body.getReader();
  const head: number[] = [];
  let total = 0;
  try {
    for (;;) {
      let step: ReadableStreamReadResult<Uint8Array>;
      try {
        step = await reader.read();
      } catch {
        throw new LocalUploadError("aborted", "La subida se interrumpió antes de terminar.");
      }
      if (step.done) break;
      const chunk = step.value;
      if (!chunk || chunk.byteLength === 0) continue;
      total += chunk.byteLength;
      if (total > opts.maxBytes) {
        throw new LocalUploadError("too_large", "El archivo supera el tamaño permitido.");
      }
      if (opts.requireJpeg && head.length < 3) {
        for (let i = 0; i < chunk.byteLength && head.length < 3; i++) head.push(chunk[i]);
        if (head.length === 3 && !(head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff)) {
          throw new LocalUploadError("bad_type", "El fotograma no es una imagen JPEG.");
        }
      }
      await writeAll(handle, chunk);
    }
    if (total === 0) throw new LocalUploadError("empty", "La subida llegó vacía.");
    if (opts.requireJpeg && head.length < 3) {
      throw new LocalUploadError("bad_type", "El fotograma no es una imagen JPEG.");
    }
    if (typeof opts.expectedBytes === "number" && opts.expectedBytes !== total) {
      // Un video truncado guardado como si estuviera completo sería evidencia engañosa.
      throw new LocalUploadError(
        "incomplete",
        `La subida llegó incompleta (${total} de ${opts.expectedBytes} bytes).`,
      );
    }
    await handle.close();
    await fsp.rename(tmp, abs);
    return { size: total };
  } catch (err) {
    await reader.cancel().catch(() => undefined);
    await handle.close().catch(() => undefined);
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

export function createLocalFiles(): FileStorage {
  return {
    kind: "local",

    async createUploadTarget(storagePath, contentType): Promise<UploadTarget> {
      resolveLocalPath(storagePath);
      // Va en una cabecera HTTP: sin caracteres de control ni largos absurdos.
      if (
        typeof contentType !== "string" ||
        contentType.length > MAX_CONTENT_TYPE_CHARS ||
        hasControlChars(contentType)
      ) {
        throw new Error(`Tipo de contenido inválido: ${JSON.stringify(String(contentType).slice(0, 60))}`);
      }
      const exp = Math.floor(Date.now() / 1000) + LOCAL_UPLOAD_TTL_S;
      const sig = signLocalUpload(storagePath, exp, contentType);
      const encoded = storagePath.split("/").map(encodeURIComponent).join("/");
      return {
        method: "PUT",
        url: `/api/local-upload/${encoded}?exp=${exp}&sig=${sig}`,
        headers: { "content-type": contentType },
      };
    },

    // En local el tipo se deduce de la extensión al leer; no se guarda aparte.
    async upload(storagePath, bytes) {
      const abs = resolveLocalPath(storagePath);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      const tmp = tmpPathFor(abs);
      try {
        await fsp.writeFile(tmp, bytes);
        await fsp.rename(tmp, abs);
      } catch (err) {
        await fsp.rm(tmp, { force: true }).catch(() => undefined);
        throw err;
      }
    },

    async download(storagePath) {
      const abs = resolveLocalPath(storagePath);
      try {
        const buf = await fsp.readFile(abs);
        return {
          bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
          contentType: contentTypeForPath(storagePath) ?? "application/octet-stream",
        };
      } catch (err) {
        const code = errnoCode(err);
        if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") {
          throw new StoreNotFoundError(`archivo ${storagePath}`);
        }
        throw err;
      }
    },

    async exists(storagePath) {
      if (!isSafeStoragePath(storagePath)) return false;
      try {
        return (await fsp.stat(resolveLocalPath(storagePath))).isFile();
      } catch {
        return false;
      }
    },

    async getSignedReadUrl() {
      return null;
    },

    // Igual que un bucket: borra objetos por ruta exacta; lo que no existe se ignora.
    async remove(paths) {
      await Promise.all(
        paths.map(async (p) => {
          try {
            await fsp.unlink(resolveLocalPath(p));
          } catch (err) {
            const code = errnoCode(err);
            if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") return;
            throw err;
          }
        }),
      );
    },
  };
}
