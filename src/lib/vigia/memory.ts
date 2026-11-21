/**
 * Cambios de una vuelta del agente sobre su memoria. Puro.
 *
 * La vuelta trabaja sobre una copia y anota operaciones; al final se aplican sobre el
 * estado recién leído (otra petición pudo agregar una pregunta mientras el modelo pensaba).
 * Aquí se asigna el seq de cada mensaje y se decide, con las reglas duras, si va por voz.
 */
import { speechAllowed } from "./rules";
import {
  MAX_ACTIONS,
  MAX_LOG,
  MAX_QUESTIONS,
  MAX_UTTERANCES,
  type VigiaAction,
  type VigiaCursors,
  type VigiaLogEntry,
  type VigiaParte,
  type VigiaPending,
  type VigiaQuestion,
  type VigiaState,
  type VigiaStatus,
  type VigiaUtterance,
  type VigiaVideoRequest,
} from "./types";

export type NewUtterance = Omit<VigiaUtterance, "seq" | "speak"> & { speak?: boolean };

export type VigiaOp =
  | { op: "utter"; u: NewUtterance }
  | { op: "action"; a: VigiaAction }
  | { op: "log"; l: VigiaLogEntry }
  | { op: "pending_add"; p: VigiaPending }
  | { op: "pending_resolve"; id: string; by: string; at: string }
  | { op: "pending_reminded"; id: string; at: string }
  | { op: "video_request"; r: VigiaVideoRequest }
  | { op: "question_add"; q: VigiaQuestion }
  | { op: "answered"; id: string }
  | { op: "parte"; parte: VigiaParte }
  | { op: "silence"; on: boolean }
  | { op: "introduced" }
  | { op: "cursors"; cursors: VigiaCursors }
  | { op: "status"; status: VigiaStatus }
  | { op: "error"; message: string | null };

function cap<T>(list: T[], max: number): T[] {
  return list.length > max ? list.slice(list.length - max) : list;
}

/** Aplica las operaciones en orden. Devuelve los mensajes nuevos con su seq final. */
export function applyOps(state: VigiaState, ops: VigiaOp[], nowMs: number): VigiaUtterance[] {
  const added: VigiaUtterance[] = [];
  for (const o of ops) {
    switch (o.op) {
      case "utter": {
        const lastSpoken = state.last_spoken_at ? Date.parse(state.last_spoken_at) : null;
        const wanted = o.u.speak !== false && o.u.kind !== "propuesta";
        const speak =
          wanted && speechAllowed({ priority: o.u.priority, lastSpokenAt: lastSpoken, now: nowMs, silenced: state.silenced });
        state.seq += 1;
        const u: VigiaUtterance = { ...o.u, seq: state.seq, speak };
        if (speak) state.last_spoken_at = new Date(nowMs).toISOString();
        state.utterances = cap([...state.utterances, u], MAX_UTTERANCES);
        added.push(u);
        break;
      }
      case "action":
        state.actions = cap([...state.actions, o.a], MAX_ACTIONS);
        break;
      case "log":
        state.log = cap([...state.log, o.l], MAX_LOG);
        break;
      case "pending_add":
        // Un mismo recurso pedido dos veces (la unidad y la Central que lo repite) es un solo pendiente.
        if (!state.pending.some((p) => p.status === "abierto" && p.clave !== null && p.clave === o.p.clave)) {
          state.pending = [...state.pending, o.p];
        }
        break;
      case "pending_resolve":
        state.pending = state.pending.map((p) =>
          p.id === o.id && p.status === "abierto" ? { ...p, status: "resuelto", resolved_at: o.at, resolved_by: o.by } : p,
        );
        break;
      case "pending_reminded":
        state.pending = state.pending.map((p) => (p.id === o.id ? { ...p, reminded_at: o.at } : p));
        break;
      case "video_request":
        state.video_requests = [...state.video_requests.filter((r) => Date.parse(r.expires_at) > nowMs), o.r];
        break;
      case "question_add":
        if (!state.questions.some((q) => q.id === o.q.id || (q.comm_seq !== null && q.comm_seq === o.q.comm_seq))) {
          state.questions = cap([...state.questions, o.q], MAX_QUESTIONS);
        }
        break;
      case "answered":
        state.questions = state.questions.map((q) => (q.id === o.id ? { ...q, answered: true } : q));
        break;
      case "parte":
        state.parte = o.parte;
        break;
      case "silence":
        state.silenced = o.on;
        break;
      case "introduced":
        state.introduced = true;
        break;
      case "cursors":
        state.cursors = o.cursors;
        break;
      case "status":
        state.status = o.status;
        break;
      case "error":
        state.last_error = o.message;
        break;
    }
  }
  return added;
}

/** Mensajes parecidos dichos hace poco (para no repetirse). */
export function recentlySaid(state: VigiaState, text: string, nowMs: number, windowMs = 180_000): VigiaUtterance | null {
  const norm = (s: string) =>
    s
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/^obac,?\s*vigia:?\s*/, "")
      .replace(/[^a-z0-9 ]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  const target = norm(text);
  for (let i = state.utterances.length - 1; i >= 0; i--) {
    const u = state.utterances[i];
    if (nowMs - Date.parse(u.at) > windowMs) break;
    if (norm(u.text) === target) return u;
  }
  return null;
}
