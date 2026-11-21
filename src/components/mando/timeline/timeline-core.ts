/**
 * Lógica pura de la línea de tiempo: filtros, agrupación de ráfagas del dron y detección de
 * eventos nuevos. Sin React, para poder probarla con node:test.
 */
import type { TimelineEvent, TimelineKind } from "@/lib/domain";

/* ═══════════════════════════ Filtros ═══════════════════════════ */

export type TimelineFilter = "all" | "alerts" | "media" | "comms" | "drone";

export const TIMELINE_FILTERS: readonly TimelineFilter[] = ["all", "alerts", "media", "comms", "drone"];

export const timelineFilterLabel: Record<TimelineFilter, string> = {
  all: "Todo",
  alerts: "Alertas",
  media: "Videos",
  comms: "Radio",
  drone: "Dron",
};

const ALERT_KINDS: ReadonlySet<TimelineKind> = new Set<TimelineKind>(["alert", "comms_alert", "media_failed", "error"]);
const MEDIA_KINDS: ReadonlySet<TimelineKind> = new Set<TimelineKind>(["media_received", "media_analyzed", "media_failed"]);
const COMMS_KINDS: ReadonlySet<TimelineKind> = new Set<TimelineKind>(["comms", "comms_alert"]);

/** Alerta = severidad alta o tipo de alerta/error (un error de análisis también requiere atención). */
export function isAlertEvent(e: TimelineEvent): boolean {
  return e.severity === "warning" || e.severity === "critical" || ALERT_KINDS.has(e.kind);
}

export function matchesFilter(e: TimelineEvent, filter: TimelineFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "alerts":
      return isAlertEvent(e);
    case "media":
      return MEDIA_KINDS.has(e.kind) || e.media_id !== null;
    case "comms":
      return COMMS_KINDS.has(e.kind) || e.comm_id !== null;
    case "drone":
      return e.kind === "drone" || e.mission_id !== null;
  }
}

/** Filtra sin reordenar (el orden de entrada manda: recientes primero). "all" devuelve el mismo arreglo. */
export function filterEvents(events: readonly TimelineEvent[], filter: TimelineFilter): readonly TimelineEvent[] {
  if (filter === "all") return events;
  return events.filter((e) => matchesFilter(e, filter));
}

export interface FilterCounts {
  counts: Record<TimelineFilter, number>;
  /** Hay al menos un evento crítico entre las alertas. */
  hasCritical: boolean;
}

/** Conteos de todos los filtros en una sola pasada. */
export function countByFilter(events: readonly TimelineEvent[]): FilterCounts {
  const counts: Record<TimelineFilter, number> = { all: events.length, alerts: 0, media: 0, comms: 0, drone: 0 };
  let hasCritical = false;
  for (const e of events) {
    if (matchesFilter(e, "alerts")) counts.alerts += 1;
    if (matchesFilter(e, "media")) counts.media += 1;
    if (matchesFilter(e, "comms")) counts.comms += 1;
    if (matchesFilter(e, "drone")) counts.drone += 1;
    if (e.severity === "critical") hasCritical = true;
  }
  return { counts, hasCritical };
}

/* ═══════════════════════════ Texto ═══════════════════════════ */

/** Sufijo que el pipeline agrega a lo producido por el motor de reglas. */
const ENGINE_NOTE = " (motor de reglas, sin modelo)";

/**
 * Separa el sufijo del motor de reglas para mostrarlo como rótulo "Simulado" en vez de texto.
 * Reconoce también el sufijo cortado por el recorte del detalle (" (motor de re…").
 */
export function splitEngineNote(text: string): { text: string; simulated: boolean } {
  const t = text.trimEnd();
  if (t.endsWith(ENGINE_NOTE)) return { text: t.slice(0, -ENGINE_NOTE.length), simulated: true };
  if (t.endsWith("…")) {
    const at = t.lastIndexOf(" (");
    const tail = at >= 0 ? t.slice(at, -1) : "";
    if (tail.length >= 4 && ENGINE_NOTE.startsWith(tail)) return { text: `${t.slice(0, at)}…`, simulated: true };
  }
  return { text, simulated: false };
}

