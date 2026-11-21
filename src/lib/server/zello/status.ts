/**
 * Último latido del puente Zello, guardado en el storage (Cloud Storage o .data/files)
 * para que lo vean todas las instancias del servidor. Solo servidor.
 */
import { z } from "zod";
import type { DiagnosticsErrorSource, ZelloBridgeStatus, ZelloStatusResponse } from "@/lib/contract";
import { mergeRemoteErrors, recordServerError } from "@/lib/server/diagnostics";
import { getFiles } from "@/lib/store";
import { storagePaths, type FileStorage } from "@/lib/store/types";

/** Más que esto sin latido = el puente se cayó o perdió la red. */
export const ZELLO_STALE_MS = 30_000;
/** Cuánto se reusa la última lectura del storage (la mesa consulta cada pocos segundos). */
const CACHE_MS = 3_000;

const clip = (max: number) => z.string().transform((s) => s.slice(0, max));

const ERROR_SOURCES = ["agente", "transcripcion", "subida", "puente", "analisis", "detector", "dron", "api"] as const satisfies readonly DiagnosticsErrorSource[];

export const ZelloBridgeStatusSchema = z.object({
  stopped: z.boolean().optional(),
  connected: z.boolean(),
  channel: clip(80),
  users_online: z.number().int().min(0).max(100_000).nullable(),
  listen_only: z.boolean(),
  error: clip(300).nullable(),
  incident_codes: z.array(clip(24)).max(50),
  last_transmission: z.object({ at: z.string().datetime(), from: clip(60), text: clip(300) }).nullable(),
  last_spoken: z.object({ at: z.string().datetime(), text: clip(300) }).nullable(),
  sent_at: z.string().datetime(),
  queue: z
    .array(
      z.object({
        text: clip(300),
        priority: clip(16),
        kind: clip(24).nullable(),
        incident_id: clip(64).nullable(),
        expires_at: z.string().datetime(),
      }),
    )
    .max(50)
    .optional(),
  errors: z
    .array(
      z.object({
        at: z.string().datetime(),
        first_at: z.string().datetime(),
        count: z.number().int().min(1).max(1_000_000),
        source: z.enum(ERROR_SOURCES),
        message: clip(300),
      }),
    )
    .max(10)
    .optional(),
}) satisfies z.ZodType<ZelloBridgeStatus, unknown>;

interface Stored {
  status: ZelloBridgeStatus;
  received_at: string;
}

let cache: { at: number; value: Stored | null } | null = null;

export async function saveZelloStatus(status: ZelloBridgeStatus, files: FileStorage = getFiles(), now = new Date()): Promise<void> {
  // El puente corre aparte: su único canal de errores hacia la vista técnica es el latido.
  if (status.error && !status.stopped) {
    recordServerError("puente", status.error, { context: `Zello («${status.channel}»)`, now: now.getTime() });
  }
  // Los errores del proceso del puente (la transcripción corre allá) se suman a los del servidor.
  if (status.errors?.length) mergeRemoteErrors(status.errors);
  const value: Stored = { status, received_at: now.toISOString() };
  await files.upload(storagePaths.zelloStatus, new TextEncoder().encode(JSON.stringify(value)), "application/json");
  cache = { at: now.getTime(), value };
}

async function readStored(files: FileStorage, now: number): Promise<Stored | null> {
  if (cache && now - cache.at < CACHE_MS) return cache.value;
  let value: Stored | null = null;
  try {
    if (await files.exists(storagePaths.zelloStatus)) {
      const { bytes } = await files.download(storagePaths.zelloStatus);
      value = JSON.parse(new TextDecoder().decode(bytes)) as Stored;
    }
  } catch (err) {
    console.warn("[vigia:zello] no se pudo leer el estado del puente:", err);
  }
  cache = { at: now, value };
  return value;
}

/** Estado para la mesa de mando, con `stale` calculado con la hora del servidor. */
export function toStatusResponse(stored: Stored | null, now: number): ZelloStatusResponse {
  if (!stored) return { status: null, received_at: null, stale: true };
  const received = Date.parse(stored.received_at);
  return {
    status: stored.status,
    received_at: stored.received_at,
    stale: !Number.isFinite(received) || now - received > ZELLO_STALE_MS,
  };
}

export async function loadZelloStatus(files: FileStorage = getFiles(), now = Date.now()): Promise<ZelloStatusResponse> {
  return toStatusResponse(await readStored(files, now), now);
}
