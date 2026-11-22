/**
 * Diagnóstico de una emergencia para la vista técnica (GET /api/incidents/[id]/diagnostico).
 * Solo servidor.
 *
 * Junta lo que ya existe, sin duplicarlo: el latido del puente Zello (zello/status.ts), el
 * registro de llamadas a Claude y de errores (diagnostics.ts), la salud del detector YOLO, el
 * video en vivo de los drones, la cola de análisis de videos y la memoria de Vigía.
 *
 * No envía secretos: de la configuración solo los modelos y si hay credenciales; del
 * incidente solo id, código y estado (nunca share_key); ningún dato del personal.
 * Si una parte no se puede leer, el resto igual se entrega y la falla queda en los errores.
 */
import type {
  DiagnosticsDetector,
  DiagnosticsEngine,
  DiagnosticsLiveFeed,
  DiagnosticsMediaQueue,
  DiagnosticsOutbox,
  DiagnosticsUtterance,
  IncidentDiagnostics,
  ZelloStatusResponse,
} from "@/lib/contract";
import type { CommEntry, DroneMission, Media } from "@/lib/domain";
import { aiEngineKind, config, isGcsConfigured, isPostgresConfigured } from "@/lib/config";
import { liveModelSettings } from "@/lib/ai/live";
import { liveDiagnostics } from "@/lib/drone/live";
import { isMissionActive } from "@/lib/drone/plan";
import { getStore } from "@/lib/store";
import { detectorHealthSnapshot, detectorHealthy, isDetectorConfigured } from "@/lib/vision/detector";
import { agentEngine, agentModelSettings } from "@/lib/vigia/agent";
import { SPOKEN_MIN_INTERVAL_MS } from "@/lib/vigia/rules";
import { getVigiaState } from "@/lib/vigia/state-store";
import { emptyVigiaState, radioText, type VigiaLogEntry, type VigiaState, type VigiaUtterance } from "@/lib/vigia/types";
import { isHeardComm } from "@/lib/vigia/world";
import { getAgentTurns, listClaudeCalls, listServerErrors, recordServerError, type AgentTurnRecord } from "./diagnostics";
import { isTranscriptionConfigured } from "./transcribe";
import { loadZelloStatus } from "./zello/status";

/** Cuánto guarda el puente un mensaje que no alcanza a decir (SPEECH_TTL_MS en zello/bridge.ts). */
export const BRIDGE_SPEECH_TTL_MS = 45_000;
/** Sin cuadros nuevos por este tiempo, esta instancia ya no está recibiendo el video en vivo. */
const LIVE_RECEIVING_MS = 10_000;
const RECENT_UTTERANCES = 15;
const RECENT_BLOCKED = 10;
const CLAUDE_CALLS_SHOWN = 10;

/* ───────────────────────────── Motor ───────────────────────────── */

export function engineView(): DiagnosticsEngine {
  const live = liveModelSettings();
  const agent = agentModelSettings();
  return {
    ai: aiEngineKind(),
    has_credential: config.hasAnthropic,
    forced_simulated: config.forceSimulated,
    analysis: { model: config.aiModel, effort: config.aiEffort, fast: config.aiFast },
    live: { model: live.model, effort: live.effort, fast: live.fast },
    agent: { enabled: config.vigiaAgent, engine: agentEngine(), ...agent },
    transcription: isTranscriptionConfigured(),
    store: isPostgresConfigured() ? "postgres" : "local",
    files: isGcsConfigured() ? "gcs" : "local",
  };
}

/* ───────────────────────────── Salida de Vigía (pura) ───────────────────────────── */

/** true si el puente está en línea y con voz: lo que va por voz puede salir. */
export function bridgeCanSpeak(z: ZelloStatusResponse): boolean {
  const s = z.status;
  return Boolean(s && !z.stale && !s.stopped && s.connected && !s.listen_only);
}

function norm(text: string): string {
  return text.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
}

