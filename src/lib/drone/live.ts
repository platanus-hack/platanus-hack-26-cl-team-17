/**
 * Video en vivo del dron (solo servidor).
 *
 * Canal aparte de los lotes de análisis: el sensor manda cuadros chicos (≈640 px) varias
 * veces por segundo y el puesto de mando los ve casi en tiempo real. Estos cuadros NO se
 * guardan como evidencia ni pasan cuadro a cuadro por la IA: se guardan en memoria (los
 * últimos ~20 s) y cada LIVE_INSIGHT_EVERY_MS el observador en vivo mira hasta 3 de ellos
 * y deja una observación corta.
 *
 * Memoria por instancia: si Cloud Run reparte el sensor y el puesto de mando en instancias
 * distintas, el último cuadro también queda en el storage (a lo más uno cada 2 s) y la otra
 * instancia lo sirve desde ahí, con menos cuadros por segundo.
 */
import type { LiveFrameAck, LiveInsightView } from "@/lib/contract";
import { LIMITS, type DroneMission } from "@/lib/domain";
import { errors } from "@/lib/http";
import { incidentTypeLabel } from "@/lib/labels";
import { analyzeLiveFrames, LIVE_SEVERITY_RANK, type LiveInsightInput, type LiveInsightResult } from "@/lib/ai/live";
import { storagePaths } from "@/lib/store/types";
import { isMissionActive } from "./plan";
import type { DroneDeps } from "./service";

export const LIVE_INSIGHT_EVERY_MS = 15_000;
/** Cuadros que se guardan en memoria por misión (~20 s a 3 cuadros por segundo). */
const BUFFER_FRAMES = 60;
const MAX_INSIGHT_FRAMES = 3;
const KEEP_INSIGHTS = 20;
/** Cada cuánto el último cuadro se copia al storage para otras instancias. */
const STORE_EVERY_MS = 2000;
/** Sin cuadros nuevos por este tiempo la memoria de la misión se libera. */
const IDLE_DROP_MS = 10 * 60_000;

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
    if (!s.analyzing && now - last > IDLE_DROP_MS) states().delete(id);
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
    };
    states().set(mission.id, s);
  }
  const seq = Math.max(now, (s.frames.at(-1)?.seq ?? 0) + 1);
  s.frames.push({ seq, at: now, bytes });
  if (s.frames.length > BUFFER_FRAMES) s.frames.splice(0, s.frames.length - BUFFER_FRAMES);

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

async function runInsight(deps: DroneDeps, mission: DroneMission, s: LiveState): Promise<void> {
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
    const input: LiveInsightInput = {
      incident: { title: incident.title, type: incidentTypeLabel[incident.type], address: incident.address },
      mission: { label: fresh.label, altitude_m: fresh.last?.alt_m ?? null, heading_deg: fresh.last?.heading_deg ?? null },
      frames: frames.map((f) => ({
        base64: Buffer.from(f.bytes).toString("base64"),
        ago_s: Math.round((newest.at - f.at) / 1000),
      })),
      previous,
      windowS: Math.round(LIVE_INSIGHT_EVERY_MS / 1000),
    };
    let result: LiveInsightResult;
    try {
      result = await analyzeLiveFrames(input);
    } catch (err) {
      console.warn("[dron-vivo] no se pudo analizar la ventana", mission.id, err instanceof Error ? err.message : err);
      addInsight(s, {
        id: `${mission.id}-${newest.seq}`,
        at: iso(deps.now()),
        summary: "No se pudo analizar esta ventana de video. Se reintenta en la próxima.",
        severity: "info",
        changed: false,
        observations: [],
        engine: "error",
        frames: frames.length,
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
      frames: frames.length,
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

export function listLiveInsights(missionId: string): { insights: LiveInsightView[]; analyzing: boolean } {
  const s = states().get(missionId);
  return { insights: s ? [...s.insights] : [], analyzing: s?.analyzing ?? false };
}
