/**
 * GET /api/files/<storage_path>[?k=<share_key>]
 *
 * URL estable para leer evidencia del bucket privado (fotogramas, videos, pósters).
 *  - Cloud Storage: redirige (302) a una URL firmada V4 de corta duración.
 *  - Local: transmite el archivo desde disco con soporte de Range (seek del <video>).
 * Autoriza al personal con sesión, o a quien traiga la clave de solo lectura del
 * incidente dueño del archivo (enlace de briefing en ruta).
 */
import { getStaff } from "@/lib/auth";
import { errors, route, type RouteCtx } from "@/lib/http";
import { safeEqual } from "@/lib/ids";
import { getFiles, getStore } from "@/lib/store";
import {
  contentTypeForPath,
  isSafeStoragePath,
  openLocal,
  parseByteRange,
} from "@/lib/store/local-files";
import { storagePaths } from "@/lib/store/types";

export const runtime = "nodejs";

type Ctx = RouteCtx<{ path: string[] }>;

const SIGNED_URL_TTL_S = 3600;

/**
 * Hay pósters SVG de demo: el sandbox impide que un archivo servido ejecute nada.
 * Sin Referer, la clave `?k=` del enlace de briefing no se filtra a terceros, y
 * CORP evita que otro sitio incruste la evidencia.
 */
const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function authorize(req: Request, incidentId: string): Promise<void> {
  const key = new URL(req.url).searchParams.get("k");
  // Solo se consulta el store con un UUID bien formado (Postgres rechaza otros textos).
  if (key && UUID_RE.test(incidentId)) {
    const incident = await getStore().getIncident(incidentId.toLowerCase());
    if (incident && safeEqual(key, incident.share_key)) return;
  }
  if (await getStaff()) return;
  throw key
    ? errors.forbidden("Este enlace no da acceso al archivo.")
    : errors.unauthorized("Debes iniciar sesión para ver este archivo.");
}

async function redirectToSignedUrl(storagePath: string): Promise<Response> {
  const files = getFiles();
  let url: string | null;
  try {
    url = await files.getSignedReadUrl(storagePath, SIGNED_URL_TTL_S);
  } catch (err) {
    // Firmar un objeto inexistente falla: se distingue del resto de errores para responder 404.
    const exists = await files.exists(storagePath).catch(() => true);
    if (!exists) throw errors.notFound("Archivo no encontrado.");
    throw err;
  }
  if (!url) throw errors.notFound("Archivo no encontrado.");
  return new Response(null, {
    status: 302,
    // El navegador reutiliza la redirección mientras la URL firmada sigue vigente.
    headers: { Location: url, "Cache-Control": "private, max-age=1800" },
  });
}

async function streamLocal(req: Request, storagePath: string, withBody: boolean): Promise<Response> {
  const file = await openLocal(storagePath);
  if (!file) throw errors.notFound("Archivo no encontrado.");
  const { size, mtimeMs } = file.stat;
  const etag = `"${size.toString(16)}-${Math.floor(mtimeMs).toString(16)}"`;
  const lastModified = new Date(mtimeMs).toUTCString();
  const headers: Record<string, string> = {
    "Content-Type": file.contentType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600",
    ETag: etag,
    "Last-Modified": lastModified,
  };
  // Lo que no está en la lista blanca nunca se muestra en el navegador: solo se descarga.
  if (!contentTypeForPath(storagePath)) headers["Content-Disposition"] = "attachment";

  if (req.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }

  // If-Range: si el archivo cambió desde la descarga parcial, se manda completo.
  const ifRange = req.headers.get("if-range");
  const rangeApplies = !ifRange || ifRange === etag || ifRange === lastModified;
  const range = rangeApplies ? parseByteRange(req.headers.get("range"), size) : null;

  if (range === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: { ...headers, "Content-Range": `bytes */${size}` },
    });
  }
  if (range) {
    headers["Content-Range"] = `bytes ${range.start}-${range.end}/${size}`;
    headers["Content-Length"] = String(range.end - range.start + 1);
    return new Response(withBody ? file.stream(range) : null, { status: 206, headers });
  }
  headers["Content-Length"] = String(size);
  return new Response(withBody && size > 0 ? file.stream() : null, { status: 200, headers });
}

async function serve(req: Request, ctx: Ctx, withBody: boolean): Promise<Response> {
  const { path: segments } = await ctx.params;
  const storagePath = segments.join("/");
  const incidentId = isSafeStoragePath(storagePath) ? storagePaths.incidentIdOf(storagePath) : null;
  // Una ruta fuera de la convención no corresponde a ningún archivo servible.
  if (!incidentId) throw errors.notFound("Archivo no encontrado.");

  await authorize(req, incidentId);

  return getFiles().kind === "gcs"
    ? redirectToSignedUrl(storagePath)
    : streamLocal(req, storagePath, withBody);
}

function withSecurityHeaders(withBody: boolean) {
  const handler = route<{ path: string[] }>((req, ctx) => serve(req, ctx, withBody));
  return async (req: Request, ctx: Ctx): Promise<Response> => {
    const res = await handler(req, ctx);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.headers.set(name, value);
    return res;
  };
}

export const GET = withSecurityHeaders(true);
export const HEAD = withSecurityHeaders(false);
