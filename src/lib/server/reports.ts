/**
 * Flujo de vecinos (servidor): incidentes públicos cercanos, resolución del
 * incidente al que se adjunta un reporte y cierre de subidas.
 *
 * No depende de next/* ni de la sesión: las rutas resuelven al personal y
 * disparan `processMedia` con `after()`; aquí solo hay lógica de datos (probada
 * con el store local).
 */
import type {
  CompleteReportRequest,
  CreateReportResponse,
  PublicIncident,
  StaffPublic,
  UploadTarget,
} from "@/lib/contract";
import {
  LIMITS,
  type CreateReportInput,
  type Incident,
  type IncidentType,
  type Media,
} from "@/lib/domain";
import { distanceM, isValidLatLng, roundCoord } from "@/lib/geo";
import { errors } from "@/lib/http";
import { newToken, normalizeIncidentCode, sha256Hex } from "@/lib/ids";
import { storagePaths, type FileStorage, type Store } from "@/lib/store/types";

/** Las rutas pasan `{ store: getStore(), files: getFiles() }` de "@/lib/store". */
export interface ReportDeps {
  store: Store;
  files: FileStorage;
}

/** Estados en los que una emergencia sigue en terreno y puede recibir material. */
const OPEN_STATUSES: Incident["status"][] = ["active", "controlled"];

const TYPE_TEXT: Record<IncidentType, string> = {
  structure_fire: "incendio en casa o edificio",
  vehicle_fire: "vehículo en llamas",
  wildland_fire: "incendio de pastizal o forestal",
  vehicle_collision: "choque o accidente de tránsito",
  hazmat: "materiales peligrosos",
  rescue: "rescate",
  other: "otra emergencia",
  unknown: "tipo por confirmar",
};

export function toPublicIncident(inc: Incident, from?: { lat: number; lng: number } | null): PublicIncident {
  return {
    code: inc.code,
    type: inc.type,
    title: inc.title,
    address: inc.address,
    lat: roundCoord(inc.lat),
    lng: roundCoord(inc.lng),
    distance_m: from ? Math.round(distanceM(from, inc)) : null,
    created_at: inc.created_at,
  };
}

/* ───────────── Consultas públicas ───────────── */

export async function listNearbyPublic(
  lat: number | null,
  lng: number | null,
  d: ReportDeps,
): Promise<PublicIncident[]> {
  if (!isValidLatLng(lat, lng)) return [];
  const from = { lat: lat as number, lng: lng as number };
  const { store } = d;
  const incidents = await store.listIncidents({ status: ["active"] });
  return incidents
    .map((inc) => ({ inc, dist: distanceM(from, inc) }))
    .filter((x) => x.dist <= LIMITS.NEARBY_RADIUS_M)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 5)
    .map((x) => toPublicIncident(x.inc, from));
}

/** Busca por código para vecinos. 404 si no existe; 409 si ya se cerró. */
export async function findOpenIncidentByCode(rawCode: string, d: ReportDeps): Promise<Incident> {
  const code = normalizeIncidentCode(rawCode);
  if (code.length < 5) throw errors.invalid("Ese código no es válido. Tiene la forma VG-XXXX.");
  const { store } = d;
  const inc = await store.getIncidentByCode(code);
  if (!inc) throw errors.notFound("No encontramos esa emergencia. Revisa el código.");
  if (inc.status === "closed") throw errors.conflict("Esta emergencia ya fue cerrada");
  return inc;
}

/* ───────────── Crear reporte ───────────── */

/** Extensión del video original según su MIME. */
export function videoExtForMime(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes("quicktime") || m.includes("mov")) return "mov";
  if (m.includes("webm")) return "webm";
  if (m.includes("3gpp") || m.includes("3gp")) return "3gp";
  return "mp4";
}

