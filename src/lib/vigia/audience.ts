/**
 * Cuántas páginas de grabación (/reportar/<código>) están abiertas ahora en una emergencia.
 * Lo usa pedir_video para decirle al OBAC a cuántas personas les llegó el pedido.
 * En memoria del proceso: con varias instancias es aproximado, y se dice así.
 */
type GlobalWithAudience = typeof globalThis & { __vigiaAudience?: Map<string, Map<string, number>> };

function audiences(): Map<string, Map<string, number>> {
  const g = globalThis as GlobalWithAudience;
  g.__vigiaAudience ??= new Map();
  return g.__vigiaAudience;
}

/** La página de un vecino consultó los pedidos de video. `viewer` identifica la pestaña. */
export function notePublicViewer(incidentId: string, viewer: string, nowMs = Date.now()): void {
  let m = audiences().get(incidentId);
  if (!m) {
    m = new Map();
    audiences().set(incidentId, m);
  }
  m.set(viewer.slice(0, 64), nowMs);
  if (m.size > 500) {
    for (const [k, at] of m) if (nowMs - at > 120_000) m.delete(k);
  }
}

/** Páginas que consultaron en la última ventana (por defecto 45 s). */
export function countPublicViewers(incidentId: string, nowMs = Date.now(), windowMs = 45_000): number {
  const m = audiences().get(incidentId);
  if (!m) return 0;
  let n = 0;
  for (const at of m.values()) if (nowMs - at <= windowMs) n += 1;
  return n;
}
