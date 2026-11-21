/**
 * Armado del manifiesto que lee el job de GPU (SplatManifest de contract.ts).
 * Funciones puras: la ruta las usa con los medios del store.
 */
import type { SplatManifest } from "@/lib/contract";
import { LIMITS, type Incident, type Media, type MediaFrame } from "@/lib/domain";
import { storagePaths } from "@/lib/store/types";

/** Solo cuadros JPEG reales: los pósters SVG de demostración no sirven para reconstruir. */
const REAL_FRAME_RE = /\.jpe?g$/i;

export function realFrames(media: Pick<Media, "frames">): MediaFrame[] {
  return media.frames.filter((f) => REAL_FRAME_RE.test(f.storage_path)).sort((a, b) => a.idx - b.idx);
}

export function hasOriginalVideo(media: Pick<Media, "video_path" | "video_status">): boolean {
  return media.video_status === "uploaded" && Boolean(media.video_path);
}

/** Un medio sirve si no es de demostración y trae el video original o cuadros reales. */
export function isReconstructionEligible(media: Media): boolean {
  if (media.source === "demo") return false;
  return hasOriginalVideo(media) || realFrames(media).length > 0;
}

/**
 * Medios que entran a la reconstrucción: los elegibles del incidente, o solo los
 * pedidos (si vienen ids, los que no son elegibles o no existen se ignoran).
 */
export function selectReconstructionMedia(media: Media[], mediaIds?: string[]): Media[] {
  const wanted = mediaIds && mediaIds.length > 0 ? new Set(mediaIds) : null;
  return media.filter((m) => (!wanted || wanted.has(m.id)) && isReconstructionEligible(m));
}

export interface BuildManifestInput {
  incident: Pick<Incident, "id" | "lat" | "lng">;
  reconstructionId: string;
  media: Media[];
  bucket: string;
  callbackUrl: string;
  iterations: number;
  maxFrames?: number;
  sampleFps?: number;
}

export function buildSplatManifest(input: BuildManifestInput): SplatManifest {
  const media = input.media.filter(isReconstructionEligible);
  return {
    version: 1,
    incident_id: input.incident.id,
    reconstruction_id: input.reconstructionId,
    origin: { lat: input.incident.lat, lng: input.incident.lng },
    bucket: input.bucket,
    output_prefix: storagePaths.reconstruction(input.incident.id, input.reconstructionId),
    callback_url: input.callbackUrl,
    iterations: input.iterations,
    max_frames: input.maxFrames ?? LIMITS.SPLAT_MAX_FRAMES,
    sample_fps: input.sampleFps ?? LIMITS.SPLAT_SAMPLE_FPS,
    media: media.map((m) => ({
      id: m.id,
      label: m.label,
      // isReconstructionEligible ya descartó "demo".
      source: m.source as "citizen" | "drone" | "responder",
      video_path: hasOriginalVideo(m) ? m.video_path : null,
      lat: m.lat,
      lng: m.lng,
      accuracy_m: m.accuracy_m,
      heading_deg: m.heading_deg,
      frames: realFrames(m).map((f) => ({
        path: f.storage_path,
        t_s: f.t_s,
        lat: f.lat,
        lng: f.lng,
        alt_m: f.alt_m,
        heading_deg: f.heading_deg,
      })),
    })),
  };
}

/**
 * Cuadros que se espera que entren (antes de que el job lo informe): un video se
 * muestrea a sample_fps; si no hay duración, cuentan los cuadros ya extraídos.
 */
export function estimateFrameCount(
  manifest: Pick<SplatManifest, "max_frames" | "sample_fps" | "media">,
  durations: Record<string, number | null> = {},
): number {
  let total = 0;
  for (const m of manifest.media) {
    const duration = durations[m.id] ?? null;
    const fromVideo =
      m.video_path && duration !== null && duration > 0 ? Math.ceil(duration * manifest.sample_fps) : 0;
    total += Math.max(fromVideo, m.frames.length);
  }
  return Math.min(total, manifest.max_frames);
}

/** URL absoluta del callback del job para un incidente. */
export function callbackUrlFor(origin: string, incidentId: string): string {
  return `${origin.replace(/\/$/, "")}/api/internal/reconstruction/${encodeURIComponent(incidentId)}`;
}
