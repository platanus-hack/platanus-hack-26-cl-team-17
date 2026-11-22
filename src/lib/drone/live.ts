/**
 * Video en vivo del dron (solo servidor).
 *
 * Canal aparte de los lotes de análisis: el sensor manda cuadros chicos (≈640 px) varias
 * veces por segundo y el puesto de mando los ve casi en tiempo real. Estos cuadros NO se
 * guardan como evidencia ni pasan cuadro a cuadro por la IA: se guardan en memoria (los
 * últimos ~20 s) y cada LIVE_INSIGHT_EVERY_MS el observador en vivo mira hasta 3 de ellos
 * y deja una observación corta.
 *
 * Con detector YOLO (VIGIA_DETECTOR_URL), cada cuadro que llega pasa por YOLO en segundo plano
 * (si hay una detección en curso para la misión se salta al siguiente): la última detección y
 * las ~30 anteriores quedan en memoria para dibujar las cajas en el puesto de mando, y el
 * observador recibe el texto de las detecciones de la ventana más UN cuadro anotado.
 *
 * Memoria por instancia: si Cloud Run reparte el sensor y el puesto de mando en instancias
 * distintas, el último cuadro también queda en el storage (a lo más uno cada 2 s) y la otra
 * instancia lo sirve desde ahí, con menos cuadros por segundo.
 */
import type { LiveFrameAck, LiveInsightView } from "@/lib/contract";
import { LIMITS, type DroneMission } from "@/lib/domain";
import { errors } from "@/lib/http";
import { incidentTypeLabel } from "@/lib/labels";
import { aiEngineKind } from "@/lib/config";
import { recordServerError } from "@/lib/server/diagnostics";
import {
  analyzeLiveFrames,
  LIVE_SEVERITY_RANK,
  type LiveDetectionWindow,
  type LiveInsightInput,
  type LiveInsightResult,
} from "@/lib/ai/live";
import { storagePaths } from "@/lib/store/types";
import { detectFrame, isDetectorConfigured } from "@/lib/vision/detector";
import type { LiveDetection } from "@/lib/vision/live-detections";
import { withoutAnnotation } from "@/lib/vision/media-detections";
import { detectionText, frameInterest, type DetectResult } from "@/lib/vision/types";
import { forwardLive3dFrame, isLive3dConfigured } from "./live3d";
import { isMissionActive } from "./plan";
import type { DroneDeps } from "./service";

export const LIVE_INSIGHT_EVERY_MS = 15_000;
/** Cuadros que se guardan en memoria por misión (~20 s a 8 cuadros por segundo, ~50 KB cada uno). */
const BUFFER_FRAMES = 160;
const MAX_INSIGHT_FRAMES = 3;
const KEEP_INSIGHTS = 20;
/** Cada cuánto el último cuadro se copia al storage para otras instancias. */
const STORE_EVERY_MS = 2000;
/** Sin cuadros nuevos por este tiempo la memoria de la misión se libera. */
const IDLE_DROP_MS = 10 * 60_000;
/** Detecciones en vivo que se guardan por misión (las más nuevas; cubren la ventana del observador). */
const KEEP_DETECTIONS = 120;
/**
 * Separación mínima entre detecciones de una misión (tope ~8 por segundo). En la práctica manda
 * la velocidad del detector: si hay una en curso, el cuadro se salta.
 */
const MIN_DETECT_GAP_MS = 125;
/** Fuego y humo salen con confianzas bajas: se piden desde 0,1 y la interfaz filtra lo que dibuja. */
const LIVE_DETECT_CONF = 0.1;
const LIVE_DETECT_TIMEOUT_MS = 2500;
const LIVE_ANNOTATE_TIMEOUT_MS = 4000;

interface LiveFrame {
  /** Instante de llegada en ms; sirve de número de secuencia entre instancias. */
  seq: number;
  at: number;
  bytes: Uint8Array;
}