/** El puente recorta lo dicho a 300 caracteres (con «…»): se compara el comienzo. */
function sameSpoken(spoken: string, text: string): boolean {
  const a = norm(spoken).replace(/…$/, "").slice(0, 120);
  return a.length > 0 && norm(text).startsWith(a);
}

const BLOCKED_RE = /^Mensaje bloqueado por las reglas: «([\s\S]*)»$/;

/** Mensajes que las reglas bloquearon (tools.ts los deja en la bitácora), más recientes primero. */
export function blockedFromLog(log: readonly VigiaLogEntry[], max = RECENT_BLOCKED): DiagnosticsOutbox["blocked"] {
  const out: DiagnosticsOutbox["blocked"] = [];
  for (let i = log.length - 1; i >= 0 && out.length < max; i--) {
    const m = BLOCKED_RE.exec(log[i].what);
    if (!m) continue;
    const reasons = log[i].why
      .replace(/^Regla:\s*/i, "")
      .split(/,\s*/)
      .map((r) => r.trim())
      .filter(Boolean);
    out.push({ at: log[i].at, text: m[1], reasons });
  }
  return out;
}

export interface OutboxInput {
  state: VigiaState;
  zello: ZelloStatusResponse;
  nowMs: number;
  agentEnabled: boolean;
  unreadComms: number;
  unseenMedia: number;
  turns: { last: AgentTurnRecord | null; thought: AgentTurnRecord | null };
}

/**
 * Qué pasa con cada mensaje de Vigía. Si el latido trae la cola del puente, se usa tal cual (lo
 * posterior al latido cuenta como en cola: el puente recoge la salida cada ~1,5 s). Un puente
 * anterior no la manda: se estima con lo último que dijo y su plazo de 45 s. Por qué un mensaje
 * quedó solo en pantalla se estima con la hora del mensaje hablado anterior (límite de 20 s) y
 * el silencio actual.
 */
export function buildOutbox(input: OutboxInput): DiagnosticsOutbox {
  const { state, zello, nowMs } = input;
  const all = [...state.utterances].sort((a, b) => a.seq - b.seq);
  const canSpeak = bridgeCanSpeak(zello);
  const spoken = zello.status?.last_spoken ?? null;
  const queue = canSpeak ? zello.status?.queue : undefined;
  const sentAt = Date.parse(zello.status?.sent_at ?? "");
  // Solo el más reciente con el mismo texto cuenta como "dicho".
  let saidSeq: number | null = null;
  if (spoken) {
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i].speak && sameSpoken(spoken.text, radioText(all[i]))) {
        saidSeq = all[i].seq;
        break;
      }
    }
  }

  let prevSpokenAt: number | null = null;
  const diag: DiagnosticsUtterance[] = all.map((u: VigiaUtterance) => {
    const at = Date.parse(u.at);
    let st: DiagnosticsUtterance["state"];
    let reason: DiagnosticsUtterance["screen_reason"] = null;
    if (!u.speak) {
      st = "pantalla";
      const within = prevSpokenAt !== null && Number.isFinite(at) && at - prevSpokenAt < SPOKEN_MIN_INTERVAL_MS;
      if (u.kind === "propuesta") reason = "propuesta";
      else if (u.priority === "persona") reason = "pantalla";
      else if (state.silenced) reason = "silencio";
      else if (within && u.kind !== "respuesta") reason = "limite_20s";
      else reason = "pantalla";
    } else {
      if (Number.isFinite(at)) prevSpokenAt = at;
      if (u.seq === saidSeq) st = "dicho";
      else if (!canSpeak) st = "sin_puente";
      else if (queue) st = queue.some((q) => sameSpoken(q.text, radioText(u))) || !(at <= sentAt) ? "en_cola" : "salio";
      else if (nowMs - at <= BRIDGE_SPEECH_TTL_MS) st = "en_cola";
      else st = "salio";
    }
    return {
      seq: u.seq,
      at: u.at,
      text: u.text,
      kind: u.kind,
      priority: u.priority,
      engine: u.engine,
      speak: u.speak,
      rules: u.rules,
      state: st,
      screen_reason: reason,
    };
  });

  const t = input.turns;
  return {
    agent_enabled: input.agentEnabled,
    silenced: state.silenced,
    last_seq: state.seq,
    voice_interval_ms: SPOKEN_MIN_INTERVAL_MS,
    last_spoken_at: state.last_spoken_at,
    bridge_spoken: spoken,
    waiting: diag.filter((d) => d.state === "en_cola"),
    queue_exact: Boolean(queue),
    recent: diag.slice(-RECENT_UTTERANCES).reverse(),
    blocked: blockedFromLog(state.log),
    unanswered_questions: state.questions.filter((q) => !q.answered).length,
    open_pending: state.pending.filter((p) => p.status === "abierto").length,
    unread_comms: input.unreadComms,
    unseen_media: input.unseenMedia,
    last_turn: t.last,
    last_thought: t.thought ? { at: t.thought.at, ms: t.thought.ms, engine: t.thought.engine, events: t.thought.events } : null,
    thinking: state.status.thinking,
    last_error: state.last_error,
    status_line: state.status.line,
  };
}

