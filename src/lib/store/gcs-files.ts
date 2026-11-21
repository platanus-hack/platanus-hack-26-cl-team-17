/**
 * Almacenamiento de archivos en Google Cloud Storage (producción).
 *
 * El bucket es privado: el navegador sube directo con una URL firmada V4 (PUT)
 * y lee por /api/files, que redirige a una URL firmada V4 de lectura.
 *
 * Firma: con una cuenta de servicio con llave privada se firma localmente; en
 * Cloud Run (sin llave) la biblioteca firma con IAM `signBlob`, lo que exige
 * `roles/iam.serviceAccountTokenCreator` de la cuenta de servicio sobre sí misma.
 * Solo servidor.
 */
import {
  Storage,
  type Bucket,
  type GetSignedUrlConfig,
  type SaveOptions,
  type StorageOptions,
} from "@google-cloud/storage";
import { config } from "../config";
import type { UploadTarget } from "../contract";
import { isSafeStoragePath } from "./local-files";
import { StoreNotFoundError, type FileStorage } from "./types";

/** Vigencia de la URL firmada de subida (igual que el modo local). */
export const GCS_UPLOAD_TTL_S = 15 * 60;
/** Máximo que admite la firma V4 de Cloud Storage: 7 días. */
export const GCS_MAX_SIGNED_TTL_S = 7 * 24 * 60 * 60;
/** La evidencia es privada: ningún caché compartido (CDN, proxy) debe guardarla. */
export const GCS_OBJECT_CACHE_CONTROL = "private, max-age=3600";

