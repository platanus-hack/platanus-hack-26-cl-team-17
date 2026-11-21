/**
 * Aplica un ReconstructionUpdate del job de GPU a la reconstrucción del incidente.
 * Puro: decide el nuevo estado, si corresponde un evento de línea de tiempo y si
 * hay que pedirle al job que se detenga (`cancel`).
 */
import type {
  Reconstruction,
  ReconstructionUpdate,
  TimelineKind,
  TimelineSeverity,
} from "@/lib/domain";
import { formatNumber } from "@/lib/format";
import { storagePaths } from "@/lib/store/types";
import {
  alignmentLabel,
  reconstructionStatusMessage,
  stageRank,
} from "./status";

export interface ReconstructionEvent {
  kind: TimelineKind;
  severity: TimelineSeverity;
  title: string;
  detail: string;
}

export type ReconstructionUpdateResult =
  | { applied: false; cancel: boolean; reason: "superseded" | "finished" | "cancelled" }
  | { applied: true; cancel: boolean; next: Reconstruction; event: ReconstructionEvent | null };

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/** Copia los campos que el job sí mandó (undefined = no informado; null = vacío explícito). */
function mergeFields(current: Reconstruction, u: ReconstructionUpdate): Reconstruction {
  const next = { ...current };
  if (u.gpu !== undefined) next.gpu = u.gpu;
  if (u.frame_count !== undefined) next.frame_count = u.frame_count;
  if (u.frames_registered !== undefined) next.frames_registered = u.frames_registered;
  if (u.splat_path !== undefined) next.splat_path = u.splat_path;
  if (u.splat_format !== undefined) next.splat_format = u.splat_format;
  if (u.transform !== undefined) next.transform = u.transform;
  if (u.alignment !== undefined) next.alignment = u.alignment;
  if (u.scale_known !== undefined) next.scale_known = u.scale_known;
  if (u.gaussians !== undefined) next.gaussians = u.gaussians;
  if (u.iterations !== undefined) next.iterations = u.iterations;
  if (u.gpu_seconds !== undefined) next.gpu_seconds = u.gpu_seconds;
  return next;
}

function failedEvent(error: string): ReconstructionEvent {
  return {
    kind: "error",
    severity: "warning",
    title: "Falló la reconstrucción 3D",
    detail: error,
  };
}

function readyEvent(r: Reconstruction): ReconstructionEvent {
  const parts: string[] = [];
  if (r.gaussians !== null) parts.push(`${formatNumber(r.gaussians)} gaussianas`);
  if (r.frames_registered !== null) {
    parts.push(`${r.frames_registered} de ${r.frame_count} cuadros registrados`);
  }
  parts.push(alignmentLabel[r.alignment].toLowerCase());
  parts.push(r.scale_known ? "escala conocida" : "escala desconocida");
  if (r.gpu) parts.push(`GPU ${r.gpu}`);
  return {
    kind: "scene_updated",
    severity: "notice",
    title: "Reconstrucción 3D lista",
    detail: parts.join(" · "),
  };
}

export function applyReconstructionUpdate(
  current: Reconstruction | null | undefined,
  update: ReconstructionUpdate,
  ctx: { incidentId: string; now: string },
): ReconstructionUpdateResult {
  // Un job viejo (reemplazado por otro) debe detenerse: ya nadie mira su resultado.
  if (!current || current.id !== update.reconstruction_id || current.backend !== "cloud_run_gpu") {
    return { applied: false, cancel: true, reason: "superseded" };
  }
  if (current.status === "ready") return { applied: false, cancel: false, reason: "finished" };
  if (current.status === "failed") return { applied: false, cancel: true, reason: "cancelled" };

  const merged = mergeFields(current, update);
  const startedAt = current.started_at ?? (update.status !== "queued" ? ctx.now : null);
  const message = update.message.trim();

  if (update.status === "failed") {
    const error =
      update.error?.trim() || message || "El job de GPU reportó una falla sin detalle.";
    const next: Reconstruction = {
      ...merged,
      status: "failed",
      message: message || reconstructionStatusMessage.failed,
      error,
      started_at: startedAt,
      finished_at: ctx.now,
    };
    return { applied: true, cancel: false, next, event: failedEvent(error) };
  }

  if (update.status === "ready") {
    const prefix = storagePaths.reconstruction(ctx.incidentId, current.id);
    const path = merged.splat_path;
    // El archivo debe quedar en la carpeta de esta reconstrucción: /api/files autoriza por prefijo.
    if (!path || !path.startsWith(prefix) || path.includes("..")) {
      const error = path
        ? "El job terminó con un archivo fuera de la carpeta de la reconstrucción."
        : "El job terminó sin entregar el archivo de splats.";
      const next: Reconstruction = {
        ...merged,
        splat_path: null,
        status: "failed",
        message: reconstructionStatusMessage.failed,
        error,
        started_at: startedAt,
        finished_at: ctx.now,
      };
      return { applied: true, cancel: false, next, event: failedEvent(error) };
    }
    const next: Reconstruction = {
      ...merged,
      splat_format: merged.splat_format ?? "splat",
      status: "ready",
      progress: 1,
      message: message || reconstructionStatusMessage.ready,
      error: null,
      started_at: startedAt,
      finished_at: ctx.now,
    };
    return { applied: true, cancel: false, next, event: readyEvent(next) };
  }

  // En curso: la etapa y el avance nunca retroceden (los callbacks pueden llegar desordenados).
  const advances = stageRank(update.status) >= stageRank(current.status);
  const status = advances ? update.status : current.status;
  const next: Reconstruction = {
    ...merged,
    status,
    // Hasta que llegue "ready" no se muestra 100 %.
    progress: Math.min(0.99, Math.max(current.progress, clamp01(update.progress))),
    message: !advances
      ? current.message
      : message || (status !== current.status ? reconstructionStatusMessage[status] : current.message),
    started_at: startedAt,
  };
  return { applied: true, cancel: false, next, event: null };
}
