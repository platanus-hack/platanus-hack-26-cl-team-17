/**
 * Qué cambió desde la última vez que Vigía miró. Puro: compara lo que tiene a la vista
 * (World) con su memoria (cursores) y devuelve los eventos que lo despiertan, más lo que
 * se resuelve sin modelo (pendientes de radio, silencio).
 */
import type { LiveInsightView } from "@/lib/contract";
import type { SituationReport } from "@/lib/domain";
import { newId } from "@/lib/ids";
import { CRITICAL_LABELS } from "@/lib/vision/types";
import { confirmsRequest, radioRequests } from "./radio";
import { detectSilenceCommand, fold } from "./rules";
import type { VigiaCursors, VigiaPending, VigiaQuestion, VigiaState } from "./types";
import type { World, WorldMedia, WorldRadio } from "./world";

export type Insight = SituationReport["insights"][number];
export type Contradiction = SituationReport["contradictions"][number];

export type VigiaEvent =
  | { type: "inicio" }
  | { type: "pregunta"; question: VigiaQuestion }
  | { type: "radio"; lines: WorldRadio[] }
  | { type: "video_nuevo"; media: WorldMedia[] }
  | { type: "video_analizado"; media: WorldMedia[] }
  | {
      type: "situacion";
      trapped: { from: string | null; to: string } | null;
      insights: Insight[];
      contradictions: Contradiction[];
    }
  | { type: "dron"; label: string; insights: LiveInsightView[] }
  | { type: "dron_yolo"; label: string; seq: number; at: string; found: { label: string; conf: number; count: number; pose: string | null }[] }
  | { type: "pendiente_vencido"; pending: VigiaPending[] }
  | { type: "reloj"; radio: WorldRadio[] };

export interface ObserveOptions {
  /** Cada cuánto resume la radio y repasa lo pendiente (si pasó algo). */
  clockMs: number;
  /** Desde cuándo un pedido sin confirmar se recuerda (y cada cuánto se vuelve a recordar). */
  remindMs: number;
}

export const DEFAULT_OBSERVE: ObserveOptions = { clockMs: 120_000, remindMs: 180_000 };

/** Ventana en que varias radios cuentan como "a la vez" y silencio tras el que se resume. */
const BURST_MS = 45_000;
const QUIET_MS = 4_000;

/** Confianza mínima de YOLO en vivo para despertar a Vigía (fuego y humo puntúan bajo). */
const LIVE_ALERT_CONF: Record<string, number> = { persona: 0.5, fuego: 0.25, humo: 0.25, cilindro_gas: 0.35, cable_caido: 0.3 };

export interface Observation {
  events: VigiaEvent[];
  cursors: VigiaCursors;
  /** Pedidos nuevos detectados en la radio. */
  newPending: VigiaPending[];
  /** Pendientes que la radio confirmó: id → "C<seq>". */
  resolved: { id: string; by: string }[];
  /** Preguntas del OBAC por Zello (se agregan a la memoria). */
  newQuestions: VigiaQuestion[];
  /** Orden de silencio o de volver a hablar del OBAC. */
  silence: "silence" | "resume" | null;
}

const TRAPPED_ALERT = new Set(["possible", "probable", "confirmed"]);

function key(text: string): string {
  return fold(text).replace(/\s+/g, " ").trim().slice(0, 120);
}