/** Valida tipo, tamaño y fotogramas antes de tocar el store. */
export function validateReportInput(input: CreateReportInput): void {
  const mime = input.mime.toLowerCase();
  if (input.kind === "video" && !mime.startsWith("video/")) {
    throw errors.invalid("El archivo no parece ser un video.");
  }
  if (input.kind === "photo" && !mime.startsWith("image/")) {
    throw errors.invalid("El archivo no parece ser una foto.");
  }
  if (input.kind === "photo" && input.upload_video) {
    throw errors.invalid("Las fotos no llevan video original.");
  }
  if (input.upload_video && input.size_bytes > LIMITS.MAX_VIDEO_BYTES) {
    throw errors.tooLarge("El video es demasiado grande. Graba uno más corto (10 a 30 segundos).");
  }
  if (input.frames.length === 0 && !input.upload_video) {
    throw errors.invalid("No hay imágenes para enviar.");
  }
  const seen = new Set<number>();
  for (const f of input.frames) {
    if (seen.has(f.idx)) throw errors.invalid("Hay fotogramas repetidos.");
    seen.add(f.idx);
  }
}

export interface ResolvedIncident {
  incident: Incident;
  created: boolean;
}

/**
 * (1) código → ese incidente; (2) sin código → incidente en terreno más cercano dentro
 * de AUTO_ATTACH_RADIUS_M; (3) si no hay, crea uno sin verificar en la ubicación del vecino.
 */
export async function resolveReportIncident(
  input: Pick<CreateReportInput, "incident_code" | "lat" | "lng" | "type_hint">,
  d: ReportDeps,
): Promise<ResolvedIncident> {
  const { store } = d;
  if (input.incident_code && input.incident_code.trim()) {
    return { incident: await findOpenIncidentByCode(input.incident_code, d), created: false };
  }
  if (!isValidLatLng(input.lat, input.lng)) {
    throw errors.invalid("Necesitamos tu ubicación o el código de la emergencia");
  }
  const from = { lat: input.lat as number, lng: input.lng as number };
  const open = await store.listIncidents({ status: OPEN_STATUSES });
  let best: { inc: Incident; dist: number } | null = null;
  for (const inc of open) {
    const dist = distanceM(from, inc);
    if (dist <= LIMITS.AUTO_ATTACH_RADIUS_M && (!best || dist < best.dist)) best = { inc, dist };
  }
  if (best) return { incident: best.inc, created: false };

  const type = input.type_hint ?? "unknown";
  const text = TYPE_TEXT[type];
  const incident = await store.createIncident({
    type,
    title: `Reporte ciudadano — ${text.charAt(0).toUpperCase()}${text.slice(1)}`,
    address: "",
    lat: from.lat,
    lng: from.lng,
    description: "Creado automáticamente a partir del reporte de un vecino. Sin verificar.",
    origin: "citizen",
    verified: false,
  });
  await store.addEvent({
    incident_id: incident.id,
    kind: "incident_created",
    severity: "warning",
    title: `Nueva emergencia reportada por un vecino — ${incident.code}`,
    detail: `Sin verificar. Tipo indicado: ${text}. Confírmala o ciérrala desde el puesto de mando.`,
  });
  return { incident, created: true };
}

/** Registra el medio, sus fotogramas y devuelve los destinos de subida. */
export async function createReport(
  input: CreateReportInput,
  opts: { staff: StaffPublic | null } & ReportDeps,
): Promise<CreateReportResponse> {
  validateReportInput(input);
  const { store, files } = opts;
  const { incident, created } = await resolveReportIncident(input, opts);

  const source: Media["source"] = input.as_responder && opts.staff ? "responder" : "citizen";
  const token = newToken();
  const media = await store.createMedia({
    incident_id: incident.id,
    source,
    kind: input.kind,
    mime: input.mime,
    size_bytes: input.size_bytes,
    duration_s: input.duration_s,
    lat: input.lat,
    lng: input.lng,
    accuracy_m: input.accuracy_m,
    heading_deg: input.heading_deg,
    captured_at: input.captured_at,
    reporter_note: input.note,
    upload_token_hash: sha256Hex(token),
    video_status: input.upload_video ? "uploading" : "none",
    status: "uploading",
  });

  const frames = [...input.frames].sort((a, b) => a.idx - b.idx);
  if (frames.length) {
    await store.addFrames(
      media.id,
      frames.map((f) => ({
        idx: f.idx,
        t_s: f.t_s,
        width: f.width,
        height: f.height,
        storage_path: storagePaths.frame(incident.id, media.id, f.idx),
        lat: null,
        lng: null,
        alt_m: null,
        heading_deg: null,
      })),
    );
  }
  // Mismo orden que `frames` de la solicitud (lo exige el contrato).
  const frame_uploads: UploadTarget[] = await Promise.all(
    input.frames.map((f) =>
      files.createUploadTarget(storagePaths.frame(incident.id, media.id, f.idx), "image/jpeg"),
    ),
  );
  const video_upload = input.upload_video
    ? await files.createUploadTarget(
        storagePaths.video(incident.id, media.id, videoExtForMime(input.mime)),
        input.mime,
      )
    : null;

  const what = input.kind === "photo" ? (frames.length > 1 ? "Nuevas fotos" : "Nueva foto") : "Nuevo video";
  await store.addEvent({
    incident_id: incident.id,
    kind: "media_received",
    severity: "notice",
    title:
      source === "responder"
        ? `${input.kind === "photo" ? "Imágenes recibidas" : "Video recibido"} por el mando — ${media.label}`
        : `${what} de vecino — ${media.label}`,
    detail: input.note ? `Nota: ${input.note}` : "",
    media_id: media.id,
  });

  return {
    media_id: media.id,
    incident_code: incident.code,
    created_incident: created,
    upload_token: token,
    frame_uploads,
    video_upload,
  };
}

