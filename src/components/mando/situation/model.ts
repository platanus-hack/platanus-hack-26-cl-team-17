/**
 * Derivaciones puras del informe de situación para los paneles del mando.
 * Regla de oro: nunca convertir ausencia de evidencia en "seguro".
 */
import type { HazardSeverity, Incident, IncidentType, PipelineState, Priority, SituationReport, TrappedStatus } from "@/lib/domain";
import type { Tone } from "@/components/ui/tone";
import { pluralize } from "@/lib/format";

/* ─────────────────────────── Personas atrapadas ─────────────────────────── */

/** Cómo se presenta cada estado de atrapados en la franja crítica. */
export interface TrappedDisplay {
  /** Texto grande. */
  primary: string;
  /** Matiz obligatorio junto al texto grande (p. ej. "no descarta víctimas"). */
  qualifier: string | null;
}

export const TRAPPED_DISPLAY: Record<TrappedStatus, TrappedDisplay> = {
  confirmed: { primary: "CONFIRMADO", qualifier: null },
  probable: { primary: "PROBABLE", qualifier: null },
  possible: { primary: "POSIBLE", qualifier: null },
  no_evidence: { primary: "SIN EVIDENCIA", qualifier: "no descarta víctimas" },
  cleared_by_unit: { primary: "DESCARTADO", qualifier: "según unidad en el lugar" },
};

function safeCount(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/** Rango [mín, máx] saneado: tolera NaN, negativos y count_max < count_min (el mínimo manda). */
export function trappedRange(trapped: SituationReport["trapped"]): { min: number; max: number } {
  const min = safeCount(trapped.count_min);
  const max = Math.max(min, safeCount(trapped.count_max));
  return { min, max };
}

/**
 * Texto de cantidad de atrapados, o null si no corresponde mostrarla.
 * Con no_evidence/cleared y 0 personas no se muestra "0": se leería como "no hay nadie".
 */
export function trappedCountText(trapped: SituationReport["trapped"]): string | null {
  const { min, max } = trappedRange(trapped);
  const raised = trapped.status === "confirmed" || trapped.status === "probable" || trapped.status === "possible";
  if (max === 0) return raised ? "Cantidad sin determinar" : null;
  if (min === max) return pluralize(min, "persona");
  if (min === 0) return `Hasta ${pluralize(max, "persona")}`;
  return `${min}–${max} personas`;
}

/** Fuente entre paréntesis al final de una ubicación: "2º piso (nota M1)". */
const SOURCE_SUFFIX_RE = /\s*\(([^()]*)\)\s*$/;
const SOURCE_REF_RE = /\b[MC]\d+\b/i;

/**
 * Lugares únicos en orden de aparición. Quita la fuente entre paréntesis para que el mismo
 * lugar citado por varias fuentes ("2º piso (nota M1)", "2º piso (nota M2)") se lea una vez.
 */
export function uniqueLocations(locations: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of locations) {
    let place = raw.trim();
    const m = SOURCE_SUFFIX_RE.exec(place);
    if (m && SOURCE_REF_RE.test(m[1])) place = place.slice(0, m.index).trim();
    if (!place) continue;
    const key = place.toLocaleLowerCase("es");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(place);
  }
  return out;
}

/* ─────────────────────────── Estado del pipeline ─────────────────────────── */

export interface PipelineView {
  kind: "running" | "pending" | "error";
  tone: Tone;
  text: string;
}

/** Estado visible de la fusión; null si está en reposo. */
export function fusionPipelineView(pipeline: PipelineState | null | undefined): PipelineView | null {
  if (!pipeline) return null;
  switch (pipeline.fusion_status) {
    case "running":
      return { kind: "running", tone: "info", text: "Actualizando análisis…" };
    case "pending":
      return { kind: "pending", tone: "info", text: "En cola" };
    case "error": {
      const msg = pipeline.fusion_error?.trim();
      return { kind: "error", tone: "critical", text: msg ? msg : "El análisis falló sin detalle." };
    }
    default:
      return null;
  }
}