interface LiveState {
  incidentId: string;
  frames: LiveFrame[];
  lastStoredAt: number;
  lastInsightAt: number;
  /** seq del último cuadro que ya vio el observador. */
  lastInsightSeq: number;
  analyzing: boolean;
  insights: LiveInsightView[];
  /** Hay una detección YOLO en curso para esta misión. */
  detecting: boolean;
  lastDetectAt: number;
  /** Últimas detecciones (en orden de seq); `atMs` = llegada del cuadro. */
  detections: { seq: number; atMs: number; result: DetectResult }[];
}

type GlobalWithLive = typeof globalThis & {
  __vigiaLive?: Map<string, LiveState>;
  __vigiaLiveRemote?: Map<string, { at: number; frame: LiveFrame | null }>;
};

function states(): Map<string, LiveState> {
  const g = globalThis as GlobalWithLive;
  g.__vigiaLive ??= new Map();
  return g.__vigiaLive;
}

function remoteCache(): Map<string, { at: number; frame: LiveFrame | null }> {
  const g = globalThis as GlobalWithLive;
  g.__vigiaLiveRemote ??= new Map();
  return g.__vigiaLiveRemote;
}

function dropIdle(now: number): void {
  for (const [id, s] of states()) {
    const last = s.frames.at(-1)?.at ?? 0;
    if (!s.analyzing && !s.detecting && now - last > IDLE_DROP_MS) states().delete(id);
  }
}

const iso = (ms: number) => new Date(ms).toISOString();

export interface LiveFrameOut {
  seq: number;
  at: string;
  bytes: Uint8Array;
  source: "memory" | "storage";
}

/** Recibe un cuadro del sensor. Puede disparar (en segundo plano) la observación de la ventana. */
export async function pushLiveFrame(
  deps: DroneDeps,
  mission: DroneMission,
  bytes: Uint8Array,
): Promise<LiveFrameAck> {
  if (!isMissionActive(mission)) throw errors.conflict("La misión terminó; ya no recibe video.");
  if (bytes.byteLength === 0) throw errors.invalid("El cuadro llegó vacío.");
  if (bytes.byteLength > LIMITS.MAX_LIVE_FRAME_BYTES) throw errors.tooLarge("El cuadro en vivo es demasiado grande.");
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw errors.invalid("El cuadro debe ser una imagen JPEG.");

  const now = deps.now();
  dropIdle(now);
  let s = states().get(mission.id);
  if (!s) {
    s = {
      incidentId: mission.incident_id,
      frames: [],
      lastStoredAt: 0,
      // La primera observación espera a juntar una ventana corta de video.
      lastInsightAt: now - LIVE_INSIGHT_EVERY_MS + 3000,
      lastInsightSeq: 0,
      analyzing: false,
      insights: [],
      detecting: false,
      lastDetectAt: 0,
      detections: [],
    };
    states().set(mission.id, s);
  }
  const seq = Math.max(now, (s.frames.at(-1)?.seq ?? 0) + 1);
  s.frames.push({ seq, at: now, bytes });
  if (s.frames.length > BUFFER_FRAMES) s.frames.splice(0, s.frames.length - BUFFER_FRAMES);
  // Reconstrucción 3D en vivo (VIGIA_LIVE3D_URL): reenvío en segundo plano, se salta cuadros si hay uno en curso.
  if (isLive3dConfigured()) deps.defer(() => forwardLive3dFrame(mission.id, bytes, now));

  // YOLO en segundo plano: la respuesta al sensor no espera; si hay una en curso, se salta este cuadro.
  if (!s.detecting && now - s.lastDetectAt >= MIN_DETECT_GAP_MS && isDetectorConfigured()) {
    s.detecting = true;
    s.lastDetectAt = now;
    const state = s;
    const frame = s.frames[s.frames.length - 1];
    deps.defer(() => runDetection(state, frame));
  }

  if (now - s.lastStoredAt >= STORE_EVERY_MS) {
    s.lastStoredAt = now;
    const path = storagePaths.live(mission.incident_id, mission.id);
    deps.defer(() => deps.files.upload(path, bytes, "image/jpeg").catch(() => undefined));
  }

  if (!s.analyzing && now - s.lastInsightAt >= LIVE_INSIGHT_EVERY_MS) {
    s.analyzing = true;
    s.lastInsightAt = now;
    const state = s;
    deps.defer(() => runInsight(deps, mission, state));
  }
  return { ok: true, seq, command: mission.command };
}

