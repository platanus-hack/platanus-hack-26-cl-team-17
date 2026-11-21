/**
 * Utilidades puras de los medios de un incidente (tira, grilla y visor).
 * Sin React ni globals del navegador: se prueban con node:test.
 */
import type { MediaView } from "@/lib/contract";
import type { MediaStatus, PersonStatus } from "@/lib/domain";

/** Situaciones de persona que el mando debe ver como riesgo (nunca se descartan). */
export const AT_RISK_PERSON_STATUSES: ReadonlySet<PersonStatus> = new Set<PersonStatus>([
  "trapped",
  "at_window_or_balcony",
  "on_roof",
  "injured",
]);

/** true si el análisis del medio ve personas en riesgo o sospecha ocupantes atrapados en un vehículo. */
export function mediaHasPeopleAtRisk(m: Pick<MediaView, "analysis">): boolean {
  const a = m.analysis;
  if (!a) return false;
  const people = Array.isArray(a.people) ? a.people : [];
  if (people.some((p) => AT_RISK_PERSON_STATUSES.has(p.status))) return true;
  const vehicles = Array.isArray(a.vehicles) ? a.vehicles : [];
  return vehicles.some((v) => v.entrapment_suspected);
}

/** Cantidad mínima de personas en riesgo según el análisis (suma de grupos; un grupo con 0 cuenta como 1). */
export function peopleAtRiskCount(m: Pick<MediaView, "analysis">): number {
  const people = m.analysis?.people ?? [];
  return people
    .filter((p) => AT_RISK_PERSON_STATUSES.has(p.status))
    .reduce((sum, p) => sum + Math.max(1, Number.isFinite(p.count) ? Math.floor(p.count) : 1), 0);
}

/** Fotogramas del medio ordenados por índice. */
export function sortedFrames(m: Pick<MediaView, "urls">): MediaView["urls"]["frames"] {
  return [...m.urls.frames].sort((a, b) => a.idx - b.idx);
}

/** URL del póster del medio: `urls.poster` o, si falta, el primer fotograma; null si no hay imagen. */
export function posterUrl(m: Pick<MediaView, "urls">): string | null {
  if (m.urls.poster) return m.urls.poster;
  const first = sortedFrames(m)[0];
  return first ? first.url : null;
}

/** Número de la etiqueta "M<n>"; null si la etiqueta no sigue ese formato. */
export function mediaLabelNumber(label: string): number | null {
  const match = /^M(\d+)$/i.exec(label.trim());
  return match ? Number(match[1]) : null;
}

function timeOf(iso: string | null | undefined): number {
  if (!iso) return Number.NaN;
  return Date.parse(iso);
}

/**
 * Orden de la tira: M1..Mn de izquierda a derecha. La etiqueta es secuencial por incidente
 * (se asigna al registrar), así que manda; si falta, se usa la hora de registro y luego el id.
 * No muta la lista recibida.
 */
export function sortMediaForStrip<T extends Pick<MediaView, "id" | "label" | "created_at">>(media: readonly T[]): T[] {
  return [...media].sort((a, b) => {
    const na = mediaLabelNumber(a.label);
    const nb = mediaLabelNumber(b.label);
    if (na !== null && nb !== null && na !== nb) return na - nb;
    if (na !== null && nb === null) return -1;
    if (na === null && nb !== null) return 1;
    const ta = timeOf(a.created_at);
    const tb = timeOf(b.created_at);
    const va = Number.isFinite(ta);
    const vb = Number.isFinite(tb);
    if (va && vb && ta !== tb) return ta - tb;
    if (va !== vb) return va ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** true mientras el medio está en proceso (subiendo, recibido sin analizar o analizándose). */
export function mediaStatusBusy(status: MediaStatus): boolean {
  return status === "uploading" || status === "uploaded" || status === "analyzing";
}

/** Hora que se muestra para el medio: la de captura si el teléfono la entregó; si no, la de registro. */
export function mediaTime(m: Pick<MediaView, "captured_at" | "created_at">): string {
  return m.captured_at ?? m.created_at;
}

/** true si el medio tiene video original pero ningún fotograma: el mando puede extraerlos en su navegador. */
export function canExtractFramesInBrowser(m: Pick<MediaView, "urls" | "frames">): boolean {
  return Boolean(m.urls.video) && m.urls.frames.length === 0 && m.frames.length === 0;
}

/**
 * Índice de fotograma a mostrar en grande al abrir el visor: el citado si existe en el medio;
 * si no, null (se muestra el video o, sin video, el primer fotograma).
 */
export function resolveCitedFrame(m: Pick<MediaView, "urls">, frame: number | null | undefined): number | null {
  if (frame === null || frame === undefined || !Number.isInteger(frame) || frame < 0) return null;
  return m.urls.frames.some((f) => f.idx === frame) ? frame : null;
}

/** Medio vecino (anterior o siguiente) en el orden de la tira; null en los extremos o si no está. */
export function adjacentMedia<T extends Pick<MediaView, "id" | "label" | "created_at">>(
  media: readonly T[],
  currentId: string,
  direction: -1 | 1,
): T | null {
  const ordered = sortMediaForStrip(media);
  const i = ordered.findIndex((m) => m.id === currentId);
  if (i < 0) return null;
  return ordered[i + direction] ?? null;
}

/** Reparte el avance de una etapa (0..1) dentro del tramo [from, to] del avance total. */
export function stageProgress(from: number, to: number, fraction: number): number {
  const f = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
  return from + (to - from) * f;
}
