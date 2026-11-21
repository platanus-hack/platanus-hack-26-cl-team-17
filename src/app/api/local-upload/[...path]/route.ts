/**
 * PUT /api/local-upload/<storage_path>?exp=&sig=
 *
 * Destino de subida del modo local (equivale a la URL firmada de Cloud Storage).
 * El enlace lo emite el servidor con `createUploadTarget`; aquí se valida la firma
 * (ruta + vencimiento + Content-Type), el tipo según la extensión y el tamaño
 * (LIMITS), y el cuerpo se escribe a disco por streaming.
 */
import { isGcsConfigured } from "@/lib/config";
import { LIMITS } from "@/lib/domain";
import { errors, ok, route } from "@/lib/http";
import {
  isSafeStoragePath,
  LocalUploadError,
  normalizeUploadContentType,
  uploadKindForPath,
  verifyLocalUpload,
  writeLocalStream,
} from "@/lib/store/local-files";
import { storagePaths } from "@/lib/store/types";

export const runtime = "nodejs";

function declaredLength(req: Request): number | null {
  const raw = req.headers.get("content-length");
  if (raw === null || !/^\d+$/.test(raw.trim())) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

export const PUT = route<{ path: string[] }>(async (req, ctx) => {
  // Con Cloud Storage el navegador sube directo al bucket con URL firmada; esta ruta no existe.
  if (isGcsConfigured()) throw errors.notFound();

  const { path: segments } = await ctx.params;
  const storagePath = segments.join("/");
  if (!isSafeStoragePath(storagePath) || !storagePaths.incidentIdOf(storagePath)) {
    throw errors.invalid("La ruta del archivo no es válida.");
  }

  const kind = uploadKindForPath(storagePath);
  if (!kind) throw errors.invalid("Este tipo de archivo no está permitido.");

  const rawContentType = req.headers.get("content-type");
  const query = new URL(req.url).searchParams;
  const rawExp = query.get("exp") ?? "";
  const exp = /^\d{1,12}$/.test(rawExp) ? Number(rawExp) : Number.NaN;
  // La firma cubre ruta, vencimiento y Content-Type (como la URL firmada V4 de Cloud Storage).
  if (!verifyLocalUpload(storagePath, exp, query.get("sig") ?? "", rawContentType)) {
    throw errors.forbidden("El enlace de subida no es válido o ya venció. Vuelve a intentar el envío.");
  }

  const mediaType = normalizeUploadContentType(rawContentType).split(";")[0].trim();
  const typeOk =
    kind === "frame"
      ? mediaType === "image/jpeg" || mediaType === "image/jpg"
      : // Algunos teléfonos no informan el tipo del video o lo mandan como binario genérico.
        mediaType === "" || mediaType === "application/octet-stream" || mediaType.startsWith("video/");
  if (!typeOk) throw errors.invalid("El tipo de contenido no corresponde al archivo.");

  const maxBytes = kind === "frame" ? LIMITS.MAX_FRAME_BYTES : LIMITS.MAX_VIDEO_BYTES;
  const declared = declaredLength(req);
  if (declared !== null && declared > maxBytes) throw errors.tooLarge();
  if (!req.body) throw errors.invalid("La subida llegó vacía.");

  try {
    await writeLocalStream(storagePath, req.body, {
      maxBytes,
      expectedBytes: declared,
      requireJpeg: kind === "frame",
    });
  } catch (err) {
    if (err instanceof LocalUploadError) {
      throw err.reason === "too_large" ? errors.tooLarge() : errors.invalid(err.message);
    }
    throw err;
  }
  return ok({ ok: true });
});
