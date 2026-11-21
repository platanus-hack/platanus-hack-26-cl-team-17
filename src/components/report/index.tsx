"use client";
/**
 * Cargador de medios reutilizable: "vecino" (pasos grandes y guiados, teléfono) y
 * "mando" (compacto, arrastrar y soltar, cola de archivos). Ambos envían con `submitReport`:
 * fotogramas primero (el análisis empieza ahí) y después el video original con progreso.
 */
import type { MediaUploaderProps } from "./types";
import { MandoUploader } from "./MandoUploader";
import { VecinoUploader } from "./VecinoUploader";

export type { MediaUploaderProps } from "./types";

export function MediaUploader(props: MediaUploaderProps) {
  return props.variant === "mando" ? <MandoUploader {...props} /> : <VecinoUploader {...props} />;
}
