/**
 * Datos de prueba del diagnóstico de la vista técnica (todo sano a las 18:00:00 UTC).
 */
import type { DiagnosticsClaudeCall, DiagnosticsUtterance, IncidentDiagnostics, ZelloBridgeStatus } from "@/lib/contract";

export const T0 = Date.parse("2026-11-21T18:00:00.000Z");
export const iso = (ms: number) => new Date(ms).toISOString();

export const BRIDGE: ZelloBridgeStatus = {
  connected: true,
  channel: "demo-platanus",
  users_online: 3,
  listen_only: false,
  error: null,
  incident_codes: ["VG-AB12"],
  last_transmission: { at: iso(T0 - 20_000), from: "B-3", text: "en 6-3" },
  last_spoken: null,
  sent_at: iso(T0 - 4_000),
};

export const CALL: DiagnosticsClaudeCall = {
  at: iso(T0 - 5_000),
  task: "agente",
  model: "claude-opus-5-5",
  ms: 2_100,
  ok: true,
  error: null,
  status: null,
  input_tokens: 1000,
  output_tokens: 200,
  cache_read_tokens: 800,
  fast: true,
  fallback: false,
  stop_reason: "end_turn",
  incident_id: "i1",
  incident_code: "VG-AB12",
};

export function utt(seq: number, atMs: number, state: DiagnosticsUtterance["state"]): DiagnosticsUtterance {
  return { seq, at: iso(atMs), text: `m${seq}`, kind: "alerta", priority: "resto", engine: "claude", speak: true, rules: [], state, screen_reason: null };
}

export function diag(over: Partial<IncidentDiagnostics> = {}): IncidentDiagnostics {
  return {
    server_time: iso(T0),
    incident: { id: "i1", code: "VG-AB12", status: "active" },
    engine: {
      ai: "claude",
      has_credential: true,
      forced_simulated: false,
      analysis: { model: "claude-opus-5-5", effort: "medium", fast: false },
      live: { model: "claude-opus-5-5", effort: "low", fast: true },
      agent: { enabled: true, engine: "claude", model: "claude-opus-5-5", effort: "low", fast: true },
      transcription: true,
      store: "local",
      files: "local",
    },
    zello: { status: BRIDGE, received_at: iso(T0 - 4_000), stale: false },
    claude: { calls: [CALL], total: 1, errors: 0, p50_ms: 2_100, max_ms: 2_100 },
    detector: {
      configured: true,
      healthy: true,
      checked_at: iso(T0 - 3_000),
      labels: 24,
      live: [],
      media: { total: 0, uploading: 0, queued: 0, analyzing: 0, analyzed: 0, failed: 0, oldest_pending: null, last_analyzed: null, last_failed: null },
    },
    outbox: {
      agent_enabled: true,
      silenced: false,
      last_seq: 0,
      voice_interval_ms: 20_000,
      last_spoken_at: null,
      bridge_spoken: null,
      queue_exact: false,
      waiting: [],
      recent: [],
      blocked: [],
      unanswered_questions: 0,
      open_pending: 0,
      unread_comms: 0,
      unseen_media: 0,
      last_turn: { at: iso(T0 - 2_000), ms: 5, thought: false, engine: null, events: [] },
      last_thought: null,
      thinking: false,
      last_error: null,
      status_line: "Escuchando 3 radios",
    },
    errors: [],
    ...over,
  };
}
