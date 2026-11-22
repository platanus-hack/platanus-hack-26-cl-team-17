/**
 * Cliente del detector YOLO (servicio aparte en vigia/detector). Solo servidor.
 *
 * Nunca lanza: si el detector no está configurado, está caído o tarda, devuelve null y
 * quien llama sigue por el camino de antes (Claude con visión). Así la app funciona
 * igual sin el servicio.
 */
import type { IdTokenClient } from "google-auth-library";
import { config } from "@/lib/config";
import { recordServerError } from "@/lib/server/diagnostics";
import { parseDetectResult, type DetectResult } from "./types";

const HEALTH_TTL_MS = 15_000;
const DEFAULT_TIMEOUT_MS = 4_000;

type GlobalWithDetector = typeof globalThis & {
  __vigiaDetectorHealth?: { at: number; ok: boolean; labels: string[] };
  __vigiaDetectorIdClient?: Promise<IdTokenClient>;
};

function healthCache() {
  return globalThis as GlobalWithDetector;
}

/**
 * Con VIGIA_DETECTOR_AUTH=gcp, token de identidad de la cuenta del servicio para el Cloud Run
 * privado del detector (el cliente lo guarda y lo renueva antes de que venza). Si falla, lanza.
 */
async function authHeaders(): Promise<Record<string, string>> {
  if (config.detectorAuth !== "gcp") return {};
  const g = healthCache();
  g.__vigiaDetectorIdClient ??= import("google-auth-library").then(({ GoogleAuth }) =>
    new GoogleAuth().getIdTokenClient(config.detectorUrl),
  );
  try {
    const value = (await (await g.__vigiaDetectorIdClient).getRequestHeaders()).get("authorization");
    return value ? { authorization: value } : {};
  } catch (err) {
    g.__vigiaDetectorIdClient = undefined;
    throw err;
  }
}

export function isDetectorConfigured(): boolean {
  return Boolean(config.detectorUrl);
}

/** Última consulta a /health (sin consultar de nuevo); null si nunca se consultó. Para la vista técnica. */
export function detectorHealthSnapshot(): { at: number; ok: boolean; labels: number } | null {
  const h = healthCache().__vigiaDetectorHealth;
  return h ? { at: h.at, ok: h.ok, labels: h.labels.length } : null;
}

/** true si el detector responde /health (cacheado unos segundos). */
export async function detectorHealthy(): Promise<boolean> {
  if (!isDetectorConfigured()) return false;
  const g = healthCache();
  const now = Date.now();
  if (g.__vigiaDetectorHealth && now - g.__vigiaDetectorHealth.at < HEALTH_TTL_MS) return g.__vigiaDetectorHealth.ok;
  let ok = false;
  let labels: string[] = [];
  try {
    const res = await fetch(`${config.detectorUrl}/health`, {
      headers: await authHeaders(),
      signal: AbortSignal.timeout(1500),
      cache: "no-store",
    });
    if (res.ok) {
      const body = (await res.json()) as { ok?: unknown; labels?: unknown };
      ok = body.ok === true;
      labels = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === "string") : [];
    }
  } catch {
    ok = false;
  }
  if (!ok && g.__vigiaDetectorHealth?.ok !== false) {
    console.warn("[vigia-yolo] detector no disponible; se usa el análisis con visión", { url: config.detectorUrl });
  }
  g.__vigiaDetectorHealth = { at: now, ok, labels };
  return ok;
}

export interface DetectOptions {
  annotate?: boolean;
  /** Umbral mínimo de confianza (por defecto el del servicio, 0.25). */
  conf?: number;
  contentType?: string;
  timeoutMs?: number;
}

/** Detecta en un cuadro (JPEG o PNG). null si no hay detector o falló. */
export async function detectFrame(bytes: Uint8Array, opts: DetectOptions = {}): Promise<DetectResult | null> {
  if (!(await detectorHealthy())) return null;
  const qs = new URLSearchParams();
  if (opts.annotate) qs.set("annotate", "1");
  if (opts.conf !== undefined) qs.set("conf", String(opts.conf));
  const url = `${config.detectorUrl}/detect${qs.size > 0 ? `?${qs}` : ""}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { ...(await authHeaders()), "content-type": opts.contentType ?? "image/jpeg" },
      body: bytes as BodyInit,
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) {
      console.warn("[vigia-yolo] el detector respondió con error", { status: res.status });
      recordServerError("detector", `El detector respondió ${res.status}`);
      return null;
    }
    return parseDetectResult(await res.json());
  } catch (error) {
    console.warn("[vigia-yolo] falló la detección", { error: error instanceof Error ? error.message : String(error) });
    recordServerError("detector", error, { context: "Falló la detección" });
    // Si se cayó, que el próximo /health lo confirme en vez de esperar el TTL.
    const g = healthCache();
    if (g.__vigiaDetectorHealth) g.__vigiaDetectorHealth.at = 0;
    return null;
  }
}

/** Detecta en varios cuadros con concurrencia acotada (el detector corre en CPU). */
export async function detectFrames(
  frames: { bytes: Uint8Array; contentType?: string }[],
  opts: Omit<DetectOptions, "contentType"> & { concurrency?: number } = {},
): Promise<(DetectResult | null)[]> {
  const out: (DetectResult | null)[] = new Array(frames.length).fill(null);
  const concurrency = Math.max(1, opts.concurrency ?? 3);
  let next = 0;
  async function worker() {
    while (next < frames.length) {
      const i = next++;
      out[i] = await detectFrame(frames[i].bytes, { ...opts, contentType: frames[i].contentType });
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, frames.length) }, worker));
  return out;
}
