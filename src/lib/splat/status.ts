/**
 * Estados de una reconstrucción 3DGS: etapas, textos y vencimiento.
 * Funciones puras sin dependencias de servidor: las usan la API y el visor.
 */
import type { Confidence, Reconstruction, ReconstructionStatus } from "@/lib/domain";

/** Etapas en curso, en el orden en que las recorre el job de GPU. */
export const ACTIVE_STAGES = ["queued", "preparing", "posing", "training", "exporting"] as const;
export type ActiveStage = (typeof ACTIVE_STAGES)[number];

const STAGE_RANK: Record<ReconstructionStatus, number> = {
  queued: 0,
  preparing: 1,
  posing: 2,
  training: 3,
  exporting: 4,
  ready: 5,
  failed: 5,
};

export function stageRank(status: ReconstructionStatus): number {
  return STAGE_RANK[status];
}

export const reconstructionStatusLabel: Record<ReconstructionStatus, string> = {
  queued: "En cola",
  preparing: "Preparando cuadros",
  posing: "Estimando cámaras",
  training: "Entrenando",
  exporting: "Exportando",
  ready: "Lista",
  failed: "Falló",
};

/** Mensaje por defecto de cada etapa (si el job no manda uno propio). */
export const reconstructionStatusMessage: Record<ReconstructionStatus, string> = {
  queued: "En cola: esperando que parta la GPU…",
  preparing: "Preparando los cuadros de los videos…",
  posing: "Estimando desde dónde se grabó cada cuadro…",
  training: "Entrenando la reconstrucción 3D…",
  exporting: "Exportando el archivo 3D…",
  ready: "Reconstrucción lista.",
  failed: "La reconstrucción falló.",
};

export const alignmentLabel: Record<Reconstruction["alignment"], string> = {
  gps: "Alineada con GPS",
  approximate: "Alineación aproximada",
  none: "Sin alinear",
};

export const alignmentHint: Record<Reconstruction["alignment"], string> = {
  gps: "Orientada y ubicada con las posiciones GPS de las cámaras (dron o teléfonos).",
  approximate: "Vertical y escala estimadas: la posición y el norte pueden diferir varios metros.",
  none: "Orientación y escala arbitrarias: no uses la grilla ni el norte para medir.",
};

export function isReconstructionActive(r: Pick<Reconstruction, "status"> | null | undefined): boolean {
  return Boolean(r) && r!.status !== "ready" && r!.status !== "failed";
}

/** Una reconstrucción en cola que nunca partió se da por perdida pasado este plazo. */
export const RECONSTRUCTION_QUEUE_TIMEOUT_MS = 20 * 60_000;
/** Ningún job de GPU debería durar más que esto (el job tiene su propio límite, menor). */
export const RECONSTRUCTION_RUN_TIMEOUT_MS = 2 * 60 * 60_000;

/**
 * true si la reconstrucción en curso dejó de dar señales y se puede lanzar otra.
 * No hay marca de "última noticia": se usa el momento de la solicitud y del inicio.
 */
export function isReconstructionStale(
  r: Pick<Reconstruction, "status" | "requested_at" | "started_at">,
  nowMs: number = Date.now(),
): boolean {
  if (!isReconstructionActive(r)) return false;
  const requested = Date.parse(r.requested_at);
  if (!Number.isFinite(requested)) return true;
  if (nowMs - requested > RECONSTRUCTION_RUN_TIMEOUT_MS) return true;
  return r.started_at === null && nowMs - requested > RECONSTRUCTION_QUEUE_TIMEOUT_MS;
}

/** Avance que se muestra: nunca menos que el piso de la etapa vigente (el job puede tardar en reportar). */
const STAGE_FLOOR: Record<ReconstructionStatus, number> = {
  queued: 0,
  preparing: 0.02,
  posing: 0.08,
  training: 0.2,
  exporting: 0.95,
  ready: 1,
  failed: 0,
};

export function displayProgress(r: Pick<Reconstruction, "status" | "progress">): number {
  const p = Number.isFinite(r.progress) ? Math.min(1, Math.max(0, r.progress)) : 0;
  return Math.max(p, STAGE_FLOOR[r.status]);
}

export interface GeometricConfidence {
  level: Confidence;
  /** Por qué, en una frase. */
  basis: string;
}

/**
 * Confianza en la geometría de una reconstrucción real (no la de demostración):
 * depende de cuántos cuadros se registraron y de si quedó alineada y a escala.
 */
export function geometricConfidence(
  r: Pick<Reconstruction, "alignment" | "scale_known" | "frames_registered" | "frame_count">,
): GeometricConfidence {
  const ratio =
    r.frames_registered !== null && r.frame_count > 0 ? r.frames_registered / r.frame_count : null;
  const pct = ratio === null ? null : `${Math.round(ratio * 100)} %`;
  if (r.alignment === "none" || (ratio !== null && ratio < 0.3)) {
    return {
      level: "low",
      basis:
        r.alignment === "none"
          ? "Sin alinear al terreno: sirve para mirar, no para medir."
          : `Solo se registró el ${pct} de los cuadros: puede haber zonas deformadas o vacías.`,
    };
  }
  if (r.alignment === "gps" && r.scale_known && (ratio === null || ratio >= 0.6)) {
    return {
      level: "high",
      basis: `Alineada con GPS y a escala${pct ? `; ${pct} de los cuadros registrados` : ""}.`,
    };
  }
  return {
    level: "medium",
    basis: `${r.scale_known ? "Escala conocida" : "Escala estimada"}, ${
      r.alignment === "gps" ? "alineada con GPS" : "alineación aproximada"
    }${pct ? `; ${pct} de los cuadros registrados` : ""}.`,
  };
}