const MAX_CONTENT_TYPE_CHARS = 128;
/** tipo/subtipo con parámetros opcionales; sin saltos de línea ni caracteres de control. */
const CONTENT_TYPE_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(\s*;\s*[a-z0-9_.-]+=[a-z0-9_."-]+)*$/i;

export class GcsPathError extends Error {
  constructor(storagePath: unknown) {
    super(`Ruta de archivo inválida: ${JSON.stringify(String(storagePath).slice(0, 80))}`);
    this.name = "GcsPathError";
  }
}

/**
 * Devuelve la ruta si es válida para el bucket (relativa, sin "..", sin "/" inicial,
 * no vacía, solo caracteres seguros); si no, lanza GcsPathError. Se valida antes de
 * cualquier llamada a Cloud Storage.
 */
export function assertGcsPath(storagePath: unknown): string {
  if (!isSafeStoragePath(storagePath)) throw new GcsPathError(storagePath);
  return storagePath;
}

/** Content-Type válido para firmar: el navegador debe enviar exactamente el mismo. */
export function assertContentType(contentType: unknown): string {
  if (
    typeof contentType !== "string" ||
    contentType.length === 0 ||
    contentType.length > MAX_CONTENT_TYPE_CHARS ||
    !CONTENT_TYPE_RE.test(contentType)
  ) {
    throw new Error(`Tipo de contenido inválido: ${JSON.stringify(String(contentType).slice(0, 60))}`);
  }
  return contentType;
}

/** Acota la vigencia pedida a [1 s, 7 días] (límite de la firma V4). */
export function clampSignedTtl(ttlSeconds: number): number {
  if (!Number.isFinite(ttlSeconds)) throw new Error("Vigencia de URL firmada inválida.");
  return Math.min(GCS_MAX_SIGNED_TTL_S, Math.max(1, Math.floor(ttlSeconds)));
}

/** Opciones de `file.getSignedUrl` para un PUT del navegador. La cabecera Content-Type queda firmada. */
export function buildUploadUrlConfig(contentType: string, nowMs: number = Date.now()): GetSignedUrlConfig {
  return {
    version: "v4",
    action: "write",
    expires: nowMs + GCS_UPLOAD_TTL_S * 1000,
    contentType: assertContentType(contentType),
  };
}

/** Opciones de `file.getSignedUrl` para leer (GET/HEAD) durante `ttlSeconds`. */
export function buildReadUrlConfig(ttlSeconds: number, nowMs: number = Date.now()): GetSignedUrlConfig {
  return {
    version: "v4",
    action: "read",
    expires: nowMs + clampSignedTtl(ttlSeconds) * 1000,
  };
}

/** Destino que consume el cliente: debe mandar exactamente estas cabeceras. */
export function toUploadTarget(url: string, contentType: string): UploadTarget {
  return { method: "PUT", url, headers: { "content-type": contentType } };
}

/**
 * Opciones de `file.save` para subidas del servidor. Sin subida reanudable: los
 * archivos son chicos (cuadros, datos de demo) y así se hace una sola petición.
 */
export function buildSaveOptions(contentType: string): SaveOptions {
  return {
    contentType: assertContentType(contentType),
    resumable: false,
    metadata: { cacheControl: GCS_OBJECT_CACHE_CONTROL },
  };
}

/** Opciones del cliente de Storage; el proyecto solo se fija si está configurado. */
export function buildStorageOptions(projectId: string = config.gcpProject): StorageOptions {
  return projectId ? { projectId } : {};
}

/** true si el error de la biblioteca corresponde a un 404 (gaxios usa `status`; otras rutas, `code`). */
export function isNotFoundError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { status?: unknown; code?: unknown; response?: { status?: unknown } | null };
  return (
    e.status === 404 ||
    e.code === 404 ||
    e.code === "404" ||
    (typeof e.response === "object" && e.response !== null && e.response.status === 404)
  );
}

export interface GcsFilesOptions {
  /** Cliente ya construido (pruebas o credenciales explícitas). Si no, se crea al primer uso. */
  storage?: Storage;
  /** Nombre del bucket; por defecto `GCS_BUCKET`. */
  bucket?: string;
}

export function createGcsFiles(opts: GcsFilesOptions = {}): FileStorage {
  let bucketRef: Bucket | null = null;

  // Diferido: importar el módulo no debe exigir credenciales ni configuración.
  function bucket(): Bucket {
    if (bucketRef) return bucketRef;
    const name = (opts.bucket ?? config.gcsBucket).trim();
    if (!name) throw new Error("Falta GCS_BUCKET: no hay bucket de Cloud Storage configurado.");
    const storage = opts.storage ?? new Storage(buildStorageOptions());
    bucketRef = storage.bucket(name);
    return bucketRef;
  }

  const file = (storagePath: string) => bucket().file(assertGcsPath(storagePath));

  return {
    kind: "gcs",

    async createUploadTarget(storagePath, contentType): Promise<UploadTarget> {
      const cfg = buildUploadUrlConfig(contentType);
      const [url] = await file(storagePath).getSignedUrl(cfg);
      return toUploadTarget(url, contentType);
    },

    async upload(storagePath, bytes, contentType) {
      const options = buildSaveOptions(contentType);
      await file(storagePath).save(bytes, options);
    },

    async download(storagePath) {
      const f = file(storagePath);
      try {
        const [[buf], [metadata]] = await Promise.all([f.download(), f.getMetadata()]);
        return {
          bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
          contentType: metadata.contentType || "application/octet-stream",
        };
      } catch (err) {
        if (isNotFoundError(err)) throw new StoreNotFoundError(`archivo ${storagePath}`);
        throw err;
      }
    },

    async exists(storagePath) {
      if (!isSafeStoragePath(storagePath)) return false;
      const [found] = await file(storagePath).exists();
      return found;
    },

    async getSignedReadUrl(storagePath, ttlSeconds) {
      const cfg = buildReadUrlConfig(ttlSeconds);
      const [url] = await file(storagePath).getSignedUrl(cfg);
      return url;
    },

    // Igual que el modo local: lo que no existe se ignora; rutas inválidas lanzan antes de llamar a GCS.
    async remove(paths) {
      const files = paths.map((p) => file(p));
      await Promise.all(files.map((f) => f.delete({ ignoreNotFound: true })));
    },
  };
}
