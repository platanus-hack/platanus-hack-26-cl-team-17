/**
 * Lo que la mesa de mando, el puente y la página pública ven de la memoria de Vigía. Puro.
 */
import type { PublicVideoRequest, VigiaSalida, VigiaState, VigiaView } from "./types";

export function toVigiaView(state: VigiaState, engine: VigiaView["engine"], nowMs: number): VigiaView {
  return {
    rev: state.rev,
    engine,
    silenced: state.silenced,
    status: state.status,
    utterances: state.utterances.slice(-40).reverse(),
    actions: state.actions.slice(-12).reverse(),
    pending: state.pending.filter((p) => p.status === "abierto"),
    video_requests: state.video_requests.filter((r) => Date.parse(r.expires_at) > nowMs),
    log: state.log.slice(-40).reverse(),
    parte: state.parte,
    server_time: new Date(nowMs).toISOString(),
  };
}

/** Mensajes con seq mayor a `after` (todos si es null), en orden. */
export function toSalida(state: VigiaState, after: number | null): VigiaSalida {
  const items = state.utterances.filter((u) => after === null || u.seq > after);
  return { items, last_seq: state.seq };
}

export function publicVideoRequests(state: VigiaState, nowMs: number): PublicVideoRequest[] {
  return state.video_requests
    .filter((r) => Date.parse(r.expires_at) > nowMs)
    .map((r) => ({ id: r.id, text: r.text, zone: r.zone, at: r.at, expires_at: r.expires_at }));
}
