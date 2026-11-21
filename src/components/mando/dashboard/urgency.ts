/**
 * Orden y filtros del tablero /mando (lógica pura, sin React).
 *
 * Orden por urgencia, dentro de cada estado (activos → controlados → cerrados):
 * 1. personas atrapadas confirmadas, luego probables;
 * 2. gravedad crítica;
 * 3. el resto por gravedad descendente;
 * 4. desempate: el más reciente primero (created_at).
 */
import type { IncidentSummary } from "@/lib/contract";
import { isTrappedAlarm, severityRank } from "@/lib/labels";

/** Filtro del tablero. */
export type IncidentFilter = "active" | "controlled" | "closed" | "all";

/** Valores válidos del filtro, en el orden en que se muestran. */
export const INCIDENT_FILTERS: readonly IncidentFilter[] = ["active", "controlled", "closed", "all"];

/** true si `v` es un filtro válido (p. ej. leído de sessionStorage). */
export function isIncidentFilter(v: unknown): v is IncidentFilter {
  return typeof v === "string" && (INCIDENT_FILTERS as readonly string[]).includes(v);
}

const STATUS_WEIGHT: Record<string, number> = { active: 2, controlled: 1, closed: 0 };

/** Nivel dentro del estado: atrapados confirmados 3, probables 2, gravedad crítica 1, resto 0. */
function urgencyTier(i: IncidentSummary): number {
  if (i.trapped_status === "confirmed") return 3;
  if (i.trapped_status === "probable") return 2;
  if (i.severity === "critical") return 1;
  return 0;
}

/** Puntaje de urgencia (mayor = más urgente); no incluye el desempate por fecha. */
export function urgencyScore(i: IncidentSummary): number {
  const status = STATUS_WEIGHT[i.status] ?? 2;
  // severityRank: -1 (sin dato) … 3 (crítica) → 0 … 4
  return status * 1000 + urgencyTier(i) * 100 + (severityRank(i.severity) + 1) * 10;
}

function createdMs(i: IncidentSummary): number {
  const ms = Date.parse(i.created_at);
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

/** Copia ordenada por urgencia (estable: los empates conservan el orden recibido). */
export function sortByUrgency(list: IncidentSummary[]): IncidentSummary[] {
  return list
    .map((incident, index) => ({ incident, index, score: urgencyScore(incident), created: createdMs(incident) }))
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      if (a.created !== b.created) return a.created > b.created ? -1 : 1;
      return a.index - b.index;
    })
    .map((x) => x.incident);
}

/** Incidentes que pasan el filtro (conserva el orden). */
export function filterIncidents(list: IncidentSummary[], filter: IncidentFilter): IncidentSummary[] {
  if (filter === "all") return list.slice();
  return list.filter((i) => i.status === filter);
}

/** Reporte ciudadano aún sin verificar y no cerrado. */
export function isUnverifiedCitizen(i: IncidentSummary): boolean {
  return i.origin === "citizen" && !i.verified && i.status !== "closed";
}

/** Separa los reportes ciudadanos sin verificar del resto (conserva el orden en ambos). */
export function splitUnverifiedCitizen(list: IncidentSummary[]): {
  unverified: IncidentSummary[];
  rest: IncidentSummary[];
} {
  const unverified: IncidentSummary[] = [];
  const rest: IncidentSummary[] = [];
  for (const i of list) (isUnverifiedCitizen(i) ? unverified : rest).push(i);
  return { unverified, rest };
}

/** Contadores del encabezado del tablero. */
export function dashboardCounts(list: IncidentSummary[]): {
  active: number;
  /** Atrapados confirmados o probables en incidentes no cerrados. */
  trapped: number;
  unverified: number;
} {
  let active = 0;
  let trapped = 0;
  let unverified = 0;
  for (const i of list) {
    if (i.status === "active") active++;
    if (i.status !== "closed" && isTrappedAlarm(i.trapped_status)) trapped++;
    if (isUnverifiedCitizen(i)) unverified++;
  }
  return { active, trapped, unverified };
}

/** Cantidad de incidentes por filtro (para rotular el selector). */
export function filterCounts(list: IncidentSummary[]): Record<IncidentFilter, number> {
  const counts: Record<IncidentFilter, number> = { active: 0, controlled: 0, closed: 0, all: list.length };
  for (const i of list) {
    if (i.status === "active" || i.status === "controlled" || i.status === "closed") counts[i.status]++;
  }
  return counts;
}
