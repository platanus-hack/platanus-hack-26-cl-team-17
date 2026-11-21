/**
 * Vista técnica: de los datos del diagnóstico a lo que se ve (tono y texto corto de cada
 * subsistema, rótulos). Puro: probado en model.test.ts.
 *
 * `nowMs` es la hora del servidor estimada en el navegador (Date.now() + desfase de la última
 * respuesta): así "hace N s" no depende del reloj del equipo de la mesa.
 */
import type {
  DiagnosticsClaudeCall,
  DiagnosticsErrorSource,
  DiagnosticsLiveFeed,
  DiagnosticsUtterance,
  IncidentDiagnostics,
  ZelloStatusResponse,
} from "@/lib/contract";
import { zelloLine } from "@/components/comms/ZelloStatus";
import { formatNumber } from "@/lib/format";

export type DiagTone = "ok" | "warning" | "critical" | "muted";
export type SubsystemId = "motor" | "zello" | "claude" | "detector" | "salida" | "errores";

export interface SubsystemStatus {
  id: SubsystemId;
  label: string;
  tone: DiagTone;
  /** Texto corto para la banda. */
  value: string;
  /** Explicación larga (atributo title y lectores de pantalla). */
  hint: string;
}

/** El puente manda un latido cada ~10 s; más de esto sin latido = caído (igual que ZELLO_STALE_MS). */
export const HEARTBEAT_STALE_MS = 30_000;
/** Una llamada a Claude más lenta que esto se marca como lenta. */
export const SLOW_CALL_MS = 20_000;
/** Un video que espera análisis más de esto está atrasado. */
export const MEDIA_LATE_MS = 120_000;
/** YOLO atrasado respecto del último cuadro en vivo. */
export const LIVE_LAG_MS = 5_000;
/** Errores más nuevos que esto ponen la banda en rojo; hasta ERROR_WARN_MS, en ámbar. */
export const ERROR_CRITICAL_MS = 120_000;
export const ERROR_WARN_MS = 15 * 60_000;
/** Un mensaje de voz que espera más que esto en la cola del puente está atascado. */
export const OUTBOX_STUCK_MS = 20_000;
/** Vigía con radio o videos sin mirar y sin vueltas por más de esto está atrasada. */
export const AGENT_LATE_MS = 15_000;

/* ───────────────────────────── Formato ───────────────────────────── */

/** Duración corta: "850 ms", "2,1 s", "1 min 5 s". */
export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  const v = Math.max(0, ms);
  if (v < 1000) return `${Math.round(v)} ms`;
  if (v < 60_000) return `${formatNumber(v / 1000, v < 10_000 ? 1 : 0)} s`;
  const m = Math.floor(v / 60_000);
  const s = Math.round((v % 60_000) / 1000);
  return s > 0 ? `${m} min ${s} s` : `${m} min`;
}

/** Hace cuánto, exacto en segundos (a diferencia de timeAgo, que dice "recién" bajo 10 s). */
export function agoText(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return "nunca";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const d = Math.max(0, nowMs - t);
  if (d < 60_000) return `hace ${Math.floor(d / 1000)} s`;
  if (d < 3600_000) {
    const m = Math.floor(d / 60_000);
    const s = Math.floor((d % 60_000) / 1000);
    return m < 10 && s > 0 ? `hace ${m} min ${s} s` : `hace ${m} min`;
  }
  return `hace ${Math.floor(d / 3600_000)} h`;
}

export function ageMs(iso: string | null | undefined, nowMs: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, nowMs - t) : null;
}

/** "claude-opus-5-5" → "opus-5-5" (para la banda; el detalle muestra el nombre completo). */
export function shortModel(model: string): string {
  return model.replace(/^claude-/, "");
}

/** Tokens cortos: "206", "1,5 k", "123 k". */
export function formatTokens(n: number | null): string {
  if (n === null) return "—";
  if (n < 1000) return formatNumber(n);
  return `${formatNumber(n / 1000, n < 100_000 ? 1 : 0)} k`;
}

/* ───────────────────────────── Rótulos ───────────────────────────── */

export const TASK_LABEL: Record<string, string> = {
  agente: "Vigía",
  media: "Video",
  situation: "Informe",
  scene: "Escena",
  comms: "Radio",
  live: "Dron en vivo",
  ask: "Pregunta",
};

export const SOURCE_LABEL: Record<DiagnosticsErrorSource, string> = {
  agente: "Agente",
  transcripcion: "Transcripción",
  subida: "Subida",
  puente: "Puente Zello",
  analisis: "Análisis",
  detector: "Detector",
  dron: "Dron",
  api: "Servidor",
};

