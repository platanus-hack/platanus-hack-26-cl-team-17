/**
 * Orquestación de la reconstrucción 3DGS (solo servidor):
 *  - startReconstruction: escribe el manifiesto y lanza el job de Cloud Run con GPU
 *    (sin GPU configurada responde 409).
 *  - handleReconstructionCallback: aplica el progreso que reporta el job.
 */
import { config, runtimeMode } from "@/lib/config";
import type { Reconstruction, ReconstructionUpdate, StartReconstructionInput } from "@/lib/domain";
import { errors, HttpError } from "@/lib/http";
import { newId } from "@/lib/ids";
import { getFiles, getStore } from "@/lib/store";
import { storagePaths, type FileStorage, type Store } from "@/lib/store/types";
import { describeGoogleError, runSplatJob, type RunJobInput } from "./cloud-run";
import {
  buildSplatManifest,
  callbackUrlFor,
  estimateFrameCount,
  selectReconstructionMedia,
} from "./manifest";
import { applyReconstructionUpdate } from "./reducer";
import {
  isReconstructionActive,
  isReconstructionStale,
  reconstructionStatusLabel,
  reconstructionStatusMessage,
} from "./status";
import { reconstructionToken, verifyReconstructionToken } from "./token";

export interface SplatDeps {
  store: Pick<
    Store,
    "getIncident" | "updateIncident" | "listMedia" | "addEvent" | "acquireLock" | "releaseLock"
  >;
  files: Pick<FileStorage, "upload">;
  now: () => Date;
  splat: "cloud_run_gpu" | "off";
  bucket: string;
  job: string;
  defaultIterations: number;
  runJob: (input: RunJobInput) => Promise<{ operation: string | null }>;
  newId: () => string;
}

export function defaultSplatDeps(): SplatDeps {
  return {
    store: getStore(),
    files: getFiles(),
    now: () => new Date(),
    splat: runtimeMode().splat ?? "off",
    bucket: config.gcsBucket,
    job: config.splatJob,
    defaultIterations: config.splatIterations,
    runJob: runSplatJob,
    newId,
  };
}

const LOCK = "reconstruction";

/** Origen público para el callback: NEXT_PUBLIC_APP_URL o el de la solicitud (detrás del proxy de Cloud Run). */
export function callbackOrigin(req: Request): string {
  if (config.appUrl) return config.appUrl;
  const url = new URL(req.url);
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0].trim() || url.protocol.replace(/:$/, "");
  const host = req.headers.get("x-forwarded-host")?.split(",")[0].trim() || req.headers.get("host") || url.host;
  return `${proto}://${host}`;
}

function baseReconstruction(id: string, nowIso: string): Reconstruction {
  return {
    id,
    status: "queued",
    progress: 0,
    message: reconstructionStatusMessage.queued,
    method: "gaussian_splatting",
    backend: "cloud_run_gpu",
    gpu: null,
    media_ids: [],
    frame_count: 0,
    frames_registered: null,
    splat_path: null,
    splat_format: null,
    transform: null,
    alignment: "none",
    scale_known: false,
    gaussians: null,
    iterations: null,
    gpu_seconds: null,
    error: null,
    requested_at: nowIso,
    started_at: null,
    finished_at: null,
  };
}

export async function startReconstruction(
  incidentId: string,
  input: StartReconstructionInput,
  origin: string,
  deps: SplatDeps = defaultSplatDeps(),
): Promise<Reconstruction> {
  const { store } = deps;
  const incident = await store.getIncident(incidentId);
  if (!incident) throw errors.notFound("Incidente no encontrado.");
  if (deps.splat !== "cloud_run_gpu") {
    throw errors.conflict("No hay GPU configurada para reconstruir en 3D desde los videos.");
  }

  const current = incident.reconstruction ?? null;
  if (current && isReconstructionActive(current) && !isReconstructionStale(current, deps.now().getTime())) {
    throw errors.conflict(
      `Ya hay una reconstrucción 3D en curso (${reconstructionStatusLabel[current.status].toLowerCase()}). Espera a que termine.`,
    );
  }
  if (!(await store.acquireLock(incident.id, LOCK, 60))) {
    throw errors.conflict("Ya se está iniciando una reconstrucción 3D para este incidente.");
  }
  try {
    return await launchGpu(incident.id, incident, input, origin, deps);
  } finally {
    await store.releaseLock(incident.id, LOCK).catch(() => undefined);
  }
}