/** Radio que Vigía todavía no lee: posterior a su cursor, sin su propia voz ni transmisiones vacías. */
export function unreadComms(comms: readonly CommEntry[], cursor: number): number {
  return comms.filter((c) => c.seq > cursor && isHeardComm(c)).length;
}

/** Videos cuyo estado Vigía aún no vio (nuevos o que cambiaron, p. ej. ya analizados). */
export function unseenMedia(media: readonly Pick<Media, "id" | "status">[], seen: Record<string, string>): number {
  return media.filter((m) => seen[m.id] !== m.status).length;
}

/* ───────────────────────────── Detector y videos (puras) ───────────────────────────── */

export function mediaQueue(media: readonly Media[]): DiagnosticsMediaQueue {
  const count = (s: Media["status"]) => media.filter((m) => m.status === s).length;
  // Un lote abierto del dron está "subiendo" mientras junta cuadros: no es un atraso.
  const pending = media
    .filter((m) => m.status === "uploaded" || m.status === "analyzing" || (m.status === "uploading" && m.source !== "drone"))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const analyzed = media
    .filter((m) => m.status === "analyzed" && m.analyzed_at)
    .sort((a, b) => (b.analyzed_at ?? "").localeCompare(a.analyzed_at ?? ""));
  const failed = media.filter((m) => m.status === "failed").sort((a, b) => b.created_at.localeCompare(a.created_at));
  const oldest = pending[0];
  const last = analyzed[0];
  return {
    total: media.length,
    uploading: count("uploading"),
    queued: count("uploaded"),
    analyzing: count("analyzing"),
    analyzed: count("analyzed"),
    failed: failed.length,
    oldest_pending: oldest ? { label: oldest.label, since: oldest.created_at, status: oldest.status } : null,
    last_analyzed: last ? { label: last.label, at: last.analyzed_at ?? last.created_at, engine: last.analysis_engine } : null,
    last_failed: failed[0] ? { label: failed[0].label, error: failed[0].error } : null,
  };
}

export function liveFeed(mission: Pick<DroneMission, "id" | "label" | "status">, nowMs: number): DiagnosticsLiveFeed | null {
  const d = liveDiagnostics(mission.id);
  const active = isMissionActive(mission);
  if (!d && !active) return null;
  const lastFrame = d?.lastFrameAt ? Date.parse(d.lastFrameAt) : null;
  return {
    mission_id: mission.id,
    label: mission.label,
    active,
    receiving: lastFrame !== null && nowMs - lastFrame <= LIVE_RECEIVING_MS,
    last_frame_at: d?.lastFrameAt ?? null,
    last_detection_at: d?.lastDetection?.at ?? null,
    last_detection: d?.lastDetection ? d.lastDetection.text : null,
    last_detection_ms: d?.lastDetection?.ms ?? null,
    detecting: d?.detecting ?? false,
    observer: {
      analyzing: d?.analyzing ?? false,
      last_at: d?.lastInsight?.at ?? null,
      engine: d?.lastInsight?.engine ?? null,
      summary: d?.lastInsight?.summary ?? null,
    },
  };
}