export function observe(world: World, state: VigiaState, nowMs: number, opts: ObserveOptions = DEFAULT_OBSERVE): Observation {
  const cursors: VigiaCursors = structuredClone(state.cursors);
  const events: VigiaEvent[] = [];
  const newPending: VigiaPending[] = [];
  const resolved: { id: string; by: string }[] = [];
  const newQuestions: VigiaQuestion[] = [];
  let silence: Observation["silence"] = null;

  if (!state.introduced) events.push({ type: "inicio" });

  /* Radio */
  const fresh = world.radio.filter((r) => r.seq > cursors.comm_seq);
  const heard: WorldRadio[] = [];
  for (const line of fresh) {
    if (line.obac) {
      const cmd = detectSilenceCommand(line.text);
      if (cmd) silence = cmd;
      newQuestions.push({
        id: newId(),
        at: line.at,
        text: line.text,
        from: "zello",
        comm_seq: line.seq,
        reply_to: null,
        // Una orden de silencio no necesita respuesta hablada.
        answered: cmd !== null,
      });
      continue;
    }
    heard.push(line);
    for (const req of radioRequests(line.text)) {
      newPending.push({
        id: newId(),
        at: line.at,
        text: `${line.speaker || "Sin identificar"} pidió ${req.text}`,
        who: line.speaker || "Sin identificar",
        clave: req.clave,
        source: `C${line.seq}`,
        status: "abierto",
        resolved_at: null,
        resolved_by: null,
        reminded_at: null,
      });
    }
  }
  if (fresh.length > 0) cursors.comm_seq = Math.max(cursors.comm_seq, ...fresh.map((r) => r.seq));
  if (heard.length > 0) events.push({ type: "radio", lines: heard });

  // Confirmaciones: una línea posterior al pedido que lo confirma.
  const open = [...state.pending.filter((p) => p.status === "abierto"), ...newPending];
  for (const p of open) {
    const fromSeq = Number(p.source.replace(/^C/, "")) || 0;
    const by = heard.find((l) => l.seq > fromSeq && confirmsRequest(l.text, p.clave, p.text));
    if (by) resolved.push({ id: p.id, by: `C${by.seq}` });
  }

  /* Preguntas del OBAC (Zello y mesa de mando) sin responder */
  for (const q of [...state.questions.filter((x) => !x.answered), ...newQuestions.filter((x) => !x.answered)]) {
    events.push({ type: "pregunta", question: q });
  }

  /* Videos */
  const received: WorldMedia[] = [];
  const analyzed: WorldMedia[] = [];
  for (const m of world.media) {
    const prev = cursors.media[m.id];
    if (prev === m.status) continue;
    if (m.status === "analyzed" && m.analysis?.usable !== false) analyzed.push(m);
    else if (prev === undefined && m.status !== "failed") received.push(m);
    cursors.media[m.id] = m.status;
  }
  if (received.length > 0) events.push({ type: "video_nuevo", media: received });
  if (analyzed.length > 0) events.push({ type: "video_analizado", media: analyzed });

  /* Informe de situación (fusión) */
  const sit = world.situation;
  if (sit && world.situation_at && world.situation_at !== cursors.situation_at) {
    cursors.situation_at = world.situation_at;
    const seen = new Set(cursors.seen_insights);
    const insights = sit.insights.filter((i) => !seen.has(key(i.title)) && (i.priority === "critical" || i.priority === "high"));
    for (const i of sit.insights) seen.add(key(i.title));
    cursors.seen_insights = [...seen].slice(-200);

    const seenC = new Set(cursors.seen_contradictions);
    const contradictions = sit.contradictions.filter((c) => !seenC.has(key(c.description)));
    for (const c of sit.contradictions) seenC.add(key(c.description));
    cursors.seen_contradictions = [...seenC].slice(-100);

    const status = sit.trapped.status;
    const trapped =
      status !== cursors.trapped_status && (TRAPPED_ALERT.has(status) || TRAPPED_ALERT.has(cursors.trapped_status ?? ""))
        ? { from: cursors.trapped_status, to: status }
        : null;
    cursors.trapped_status = status;
    if (trapped || insights.length > 0 || contradictions.length > 0) {
      events.push({ type: "situacion", trapped, insights, contradictions });
    }
  }

  /* Drones en vivo: observaciones nuevas que importan */
  for (const d of world.drones) {
    const last = cursors.live_insights[d.mission_id] ?? "";
    const newer = d.insights.filter((i) => i.at > last);
    if (newer.length === 0) continue;
    cursors.live_insights[d.mission_id] = newer[0].at;
    const relevant = newer.filter((i) => i.engine !== "error" && (i.changed || i.severity === "warning" || i.severity === "critical"));
    if (relevant.length > 0) events.push({ type: "dron", label: d.label, insights: relevant.slice(0, 3) });
  }

  /* YOLO en vivo del dron: aparece algo crítico que no estaba (persona, fuego, humo, gas, cable) */
  for (const d of world.drones) {
    if (!d.live || d.live.seq <= (cursors.live_seq[d.mission_id] ?? 0)) continue;
    cursors.live_seq[d.mission_id] = d.live.seq;
    const critical = new Map<string, { label: string; conf: number; count: number; pose: string | null }>();
    for (const det of d.live.result.detections) {
      if (!CRITICAL_LABELS.has(det.label) || det.conf < LIVE_ALERT_CONF[det.label]) continue;
      const cur = critical.get(det.label);
      if (cur) {
        cur.count += 1;
        cur.conf = Math.max(cur.conf, det.conf);
        if (det.pose === "tendido") cur.pose = "tendido";
      } else critical.set(det.label, { label: det.label, conf: det.conf, count: 1, pose: det.pose });
    }
    const before = new Set(cursors.live_alerted[d.mission_id] ?? []);
    const fresh = [...critical.values()].filter((c) => !before.has(c.label) || (c.label === "persona" && c.pose === "tendido" && !before.has("persona_tendida")));
    // Lo que deja de verse se olvida, para volver a avisar si reaparece.
    const now = new Set([...critical.keys(), ...([...critical.values()].some((c) => c.pose === "tendido") ? ["persona_tendida"] : [])]);
    cursors.live_alerted[d.mission_id] = [...now];
    if (fresh.length > 0) events.push({ type: "dron_yolo", label: d.label, seq: d.live.seq, at: d.live.at, found: fresh });
  }

  /* Pendientes vencidos */
  const resolvedIds = new Set(resolved.map((r) => r.id));
  const overdue = state.pending.filter(
    (p) =>
      p.status === "abierto" &&
      !resolvedIds.has(p.id) &&
      nowMs - Date.parse(p.at) >= opts.remindMs &&
      // El primer recordatorio al cumplir el plazo; los siguientes, cada dos plazos (no satura).
      (p.reminded_at === null || nowMs - Date.parse(p.reminded_at) >= 2 * opts.remindMs),
  );
  if (overdue.length > 0) events.push({ type: "pendiente_vencido", pending: overdue });

  /*
   * Varias radios a la vez: apenas se callan (QUIET_MS sin transmisiones), un resumen.
   * Es el momento en que el OBAC más necesita que alguien junte lo que dijeron todos.
   */
  const lastClock = cursors.last_clock_at ? Date.parse(cursors.last_clock_at) : null;
  const burst = world.radio.filter((r) => !r.obac && nowMs - Date.parse(r.at) <= BURST_MS);
  const burstSpeakers = new Set(burst.map((r) => r.speaker.trim().toUpperCase()));
  const burstStart = burst.length > 0 ? Math.min(...burst.map((r) => Date.parse(r.at))) : null;
  const burstEnd = burst.length > 0 ? Math.max(...burst.map((r) => Date.parse(r.at))) : null;
  if (
    state.introduced &&
    burstSpeakers.size >= 2 &&
    burstStart !== null &&
    burstEnd !== null &&
    nowMs - burstEnd >= QUIET_MS &&
    (lastClock === null || lastClock < burstStart)
  ) {
    events.push({ type: "reloj", radio: burst });
    cursors.last_clock_at = new Date(nowMs).toISOString();
  } else if (state.introduced && (lastClock === null || nowMs - lastClock >= opts.clockMs)) {
    /* Reloj: resumen de la radio si hubo tráfico desde el último resumen */
    const since = lastClock ?? nowMs - opts.clockMs;
    const recent = world.radio.filter((r) => !r.obac && Date.parse(r.at) > since);
    if (recent.length >= 2 || (lastClock !== null && recent.length > 0)) {
      events.push({ type: "reloj", radio: recent });
      cursors.last_clock_at = new Date(nowMs).toISOString();
    } else if (lastClock === null) {
      cursors.last_clock_at = new Date(nowMs).toISOString();
    }
  }

  return { events, cursors, newPending, resolved, newQuestions, silence };
}

/** true si alguno de los eventos amerita despertar al modelo (el resto se anota sin hablar). */
export function needsTurn(events: VigiaEvent[]): boolean {
  return events.some((e) => e.type !== "video_nuevo");
}