/** Motivos de las reglas duras (src/lib/vigia/rules.ts). */
export const RULE_LABEL: Record<string, string> = {
  ausencia: "«no hay nadie» → «no veo»",
  orden_a_unidad: "orden a una unidad",
  orden: "orden",
  decision_tactica: "decisión táctica",
};

export function ruleLabel(code: string): string {
  return RULE_LABEL[code] ?? code.replace(/_/g, " ");
}

export const UTTERANCE_STATE_LABEL: Record<DiagnosticsUtterance["state"], string> = {
  en_cola: "en cola para la radio",
  dicho: "dicho por radio",
  salio: "salió de la cola",
  sin_puente: "sin puente que lo diga",
  pantalla: "solo pantalla",
};

export const SCREEN_REASON_LABEL: Record<NonNullable<DiagnosticsUtterance["screen_reason"]>, string> = {
  limite_20s: "límite de 20 s",
  silencio: "silencio del OBAC",
  propuesta: "propuesta (no se transmite)",
  pantalla: "solo pantalla",
};

export const UTTERANCE_STATE_TONE: Record<DiagnosticsUtterance["state"], DiagTone> = {
  en_cola: "warning",
  dicho: "ok",
  salio: "muted",
  sin_puente: "critical",
  pantalla: "muted",
};

/* ───────────────────────────── Zello ───────────────────────────── */

export type ZelloState = "conectado" | "solo_escucha" | "detenido" | "sin_latido" | "desconectado" | "sin_puente";

export const ZELLO_STATE_LABEL: Record<ZelloState, string> = {
  conectado: "Conectado",
  solo_escucha: "Solo escucha",
  detenido: "Detenido",
  sin_latido: "Sin latido",
  desconectado: "Desconectado",
  sin_puente: "Sin puente",
};

export const ZELLO_STATE_TONE: Record<ZelloState, DiagTone> = {
  conectado: "ok",
  solo_escucha: "warning",
  detenido: "muted",
  sin_latido: "critical",
  desconectado: "critical",
  sin_puente: "muted",
};

/** Edad del último latido según la hora del servidor; null si nunca llegó uno. */
export function heartbeatAgeMs(z: ZelloStatusResponse, nowMs: number): number | null {
  return ageMs(z.received_at, nowMs);
}

/** El último latido tiene más de 30 s (o el servidor ya lo dio por perdido). */
export function heartbeatLate(z: ZelloStatusResponse, nowMs: number): boolean {
  const age = heartbeatAgeMs(z, nowMs);
  return z.stale || age === null || age > HEARTBEAT_STALE_MS;
}

export function zelloState(z: ZelloStatusResponse, nowMs: number): ZelloState {
  const s = z.status;
  if (!s) return "sin_puente";
  if (s.stopped) return "detenido";
  if (heartbeatLate(z, nowMs)) return "sin_latido";
  if (!s.connected) return "desconectado";
  if (s.listen_only) return "solo_escucha";
  return "conectado";
}

function zelloStatus(z: ZelloStatusResponse, nowMs: number): SubsystemStatus {
  const st = zelloState(z, nowMs);
  const beat = z.received_at ? `latido ${agoText(z.received_at, nowMs)}` : "nunca hubo latido";
  const value =
    st === "sin_puente"
      ? "sin puente"
      : st === "sin_latido"
        ? `sin latido ${agoText(z.received_at, nowMs)}`
        : st === "desconectado"
          ? `desconectado · ${beat}`
          : `${ZELLO_STATE_LABEL[st].toLowerCase()} · ${beat}`;
  return { id: "zello", label: "Zello", tone: ZELLO_STATE_TONE[st], value, hint: zelloLine(z).hint };
}

/* ───────────────────────────── Motor ───────────────────────────── */

function engineStatus(d: IncidentDiagnostics): SubsystemStatus {
  const e = d.engine;
  if (e.ai === "simulated") {
    const why = e.forced_simulated
      ? "VIGIA_AI=simulated lo fuerza aunque haya credencial"
      : "no hay credencial de Anthropic en el servidor";
    return {
      id: "motor",
      label: "Motor",
      tone: "warning",
      value: "SIMULADO",
      hint: `Motor simulado: ${why}. Los análisis son de demostración (no salen de los videos) y Vigía responde con plantillas.`,
    };
  }
  return {
    id: "motor",
    label: "Motor",
    tone: "ok",
    value: `Claude · ${shortModel(e.analysis.model)}`,
    hint: `Claude real. Análisis: ${e.analysis.model}${e.analysis.fast ? " (rápido)" : ""}. Vigía: ${
      e.agent.enabled ? e.agent.model : "apagado"
    }. Dron en vivo: ${e.live.model}.`,
  };
}

/* ───────────────────────────── Claude ───────────────────────────── */

export function callError(c: DiagnosticsClaudeCall): string {
  return c.status !== null ? `HTTP ${c.status}` : "error";
}