async function launchGpu(
  incidentId: string,
  incident: { id: string; lat: number; lng: number },
  input: StartReconstructionInput,
  origin: string,
  deps: SplatDeps,
): Promise<Reconstruction> {
  const { store } = deps;
  const media = selectReconstructionMedia(await store.listMedia(incidentId), input.media_ids);
  if (media.length === 0) {
    throw errors.conflict(
      input.media_ids?.length
        ? "Los medios elegidos no tienen video original ni cuadros reales."
        : "No hay videos ni cuadros para reconstruir. Sube un video o despliega el dron.",
    );
  }
  const id = deps.newId();
  const prefix = storagePaths.reconstruction(incidentId, id);
  const manifest = buildSplatManifest({
    incident,
    reconstructionId: id,
    media,
    bucket: deps.bucket,
    callbackUrl: callbackUrlFor(origin, incidentId),
    iterations: input.iterations ?? deps.defaultIterations,
  });
  const durations = Object.fromEntries(media.map((m) => [m.id, m.duration_s]));
  const rec: Reconstruction = {
    ...baseReconstruction(id, deps.now().toISOString()),
    media_ids: manifest.media.map((m) => m.id),
    frame_count: estimateFrameCount(manifest, durations),
    iterations: manifest.iterations,
  };

  await deps.files.upload(
    `${prefix}manifest.json`,
    new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
    "application/json",
  );
  // Se guarda antes de lanzar: el primer callback del job puede llegar antes de que esto responda.
  await store.updateIncident(incidentId, { reconstruction: rec });

  try {
    const { operation } = await deps.runJob({
      job: deps.job,
      manifestUri: `gs://${deps.bucket}/${prefix}manifest.json`,
      callbackToken: reconstructionToken(incidentId, id),
    });
    console.info(`[splat] job lanzado para ${incidentId}/${id}: ${operation ?? "(sin operación)"}`);
  } catch (err) {
    const detail = describeGoogleError(err);
    console.error(`[splat] no se pudo lanzar el job para ${incidentId}/${id}:`, err);
    const failed: Reconstruction = {
      ...rec,
      status: "failed",
      message: "No se pudo lanzar el job de GPU.",
      error: detail,
      finished_at: deps.now().toISOString(),
    };
    await store.updateIncident(incidentId, { reconstruction: failed });
    await store.addEvent({
      incident_id: incidentId,
      kind: "error",
      severity: "warning",
      title: "No se pudo lanzar la reconstrucción 3D",
      detail,
    });
    throw new HttpError(502, "internal", `No se pudo lanzar el job de GPU: ${detail}`);
  }
  return rec;
}

export async function handleReconstructionCallback(
  incidentId: string,
  token: string,
  update: ReconstructionUpdate,
  deps: Pick<SplatDeps, "store" | "now"> = defaultSplatDeps(),
): Promise<{ ok: true; cancel: boolean }> {
  if (!verifyReconstructionToken(token, incidentId, update.reconstruction_id)) {
    throw errors.unauthorized("Token de reconstrucción inválido.");
  }
  const incident = await deps.store.getIncident(incidentId);
  if (!incident) return { ok: true, cancel: true };
  const result = applyReconstructionUpdate(incident.reconstruction ?? null, update, {
    incidentId,
    now: deps.now().toISOString(),
  });
  if (result.applied) {
    await deps.store.updateIncident(incidentId, { reconstruction: result.next });
    if (result.event) await deps.store.addEvent({ incident_id: incidentId, ...result.event });
  }
  return { ok: true, cancel: result.cancel };
}