/* ───────────── Cerrar subidas ───────────── */

export interface CompleteResult {
  /** true si la ruta debe llamar a `processMedia(mediaId)` con `after()`. */
  process: boolean;
}

/**
 * Idempotente. `frames` ok → el medio queda "uploaded" y se analiza; sin fotogramas
 * (o fallidos) se espera al video, que el pipeline convierte con ffmpeg.
 */
export async function completeReport(
  mediaId: string,
  token: string | null,
  body: CompleteReportRequest,
  d: ReportDeps,
): Promise<CompleteResult> {
  const { store, files } = d;
  if (!token) throw errors.unauthorized("Falta el permiso de subida.");
  const media = await store.getMedia(mediaId);
  if (!media) throw errors.notFound("No encontramos este envío.");
  if (!(await store.verifyUploadToken(mediaId, sha256Hex(token)))) {
    throw errors.unauthorized("El permiso de subida no es válido.");
  }
  const pending = media.status === "uploading";

  if (body.part === "frames") {
    if (!body.ok || media.frames.length === 0) {
      // Si el video ya había llegado, no hay nada más que esperar.
      if (pending && media.video_status === "uploaded") {
        await store.updateMedia(mediaId, { status: "uploaded" });
        return { process: true };
      }
      return { process: false };
    }
    if (!pending) return { process: false };
    const present = await Promise.all(media.frames.map((f) => files.exists(f.storage_path)));
    if (!present.some(Boolean)) {
      throw errors.invalid("Las imágenes no alcanzaron a llegar. Intenta enviarlas de nuevo.");
    }
    await store.updateMedia(mediaId, { status: "uploaded" });
    return { process: true };
  }

  // part === "video"
  if (media.video_status === "none") throw errors.invalid("Este envío no incluye video.");
  if (!body.ok) {
    if (media.video_status === "uploaded") return { process: false };
    await store.updateMedia(mediaId, {
      video_status: "failed",
      ...(pending && media.frames.length === 0
        ? { status: "failed" as const, error: body.error?.slice(0, 300) || "No se pudo subir el video." }
        : {}),
    });
    return { process: false };
  }
  if (media.video_status === "uploaded") return { process: false };
  const path = storagePaths.video(media.incident_id, media.id, videoExtForMime(media.mime ?? ""));
  if (!(await files.exists(path))) {
    throw errors.invalid("El video no alcanzó a llegar completo. Intenta de nuevo.");
  }
  // Si sigue pendiente, los fotogramas del navegador no llegaron (o no hubo): se analiza
  // igual y el pipeline los extrae del video con ffmpeg.
  const analyzeNow = pending;
  await store.updateMedia(mediaId, {
    video_status: "uploaded",
    video_path: path,
    ...(analyzeNow ? { status: "uploaded" as const } : {}),
  });
  return { process: analyzeNow };
}