function claudeStatus(d: IncidentDiagnostics): SubsystemStatus {
  const c = d.claude;
  const base = { id: "claude" as const, label: "Claude" };
  if (d.engine.ai === "simulated" && c.total === 0) {
    return { ...base, tone: "muted", value: "sin uso (simulado)", hint: "Con el motor simulado no se llama a Claude." };
  }
  const last = c.calls[0];
  if (!last) {
    return { ...base, tone: "muted", value: "sin llamadas aún", hint: "Esta instancia del servidor no ha llamado a Claude desde que arrancó." };
  }
  const p50 = c.p50_ms !== null ? ` · p50 ${formatMs(c.p50_ms)}` : "";
  const hint = `${c.total} llamadas registradas, ${c.errors} con error. Mediana ${formatMs(c.p50_ms)}, máxima ${formatMs(c.max_ms)}.`;
  if (!last.ok) {
    return { ...base, tone: "critical", value: `última falló (${callError(last)})`, hint: `${last.error ?? "Error"}. ${hint}` };
  }
  const recentErrors = c.calls.filter((x) => !x.ok).length;
  if (recentErrors > 0) {
    return { ...base, tone: "warning", value: `${recentErrors} de ${c.calls.length} fallaron`, hint };
  }
  if (last.ms > SLOW_CALL_MS) {
    return { ...base, tone: "warning", value: `lenta: ${formatMs(last.ms)}`, hint };
  }
  return { ...base, tone: "ok", value: `${formatMs(last.ms)}${p50}`, hint };
}

/* ───────────────────────────── Detector ───────────────────────────── */

/** Atraso de YOLO: entre el último cuadro recibido y el último cuadro detectado. */
export function liveLagMs(f: DiagnosticsLiveFeed): number | null {
  if (!f.last_frame_at) return null;
  if (!f.last_detection_at) return null;
  return Math.max(0, Date.parse(f.last_frame_at) - Date.parse(f.last_detection_at));
}

function detectorStatus(d: IncidentDiagnostics, nowMs: number): SubsystemStatus {
  const det = d.detector;
  const base = { id: "detector" as const, label: "Detector" };
  const q = det.media;
  const pendingAge = ageMs(q.oldest_pending?.since, nowMs);
  const mediaLate = pendingAge !== null && pendingAge > MEDIA_LATE_MS;
  const queueText = q.oldest_pending ? `${q.queued + q.analyzing + q.uploading} en cola` : "cola vacía";
  if (!det.configured) {
    const hint = "Sin VIGIA_DETECTOR_URL: los videos van directo a Claude con visión y el dron en vivo no pasa por YOLO.";
    if (mediaLate) {
      return { ...base, tone: "warning", value: `sin YOLO · ${q.oldest_pending?.label} espera ${agoText(q.oldest_pending?.since, nowMs).replace("hace ", "")}`, hint };
    }
    return { ...base, tone: "muted", value: `sin YOLO · ${queueText}`, hint };
  }
  if (det.healthy === false) {
    return { ...base, tone: "critical", value: "no responde", hint: "El detector YOLO no responde /health: el análisis sigue sin él (Claude con visión)." };
  }
  const lagging = det.live.filter((f) => f.receiving && (f.last_detection_at === null || (liveLagMs(f) ?? 0) > LIVE_LAG_MS));
  if (lagging.length > 0) {
    const f = lagging[0];
    const lag = liveLagMs(f);
    return {
      ...base,
      tone: "warning",
      value: lag === null ? `${f.label}: sin detecciones` : `${f.label} atrasado ${formatMs(lag)}`,
      hint: "Llegan cuadros en vivo pero YOLO no da abasto o no responde.",
    };
  }
  if (mediaLate) {
    return {
      ...base,
      tone: "warning",
      value: `${q.oldest_pending?.label} espera ${agoText(q.oldest_pending?.since, nowMs).replace("hace ", "")}`,
      hint: "Hay videos esperando análisis hace más de 2 minutos.",
    };
  }
  if (q.failed > 0) {
    return { ...base, tone: "warning", value: `sano · ${q.failed} ${q.failed === 1 ? "video falló" : "videos fallaron"}`, hint: q.last_failed?.error ?? "" };
  }
  const live = det.live.find((f) => f.receiving);
  return {
    ...base,
    tone: "ok",
    value: live ? `sano · ${live.label} al día` : `sano · ${queueText}`,
    hint: `YOLO responde (${det.labels} etiquetas).`,
  };
}

/* ───────────────────────────── Salida de Vigía ───────────────────────────── */