/** Mensaje sin informe: nunca se inventa un estado. */
export function noSituationMessage(mediaCount: number): string {
  return mediaCount > 0 ? "Analizando las primeras imágenes…" : "Esperando el primer video o reporte…";
}

/* ─────────────────────────── Tipo detectado ─────────────────────────── */

/** Tipo que ve la IA cuando difiere del registrado (y no es "por determinar"); si no, null. */
export function divergentType(incident: Pick<Incident, "type">, situation: Pick<SituationReport, "incident_type">): IncidentType | null {
  const seen = situation.incident_type;
  if (seen === "unknown" || seen === incident.type) return null;
  return seen;
}

/* ─────────────────────────── Orden ─────────────────────────── */

const PRIORITY_ORDER: Record<Priority, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const HAZARD_ORDER: Record<HazardSeverity, number> = { high: 0, medium: 1, low: 2 };

/** Ordena por prioridad (crítica primero) sin alterar el orden relativo de la IA. */
export function byPriority<T extends { priority: Priority }>(items: readonly T[]): T[] {
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => (PRIORITY_ORDER[a.item.priority] ?? 9) - (PRIORITY_ORDER[b.item.priority] ?? 9) || a.i - b.i)
    .map(({ item }) => item);
}

/** Ordena peligros por gravedad (alta primero), estable. */
export function bySeverity<T extends { severity: HazardSeverity }>(items: readonly T[]): T[] {
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => (HAZARD_ORDER[a.item.severity] ?? 9) - (HAZARD_ORDER[b.item.severity] ?? 9) || a.i - b.i)
    .map(({ item }) => item);
}

/* ─────────────────────────── Qué secciones aplican ─────────────────────────── */

const FIRE_TYPES: ReadonlySet<IncidentType> = new Set(["structure_fire", "vehicle_fire", "wildland_fire"]);
const VEHICLE_TYPES: ReadonlySet<IncidentType> = new Set(["vehicle_collision", "vehicle_fire"]);

function hasText(s: string): boolean {
  return s.trim().length > 0;
}

/** Si mostrar fuego/estructura: hay fuego, el tipo lo implica o hay datos de la edificación. */
export function showsFireAndStructure(incident: Pick<Incident, "type">, s: SituationReport): boolean {
  return (
    s.fire.present ||
    FIRE_TYPES.has(incident.type) ||
    FIRE_TYPES.has(s.incident_type) ||
    hasText(s.fire.location) ||
    hasText(s.fire.smoke) ||
    hasText(s.structure.description) ||
    s.structure.floors > 0
  );
}

/** Si mostrar vehículos: hay vehículos, el tipo lo implica o hay indicios de atrapamiento. */
export function showsVehicles(incident: Pick<Incident, "type">, s: SituationReport): boolean {
  return (
    s.vehicles.count > 0 ||
    VEHICLE_TYPES.has(incident.type) ||
    VEHICLE_TYPES.has(s.incident_type) ||
    hasText(s.vehicles.description) ||
    s.vehicles.entrapment !== "no_evidence"
  );
}

/* ─────────────────────────── Briefing ─────────────────────────── */

/** Texto para copiar: briefing hablado + puntos. */
export function briefingCopyText(briefing: SituationReport["briefing"]): string {
  const spoken = briefing.spoken.trim();
  const bullets = briefing.bullets.map((b) => b.trim()).filter(Boolean);
  const parts: string[] = [];
  if (spoken) parts.push(spoken);
  if (bullets.length > 0) parts.push(bullets.map((b) => `• ${b}`).join("\n"));
  return parts.join("\n\n");
}

/** Texto para leer en voz alta: el briefing hablado o, si viene vacío, los puntos. */
export function briefingSpeechText(briefing: SituationReport["briefing"]): string {
  const spoken = briefing.spoken.trim();
  if (spoken) return spoken;
  return briefing.bullets
    .map((b) => b.trim())
    .filter(Boolean)
    .map((b) => (/[.!?]$/.test(b) ? b : `${b}.`))
    .join(" ");
}