/** Elige hasta `max` cuadros repartidos en la ventana, siempre con el último. */
export function pickWindowFrames<T extends { at: number }>(frames: T[], now: number, windowMs: number, max: number): T[] {
  const inWindow = frames.filter((f) => now - f.at <= windowMs);
  if (inWindow.length <= max) return inWindow;
  const out: T[] = [];
  for (let i = 0; i < max; i++) {
    out.push(inWindow[Math.round(((inWindow.length - 1) * i) / (max - 1))]);
  }
  return out;
}

async function runDetection(s: LiveState, frame: LiveFrame): Promise<void> {
  try {
    const result = await detectFrame(frame.bytes, { conf: LIVE_DETECT_CONF, timeoutMs: LIVE_DETECT_TIMEOUT_MS });
    if (!result) return;
    s.detections.push({ seq: frame.seq, atMs: frame.at, result: withoutAnnotation(result) });
    if (s.detections.length > KEEP_DETECTIONS) s.detections.splice(0, s.detections.length - KEEP_DETECTIONS);
  } catch (err) {
    console.warn("[vigia-yolo] falló la detección en vivo", err instanceof Error ? err.message : err);
  } finally {
    s.detecting = false;
  }
}

/**
 * Con detector: las detecciones de la ventana y su cuadro de más interés, anotado si se pudo.
 * null si no hay detecciones en la ventana (o ninguna encontró nada): se usa el camino de 3 cuadros.
 */
async function detectorWindow(
  s: LiveState,
  now: number,
  newestAt: number,
): Promise<{ frame: { base64: string; ago_s: number }; window: LiveDetectionWindow; annotateMs: number } | null> {
  const inWindow = s.detections.filter((d) => now - d.atMs <= LIVE_INSIGHT_EVERY_MS);
  if (!inWindow.some((d) => d.result.detections.length > 0)) return null;
  // El de más interés; a igualdad, el más reciente.
  let key = inWindow[0];
  for (const d of inWindow) if (frameInterest(d.result) >= frameInterest(key.result)) key = d;
  const raw = s.frames.find((f) => f.seq === key.seq);
  if (!raw) return null;
  const t0 = Date.now();
  const annotated = await detectFrame(raw.bytes, {
    annotate: true,
    conf: LIVE_DETECT_CONF,
    timeoutMs: LIVE_ANNOTATE_TIMEOUT_MS,
  });
  const annotateMs = Date.now() - t0;
  const ago = (at: number) => Math.max(0, Math.round((newestAt - at) / 1000));
  return {
    frame: { base64: annotated?.annotated_jpeg_b64 ?? Buffer.from(raw.bytes).toString("base64"), ago_s: ago(raw.at) },
    window: {
      results: inWindow.map((d) => ({ ago_s: ago(d.atMs), result: d.result })),
      annotated: Boolean(annotated?.annotated_jpeg_b64),
    },
    annotateMs,
  };
}

