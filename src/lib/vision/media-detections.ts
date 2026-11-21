/**
 * Detecciones YOLO de un medio, guardadas en el storage junto a sus fotogramas.
 *
 *   incidents/<id>/media/<mediaId>/detections.json  → MediaDetections
 *   incidents/<id>/media/<mediaId>/annotated.jpg    → el cuadro de más interés con las cajas
 *
 * Las escribe el motor con detector (src/lib/ai/engine-detector.ts) al analizar el medio y
 * las leen la fusión y el agente Vigía. No cambia el contrato del store: son archivos más.
 */
import type { FileStorage } from "@/lib/store/types";
import { aggregateDetections, parseDetectResult, type DetectResult } from "./types";

export interface MediaDetections {
  media_id: string;
  /** Etiqueta del medio, p. ej. "M2". */
  media_label: string;
  /** Cuándo se corrió el detector (ISO). */
  at: string;
  /** Modelo del detector según su /health (p. ej. "yoloe-26s-seg"); null si no lo informó. */
  model: string | null;
  /** Un elemento por fotograma que el detector alcanzó a procesar, en orden de idx. */
  frames: { idx: number; t_s: number; result: Omit<DetectResult, "annotated_jpeg_b64"> }[];
  /** Fotograma anotado (cajas dibujadas) y su ruta en el storage; null si no se pudo anotar. */
  keyframe: { idx: number; path: string } | null;
  aggregate: ReturnType<typeof aggregateDetections>;
}

export function mediaDetectionsPath(incidentId: string, mediaId: string): string {
  return `incidents/${incidentId}/media/${mediaId}/detections.json`;
}

export function mediaAnnotatedPath(incidentId: string, mediaId: string): string {
  return `incidents/${incidentId}/media/${mediaId}/annotated.jpg`;
}

/** El resultado sin la imagen anotada (que va aparte, en annotated.jpg). */
export function withoutAnnotation(result: DetectResult): Omit<DetectResult, "annotated_jpeg_b64"> {
  const { width, height, ms, detections, counts } = result;
  return { width, height, ms, detections, counts };
}

export async function saveMediaDetections(files: FileStorage, incidentId: string, d: MediaDetections): Promise<void> {
  const body = new TextEncoder().encode(JSON.stringify(d));
  await files.upload(mediaDetectionsPath(incidentId, d.media_id), body, "application/json");
}

/** Guarda el cuadro anotado del medio y devuelve su ruta. */
export async function saveAnnotatedFrame(
  files: FileStorage,
  incidentId: string,
  mediaId: string,
  jpeg: Uint8Array,
): Promise<string> {
  const path = mediaAnnotatedPath(incidentId, mediaId);
  await files.upload(path, jpeg, "image/jpeg");
  return path;
}

/** Valida un MediaDetections leído del storage (no confiar en el archivo). null si no cumple. */
export function parseMediaDetections(raw: unknown): MediaDetections | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.media_id !== "string" || typeof r.media_label !== "string" || !Array.isArray(r.frames)) return null;
  const frames: MediaDetections["frames"] = [];
  for (const f of r.frames as unknown[]) {
    if (!f || typeof f !== "object") continue;
    const x = f as Record<string, unknown>;
    if (typeof x.idx !== "number" || !Number.isInteger(x.idx) || x.idx < 0) continue;
    const result = parseDetectResult(x.result);
    if (!result) continue;
    frames.push({
      idx: x.idx,
      t_s: typeof x.t_s === "number" && Number.isFinite(x.t_s) ? x.t_s : 0,
      result: withoutAnnotation(result),
    });
  }
  frames.sort((a, b) => a.idx - b.idx);
  const k = r.keyframe as Record<string, unknown> | null | undefined;
  const keyframe =
    k && typeof k === "object" && typeof k.idx === "number" && typeof k.path === "string" && k.path.startsWith("incidents/")
      ? { idx: k.idx, path: k.path }
      : null;
  return {
    media_id: r.media_id,
    media_label: r.media_label,
    at: typeof r.at === "string" ? r.at : "",
    model: typeof r.model === "string" ? r.model : null,
    frames,
    keyframe,
    // Se recalcula desde los cuadros: así nunca contradice lo guardado.
    aggregate: aggregateDetections(frames.map((f) => f.result)),
  };
}

/** Detecciones guardadas del medio; null si no hay (medio analizado sin detector) o el archivo no sirve. */
export async function loadMediaDetections(
  files: FileStorage,
  incidentId: string,
  mediaId: string,
): Promise<MediaDetections | null> {
  const path = mediaDetectionsPath(incidentId, mediaId);
  try {
    if (!(await files.exists(path))) return null;
    const { bytes } = await files.download(path);
    return parseMediaDetections(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return null;
  }
}