/** Cuándo vuelve a poder hablar según la regla de los 20 s (null = ya puede). */
export function voiceFreeInMs(d: IncidentDiagnostics, nowMs: number): number | null {
  const o = d.outbox;
  const times = [o.last_spoken_at, o.bridge_spoken?.at ?? null]
    .map((t) => (t ? Date.parse(t) : NaN))
    .filter((t) => Number.isFinite(t));
  if (times.length === 0) return null;
  const left = Math.max(...times) + o.voice_interval_ms - nowMs;
  return left > 0 ? left : null;
}

function outboxStatus(d: IncidentDiagnostics, nowMs: number): SubsystemStatus {
  const o = d.outbox;
  const base = { id: "salida" as const, label: "Vigía" };
  if (!o.agent_enabled) {
    return { ...base, tone: "muted", value: "agente apagado", hint: "VIGIA_AGENT=0: Vigía no escucha ni habla." };
  }
  if (o.last_error) {
    return { ...base, tone: "critical", value: "última vuelta falló", hint: o.last_error };
  }
  const oldestWaiting = o.waiting[0];
  const waitAge = ageMs(oldestWaiting?.at, nowMs);
  if (oldestWaiting && waitAge !== null && waitAge > OUTBOX_STUCK_MS) {
    return {
      ...base,
      tone: "warning",
      value: `${o.waiting.length} en cola hace ${formatMs(waitAge)}`,
      hint: "Hay mensajes de voz que el puente no ha dicho: ¿alguien tiene tomado el PTT o el puente no habla?",
    };
  }
  // Solo si alguna vez hubo un puente: sin Zello en la demo, que no se diga por radio es lo esperado.
  const unsaid = o.recent.filter((u) => u.state === "sin_puente" && (ageMs(u.at, nowMs) ?? Infinity) < 120_000);
  if (d.zello.status && unsaid.length > 0) {
    return { ...base, tone: "warning", value: `${unsaid.length} sin puente que los diga`, hint: "Vigía quiere hablar pero el puente Zello no está en línea o solo escucha." };
  }
  const lastTurnAge = ageMs(o.last_turn?.at, nowMs);
  if ((o.unread_comms > 0 || o.unseen_media > 0) && lastTurnAge !== null && lastTurnAge > AGENT_LATE_MS) {
    return {
      ...base,
      tone: "warning",
      value: `atrasada · ${o.unread_comms} radio, ${o.unseen_media} videos sin mirar`,
      hint: `La última vuelta del agente fue ${agoText(o.last_turn?.at, nowMs)}.`,
    };
  }
  if (o.silenced) {
    return { ...base, tone: "warning", value: "en silencio (solo pantalla)", hint: "El OBAC pidió silencio: solo habla por radio una posible persona." };
  }
  const free = voiceFreeInMs(d, nowMs);
  const voice = free === null ? "voz libre" : `voz en ${Math.ceil(free / 1000)} s`;
  const queue = o.waiting.length > 0 ? `${o.waiting.length} en cola · ` : "";
  return {
    ...base,
    tone: "ok",
    value: o.thinking ? `pensando… · ${voice}` : `${queue}${voice}`,
    hint: o.status_line,
  };
}

/* ───────────────────────────── Errores ───────────────────────────── */

function errorsStatus(d: IncidentDiagnostics, nowMs: number): SubsystemStatus {
  const base = { id: "errores" as const, label: "Errores" };
  const last = d.errors[0];
  const age = ageMs(last?.at, nowMs);
  if (!last || age === null || age > ERROR_WARN_MS) {
    return { ...base, tone: "ok", value: d.errors.length > 0 ? "nada en 15 min" : "sin errores", hint: "Errores del servidor registrados en esta instancia." };
  }
  const recent = d.errors.filter((e) => (ageMs(e.at, nowMs) ?? Infinity) <= ERROR_WARN_MS).length;
  return {
    ...base,
    tone: age <= ERROR_CRITICAL_MS ? "critical" : "warning",
    value: `${recent} · último ${agoText(last.at, nowMs)} (${SOURCE_LABEL[last.source]})`,
    hint: last.message,
  };
}

/* ───────────────────────────── Banda ───────────────────────────── */

/** Un estado por subsistema, en el orden de la banda. */
export function subsystems(d: IncidentDiagnostics, nowMs: number): SubsystemStatus[] {
  return [
    engineStatus(d),
    zelloStatus(d.zello, nowMs),
    claudeStatus(d),
    detectorStatus(d, nowMs),
    outboxStatus(d, nowMs),
    errorsStatus(d, nowMs),
  ];
}

const TONE_RANK: Record<DiagTone, number> = { critical: 3, warning: 2, ok: 1, muted: 0 };

/** El peor tono de la lista (para el título de la pestaña o un resumen). */
export function worstTone(list: readonly { tone: DiagTone }[]): DiagTone {
  return list.reduce<DiagTone>((worst, s) => (TONE_RANK[s.tone] > TONE_RANK[worst] ? s.tone : worst), "muted");
}