async function runInsight(deps: DroneDeps, mission: DroneMission, s: LiveState): Promise<void> {
  // Sin IA configurada no hay observador: el video en vivo igual llega al puesto de mando.
  const analyze = deps.analyzeLive ?? (aiEngineKind() === "claude" ? analyzeLiveFrames : null);
  if (!analyze) return;
  const { store } = deps;
  // Otra instancia puede estar recibiendo el mismo sensor: una sola observación por ventana.
  const lock = `drone-live:${mission.id}`;
  let locked = false;
  try {
    locked = await store.acquireLock(mission.incident_id, lock, 30);
    if (!locked) return;
    const now = deps.now();
    const frames = pickWindowFrames(s.frames, now, LIVE_INSIGHT_EVERY_MS, MAX_INSIGHT_FRAMES);
    const newest = frames.at(-1);
    if (!newest || newest.seq <= s.lastInsightSeq) return;

    const [incident, fresh] = await Promise.all([store.getIncident(mission.incident_id), store.getMission(mission.id)]);
    if (!incident || !fresh || !isMissionActive(fresh)) return;
    const previous = s.insights[0]?.summary ?? null;
    const det = await detectorWindow(s, now, newest.at);
    const input: LiveInsightInput = {
      incident: { title: incident.title, type: incidentTypeLabel[incident.type], address: incident.address },
      mission: { label: fresh.label, altitude_m: fresh.last?.alt_m ?? null, heading_deg: fresh.last?.heading_deg ?? null },
      frames: det
        ? [det.frame]
        : frames.map((f) => ({
            base64: Buffer.from(f.bytes).toString("base64"),
            ago_s: Math.round((newest.at - f.at) / 1000),
          })),
      previous,
      windowS: Math.round(LIVE_INSIGHT_EVERY_MS / 1000),
      ...(det ? { detections: det.window } : {}),
    };
    // Con detector, "cuadros que miró" = los que pasaron por YOLO en la ventana.
    const looked = det ? det.window.results.length : frames.length;
    let result: LiveInsightResult;
    const t0 = Date.now();
    try {
      result = await analyze(input);
      if (det) {
        console.info("[vigia-yolo] observador en vivo con detector", {
          mission: mission.id,
          frames_yolo: det.window.results.length,
          annotated: det.window.annotated,
          annotate_ms: det.annotateMs,
          claude_ms: Date.now() - t0,
          engine: result.engine,
          images_sent: 1,
          images_before: frames.length,
        });
      }
    } catch (err) {
      console.warn("[dron-vivo] no se pudo analizar la ventana", mission.id, err instanceof Error ? err.message : err);
      recordServerError("dron", err, {
        incidentId: mission.incident_id,
        incidentCode: incident.code,
        context: `Observador en vivo de ${fresh.label}`,
      });
      addInsight(s, {
        id: `${mission.id}-${newest.seq}`,
        at: iso(deps.now()),
        summary: "No se pudo analizar esta ventana de video. Se reintenta en la próxima.",
        severity: "info",
        changed: false,
        observations: [],
        engine: "error",
        frames: looked,
      });
      return;
    }
    s.lastInsightSeq = newest.seq;
    const insight: LiveInsightView = {
      id: `${mission.id}-${newest.seq}`,
      at: iso(deps.now()),
      summary: result.summary,
      severity: result.severity,
      changed: result.changed,
      observations: result.observations,
      engine: result.engine,
      frames: looked,
    };
    addInsight(s, insight);
    // Lo importante queda en la bitácora del incidente (visible desde cualquier instancia).
    if (result.engine === "claude" && LIVE_SEVERITY_RANK[result.severity] >= LIVE_SEVERITY_RANK.warning) {
      await store.addEvent({
        incident_id: mission.incident_id,
        kind: "drone",
        severity: result.severity,
        title: `Dron ${fresh.label} en vivo: ${result.summary}`,
        detail: result.observations.join(" ") || "Observación del video en vivo del dron.",
        mission_id: mission.id,
      });
    }
  } catch (err) {
    console.warn("[dron-vivo] falló la observación", mission.id, err);
  } finally {
    s.analyzing = false;
    if (locked) await store.releaseLock(mission.incident_id, lock).catch(() => undefined);
  }
}

