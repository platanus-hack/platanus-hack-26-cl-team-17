/** Tipos compartidos de la vista de incidente. */
import type { MediaView } from "@/lib/contract";
/** Qué medio abrir en el visor y en qué fotograma. */
export interface MediaViewerTarget { mediaId: string; frame?: number | null }
/** Pestañas de la columna derecha. */
export type ActivityTab = "timeline" | "comms" | "drone";
/** Vista del centro. */
export type CenterView = "scene" | "map" | "media";
/** Busca un medio por su etiqueta "M3" (insensible a mayúsculas). */
export function findMediaByLabel(media: MediaView[], label: string): MediaView | undefined {
  const l = label.trim().toUpperCase();
  return media.find((m) => m.label.toUpperCase() === l);
}