async function detectorView(missions: readonly DroneMission[], media: readonly Media[], nowMs: number): Promise<DiagnosticsDetector> {
  const configured = isDetectorConfigured();
  // Consulta /health a lo más cada 15 s (caché de vision/detector.ts) y espera como mucho 1,5 s.
  const healthy = configured ? await detectorHealthy() : null;
  const snap = configured ? detectorHealthSnapshot() : null;
  return {
    configured,
    healthy,
    checked_at: snap && snap.at > 0 ? new Date(snap.at).toISOString() : null,
    labels: snap?.labels ?? 0,
    live: missions.map((m) => liveFeed(m, nowMs)).filter((f): f is DiagnosticsLiveFeed => f !== null),
    media: mediaQueue(media),
  };
}

/* ───────────────────────────── Llamadas a Claude ───────────────────────────── */

function claudeView(): IncidentDiagnostics["claude"] {
  const calls = listClaudeCalls();
  const okMs = calls
    .filter((c) => c.ok)
    .map((c) => c.ms)
    .sort((a, b) => a - b);
  return {
    calls: calls.slice(0, CLAUDE_CALLS_SHOWN),
    total: calls.length,
    errors: calls.filter((c) => !c.ok).length,
    p50_ms: okMs.length > 0 ? okMs[Math.floor((okMs.length - 1) / 2)] : null,
    max_ms: calls.length > 0 ? Math.max(...calls.map((c) => c.ms)) : null,
  };
}

/* ───────────────────────────── Armado ───────────────────────────── */

/** Lee una parte sin dejar que su falla tape las demás (queda en los errores recientes). */
async function safely<T>(what: string, incidentId: string, read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read();
  } catch (error) {
    console.warn(`[diagnostico] no pude leer ${what}`, { incidentId, error: error instanceof Error ? error.message : String(error) });
    recordServerError("api", error, { incidentId, context: `Diagnóstico: no pude leer ${what}` });
    return fallback;
  }
}

/** Diagnóstico de la emergencia; null si no existe. */
export async function buildIncidentDiagnostics(incidentId: string): Promise<IncidentDiagnostics | null> {
  const store = getStore();
  const incident = await store.getIncident(incidentId);
  if (!incident) return null;

  const [media, comms, missions, state, zello] = await Promise.all([
    safely("los videos", incidentId, () => store.listMedia(incidentId), [] as Media[]),
    safely("la radio", incidentId, () => store.listComms(incidentId), [] as CommEntry[]),
    safely("los drones", incidentId, () => store.listMissions(incidentId), [] as DroneMission[]),
    safely("la memoria de Vigía", incidentId, () => getVigiaState(incidentId), emptyVigiaState(incidentId, new Date().toISOString())),
    safely("el estado del puente Zello", incidentId, () => loadZelloStatus(), { status: null, received_at: null, stale: true } as ZelloStatusResponse),
  ]);
  const detector = await safely(
    "el detector",
    incidentId,
    () => detectorView(missions, media, Date.now()),
    { configured: isDetectorConfigured(), healthy: null, checked_at: null, labels: 0, live: [], media: mediaQueue(media) } as DiagnosticsDetector,
  );

  const nowMs = Date.now();
  const engine = engineView();
  return {
    server_time: new Date(nowMs).toISOString(),
    incident: { id: incident.id, code: incident.code, status: incident.status },
    engine,
    zello,
    claude: claudeView(),
    detector,
    outbox: buildOutbox({
      state,
      zello,
      nowMs,
      agentEnabled: engine.agent.enabled,
      unreadComms: unreadComms(comms, state.cursors.comm_seq),
      unseenMedia: unseenMedia(media, state.cursors.media),
      turns: getAgentTurns(incidentId),
    }),
    errors: listServerErrors(),
  };
}