function addInsight(s: LiveState, insight: LiveInsightView): void {
  s.insights.unshift(insight);
  if (s.insights.length > KEEP_INSIGHTS) s.insights.length = KEEP_INSIGHTS;
}

/**
 * Último cuadro en vivo de la misión, o null si no hay video. `after` = seq que ya tiene
 * quien mira: si no hay uno más nuevo devuelve "unchanged".
 */
export async function getLiveFrame(
  deps: DroneDeps,
  missionId: string,
  after: number | null,
): Promise<LiveFrameOut | "unchanged" | null> {
  const s = states().get(missionId);
  const last = s?.frames.at(-1);
  if (last) {
    if (after !== null && last.seq <= after) return "unchanged";
    return { seq: last.seq, at: iso(last.at), bytes: last.bytes, source: "memory" };
  }
  // Otra instancia recibe el sensor: se lee la copia del storage (a lo más una vez por segundo).
  const now = deps.now();
  const cached = remoteCache().get(missionId);
  let frame = cached && now - cached.at < 1000 ? cached.frame : undefined;
  if (frame === undefined) {
    frame = null;
    const mission = await deps.store.getMission(missionId);
    if (!mission) throw errors.notFound("La misión no existe.");
    const path = storagePaths.live(mission.incident_id, missionId);
    if (await deps.files.exists(path).catch(() => false)) {
      const { bytes } = await deps.files.download(path);
      const prev = cached?.frame;
      const same = prev && prev.bytes.byteLength === bytes.byteLength && Buffer.from(prev.bytes).equals(Buffer.from(bytes));
      frame = same ? prev : { seq: now, at: now, bytes };
    }
    remoteCache().set(missionId, { at: now, frame });
  }
  if (!frame) return null;
  if (after !== null && frame.seq <= after) return "unchanged";
  return { seq: frame.seq, at: iso(frame.at), bytes: frame.bytes, source: "storage" };
}

const toLiveDetection = (d: LiveState["detections"][number]): LiveDetection => ({
  seq: d.seq,
  at: iso(d.atMs),
  result: d.result,
});

/** Última detección YOLO del video en vivo de la misión (en esta instancia); null sin detector o sin video. */
export function getLiveDetections(missionId: string): LiveDetection | null {
  const last = states().get(missionId)?.detections.at(-1);
  return last ? toLiveDetection(last) : null;
}

/** Historial corto de detecciones en vivo (las ~30 últimas), en orden de seq. */
export function listLiveDetectionHistory(missionId: string): LiveDetection[] {
  return (states().get(missionId)?.detections ?? []).map(toLiveDetection);
}

/** Estado del video en vivo de una misión en esta instancia (vista técnica); null si aquí no llegan cuadros. */
export function liveDiagnostics(missionId: string): {
  lastFrameAt: string | null;
  lastDetection: { at: string; text: string; ms: number } | null;
  detecting: boolean;
  analyzing: boolean;
  lastInsight: { at: string; engine: string; summary: string } | null;
} | null {
  const s = states().get(missionId);
  if (!s) return null;
  const last = s.frames.at(-1);
  const det = s.detections.at(-1);
  const insight = s.insights[0];
  return {
    lastFrameAt: last ? iso(last.at) : null,
    lastDetection: det
      ? {
          at: iso(det.atMs),
          text: Object.entries(det.result.counts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([label, n]) => `${detectionText(label)}${n > 1 ? ` ×${n}` : ""}`)
            .join(", "),
          ms: det.result.ms,
        }
      : null,
    detecting: s.detecting,
    analyzing: s.analyzing,
    lastInsight: insight ? { at: insight.at, engine: insight.engine, summary: insight.summary } : null,
  };
}

export function listLiveInsights(missionId: string): { insights: LiveInsightView[]; analyzing: boolean } {
  const s = states().get(missionId);
  return { insights: s ? [...s.insights] : [], analyzing: s?.analyzing ?? false };
}