/* ═══════════════════════════ Agrupación ═══════════════════════════ */

/** Largo mínimo de una racha de eventos triviales del dron para plegarla en una fila. */
export const MIN_DRONE_BURST = 3;

/** Evento de rutina del dron: informativo y sin medio ni radio asociados (avisos y alertas nunca se pliegan). */
export function isTrivialDroneEvent(e: TimelineEvent): boolean {
  return e.kind === "drone" && e.severity === "info" && e.media_id === null && e.comm_id === null;
}

export interface TimelineEventRow {
  type: "event";
  key: string;
  event: TimelineEvent;
}

export interface TimelineBurstRow {
  type: "drone-burst";
  /** Estable mientras la racha crece por arriba: se basa en su evento más antiguo. */
  key: string;
  /** En el mismo orden de entrada (recientes primero). */
  events: TimelineEvent[];
  newestAt: string;
  oldestAt: string;
  missionIds: string[];
}

export type TimelineRow = TimelineEventRow | TimelineBurstRow;

/** Recorre una vez la lista y pliega rachas consecutivas de eventos triviales del dron (≥ minRun). */
export function groupTimeline(events: readonly TimelineEvent[], minRun = MIN_DRONE_BURST): TimelineRow[] {
  const rows: TimelineRow[] = [];
  let run: TimelineEvent[] = [];

  const flush = () => {
    if (run.length === 0) return;
    if (run.length >= minRun) {
      const oldest = run[run.length - 1];
      const missionIds: string[] = [];
      for (const e of run) {
        if (e.mission_id !== null && !missionIds.includes(e.mission_id)) missionIds.push(e.mission_id);
      }
      rows.push({
        type: "drone-burst",
        key: `burst:${oldest.id}`,
        events: run,
        newestAt: run[0].at,
        oldestAt: oldest.at,
        missionIds,
      });
    } else {
      for (const e of run) rows.push({ type: "event", key: e.id, event: e });
    }
    run = [];
  };

  for (const e of events) {
    if (isTrivialDroneEvent(e)) {
      run.push(e);
      continue;
    }
    flush();
    rows.push({ type: "event", key: e.id, event: e });
  }
  flush();
  return rows;
}

/* ═══════════════════════════ Eventos nuevos ═══════════════════════════ */

export interface SeenState {
  /** Arreglo recibido la última vez (para detectar cambios por identidad). */
  source: readonly TimelineEvent[];
  seen: ReadonlySet<string>;
  /** Ids que llegaron en la última actualización con novedades. */
  fresh: ReadonlySet<string>;
  /** Ya se registró la primera carga con eventos (que nunca se resalta). */
  baseline: boolean;
}

const EMPTY_IDS: ReadonlySet<string> = new Set<string>();

export function initSeen(events: readonly TimelineEvent[]): SeenState {
  return {
    source: events,
    seen: new Set(events.map((e) => e.id)),
    fresh: EMPTY_IDS,
    baseline: events.length > 0,
  };
}

/**
 * Avanza el registro de vistos. La primera lista no vacía es la base (no se resalta todo al abrir);
 * después, solo los ids nunca vistos quedan como nuevos. Un sondeo sin novedades mantiene el
 * resaltado vigente para que no se corte antes de tiempo.
 */
export function advanceSeen(state: SeenState, events: readonly TimelineEvent[]): SeenState {
  if (state.source === events) return state;
  if (!state.baseline) {
    if (events.length === 0) return { ...state, source: events };
    return initSeen(events);
  }
  const added: string[] = [];
  for (const e of events) if (!state.seen.has(e.id)) added.push(e.id);
  if (added.length === 0) return { ...state, source: events };
  const seen = new Set(state.seen);
  for (const id of added) seen.add(id);
  return { source: events, seen, fresh: new Set(added), baseline: true };
}

/** Quita el resaltado si sigue siendo el mismo conjunto (otra novedad pudo reemplazarlo). */
export function clearFresh(state: SeenState, fresh: ReadonlySet<string>): SeenState {
  if (state.fresh !== fresh || fresh.size === 0) return state;
  return { ...state, fresh: EMPTY_IDS };
}
