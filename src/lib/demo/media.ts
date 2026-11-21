/**
 * Inserta un medio de demostración: registro, pósters SVG como fotogramas y análisis precargado.
 * Lo usan las vitrinas y el simulacro.
 */
import type { Incident, Media, MediaAnalysis } from "@/lib/domain";
import { bearingDeg, destination, distanceM, toLatLng } from "@/lib/geo";
import { storagePaths, type NewFrame } from "@/lib/store/types";
import { renderPoster } from "./posters";
import type { DemoDeps, DemoFrameSpec, DemoMediaSpec } from "./types";

export const POSTER_WIDTH = 1280;
export const POSTER_HEIGHT = 720;

/** Ruta del póster: misma carpeta que los fotogramas reales, con extensión .svg. */
export function posterPath(incidentId: string, mediaId: string, idx: number): string {
  return `${storagePaths.incidentPrefix(incidentId)}media/${mediaId}/frames/${String(idx).padStart(3, "0")}.svg`;
}

export interface InsertMediaOptions {
  /** Instantes absolutos (ms). */
  capturedAtMs: number;
  analyzedAtMs: number;
  missionId: string | null;
  /**
   * "analyzed" = vitrina estática (queda lista).
   * "uploaded" = simulacro: el análisis va precargado y luego corre `processMedia`,
   * que no lo reemplaza (solo genera alertas y pide la fusión).
   */
  finalStatus: "analyzed" | "uploaded";
}

const encoder = new TextEncoder();

/** Posición de cada cuadro de dron: avanza ~25° por cuadro sobre la órbita de la cámara inicial. */
function droneFramePositions(
  incident: Pick<Incident, "lat" | "lng">,
  spec: DemoMediaSpec,
): { lat: number; lng: number; alt_m: number; heading_deg: number }[] {
  const center = { lat: incident.lat, lng: incident.lng };
  const start = toLatLng(center, spec.camera);
  const radius = Math.max(1, distanceM(center, start));
  const startBearing = bearingDeg(center, start);
  return spec.frames.map((_, i) => {
    const p = destination(center, startBearing + i * 25, radius);
    return {
      lat: p.lat,
      lng: p.lng,
      alt_m: spec.drone_alt_m ?? 45,
      heading_deg: Math.round(bearingDeg(p, center)),
    };
  });
}

async function uploadFrames(
  deps: DemoDeps,
  incident: Incident,
  media: Media,
  spec: DemoMediaSpec,
): Promise<void> {
  const drone = spec.source === "drone" ? droneFramePositions(incident, spec) : null;
  const frames: NewFrame[] = [];
  for (let i = 0; i < spec.frames.length; i++) {
    const f: DemoFrameSpec = spec.frames[i];
    const path = posterPath(incident.id, media.id, i);
    await deps.files.upload(path, encoder.encode(renderPoster(f.poster)), "image/svg+xml");
    frames.push({
      idx: i,
      t_s: f.t_s,
      storage_path: path,
      width: POSTER_WIDTH,
      height: POSTER_HEIGHT,
      lat: drone?.[i].lat ?? null,
      lng: drone?.[i].lng ?? null,
      alt_m: drone?.[i].alt_m ?? null,
      heading_deg: drone?.[i].heading_deg ?? null,
    });
  }
  await deps.store.addFrames(media.id, frames);
}

/** Crea el medio (o completa uno ya creado en un intento anterior) y devuelve su estado final. */
export async function insertDemoMedia(
  deps: DemoDeps,
  incident: Incident,
  spec: DemoMediaSpec,
  opts: InsertMediaOptions,
  existing: Media | null = null,
): Promise<Media> {
  const camera = toLatLng({ lat: incident.lat, lng: incident.lng }, spec.camera);
  const media =
    existing ??
    (await deps.store.createMedia({
      incident_id: incident.id,
      source: spec.source,
      kind: spec.kind,
      mission_id: opts.missionId,
      mime: null,
      size_bytes: null,
      duration_s: spec.duration_s,
      lat: camera.lat,
      lng: camera.lng,
      accuracy_m: spec.accuracy_m,
      heading_deg: spec.heading_deg,
      captured_at: new Date(opts.capturedAtMs).toISOString(),
      reporter_note: spec.reporter_note,
      upload_token_hash: null,
      video_status: "none",
      status: "uploading",
    }));

  if (media.frames.length < spec.frames.length) await uploadFrames(deps, incident, media, spec);

  // Ya completo, o el pipeline lo está procesando: no se toca (un reintento no debe pisar su estado).
  if (media.analysis && media.status !== "uploading" && media.status !== "failed") return media;
  const analysis: MediaAnalysis = spec.analysis;
  return deps.store.updateMedia(media.id, {
    status: opts.finalStatus,
    analysis,
    analysis_engine: "simulated",
    analyzed_at: opts.finalStatus === "analyzed" ? new Date(opts.analyzedAtMs).toISOString() : null,
    error: null,
  });
}
