/**
 * Lógica pura del panel de dron (sin React ni navegador): señal, batería, distancia,
 * traza en SVG, orden de misiones, lotes del dron, validación del formulario y comando del puente.
 */
import type { Tone } from "@/components/ui/tone";
import type { MediaView } from "@/lib/contract";
import {
  CreateMissionInputSchema,
  LIMITS,
  type CreateMissionInput,
  type DroneMission,
  type MissionMode,
  type MissionPattern,
  type PersonStatus,
} from "@/lib/domain";
import { formatDuration } from "@/lib/format";
import { hazardKindLabel, hazardSeverityTone, personStatusLabel, personStatusTone } from "@/lib/labels";
import { distanceM, toLocal, type LatLng } from "@/lib/geo";
import { isMissionActive } from "@/lib/drone/plan";

/* ───────────── Señal ───────────── */

/** Segundos sin datos a partir de los cuales la señal se considera dudosa / perdida. */
export const SIGNAL_WARNING_S = 10;
export const SIGNAL_CRITICAL_S = 30;

export type SignalLevel = "live" | "stale" | "lost" | "waiting" | "waiting_long" | "ended" | "never";

export interface SignalState {
  level: SignalLevel;
  /** Segundos desde el último dato (o desde el despliegue si nunca llegó uno); null si no se sabe. */
  ageS: number | null;
  tone: Tone;
  text: string;
}

function parseMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** Segundos enteros transcurridos (nunca negativos: tolera relojes algo desfasados). */
export function ageSeconds(iso: string | null | undefined, nowMs: number): number | null {
  const t = parseMs(iso);
  if (t === null || !Number.isFinite(nowMs)) return null;
  return Math.max(0, Math.floor((nowMs - t) / 1000));
}

/** Estado de la señal de una misión para la línea "sin señal hace X s". `nowMs` null = aún sin reloj (hidratación). */
export function signalState(
  mission: Pick<DroneMission, "status" | "last" | "created_at">,
  nowMs: number | null,
): SignalState {
  const active = isMissionActive(mission);
  const lastAt = mission.last?.at ?? null;
  if (!active) {
    if (!lastAt) return { level: "never", ageS: null, tone: "neutral", text: "La misión no envió datos" };
    const age = nowMs === null ? null : ageSeconds(lastAt, nowMs);
    return {
      level: "ended",
      ageS: age,
      tone: "neutral",
      text: age === null ? "Misión terminada" : `Último dato hace ${formatDuration(age)}`,
    };
  }
  if (!lastAt) {
    const age = nowMs === null ? null : ageSeconds(mission.created_at, nowMs);
    if (age !== null && age >= SIGNAL_CRITICAL_S) {
      return { level: "waiting_long", ageS: age, tone: "warning", text: `Sin señal desde el despliegue (${formatDuration(age)})` };
    }
    return { level: "waiting", ageS: age, tone: "neutral", text: "Esperando la primera señal…" };
  }
  const age = nowMs === null ? null : ageSeconds(lastAt, nowMs);
  if (age === null) return { level: "live", ageS: null, tone: "ok", text: "Señal recibida" };
  if (age >= SIGNAL_CRITICAL_S) return { level: "lost", ageS: age, tone: "critical", text: `Sin señal hace ${formatDuration(age)}` };
  if (age >= SIGNAL_WARNING_S) return { level: "stale", ageS: age, tone: "warning", text: `Sin señal hace ${formatDuration(age)}` };
  return { level: "live", ageS: age, tone: "ok", text: `Señal en vivo · último dato hace ${formatDuration(age)}` };
}

/* ───────────── Batería ───────────── */

export const BATTERY_WARNING_PCT = 35;
export const BATTERY_CRITICAL_PCT = 25;

export function batteryTone(pct: number | null | undefined): Tone {
  if (pct == null || !Number.isFinite(pct)) return "neutral";
  if (pct < BATTERY_CRITICAL_PCT) return "critical";
  if (pct < BATTERY_WARNING_PCT) return "warning";
  return "ok";
}

/** 0..1 para ProgressBar; null si no hay dato. */
export function batteryRatio(pct: number | null | undefined): number | null {
  if (pct == null || !Number.isFinite(pct)) return null;
  return Math.min(1, Math.max(0, pct / 100));
}

/* ───────────── Distancia y traza ───────────── */

/** Distancia del último punto al incidente, en metros; null sin telemetría. */
export function distanceToIncidentM(last: Pick<LatLng, "lat" | "lng"> | null | undefined, incident: LatLng): number | null {
  if (!last || !Number.isFinite(last.lat) || !Number.isFinite(last.lng)) return null;
  return distanceM(incident, last);
}

export const TRACK_MAX_POINTS = 120;

export interface TrackSvg {
  /** Lado del viewBox cuadrado. */
  size: number;
  /** Atributo `d` de la traza (vacío si no hay puntos). */
  path: string;
  /** Radio del círculo de órbita en unidades SVG (0 si no aplica). */
  orbitR: number;
  /** Posición actual del dron (último punto), o null. */
  current: { x: number; y: number } | null;
  /** Metros que representa la mitad del lado (para el texto de escala). */
  halfExtentM: number;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Proyecta la traza (vista cenital, Norte arriba) en un cuadrado con el incidente al centro.
 * La escala abarca la órbita y todos los puntos recientes; los puntos lejanos (despegue) se incluyen.
 */
export function trackToSvg(
  track: Pick<LatLng, "lat" | "lng">[],
  center: LatLng,
  opts: { radiusM: number; pattern: MissionPattern; size?: number; maxPoints?: number },
): TrackSvg {
  const size = opts.size ?? 120;
  const half = size / 2;
  const pad = 6;
  const pts = track
    .slice(-(opts.maxPoints ?? TRACK_MAX_POINTS))
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng))
    .map((p) => toLocal(center, p));
  const showOrbit = opts.pattern !== "hover" && opts.radiusM > 0;
  // En barrido el área es un cuadrado de lado 2·radio: su esquina está a radio·√2.
  const patternExtent = opts.pattern === "grid" ? opts.radiusM * Math.SQRT2 : opts.pattern === "orbit" ? opts.radiusM : 0;
  let extent = Math.max(30, patternExtent * 1.15);
  for (const p of pts) extent = Math.max(extent, Math.abs(p.x) * 1.05, Math.abs(p.y) * 1.05);
  const scale = (half - pad) / extent;
  const toSvg = (p: { x: number; y: number }) => ({ x: round1(half + p.x * scale), y: round1(half - p.y * scale) });
  const svgPts = pts.map(toSvg);
  const path = svgPts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join(" ");
  return {
    size,
    path,
    orbitR: showOrbit ? round1(opts.radiusM * scale) : 0,
    current: svgPts.length > 0 ? svgPts[svgPts.length - 1] : null,
    halfExtentM: Math.round(extent),
  };
}

/* ───────────── Misiones y lotes ───────────── */

const byCreatedDesc = (a: { created_at: string }, b: { created_at: string }) =>
  (parseMs(b.created_at) ?? 0) - (parseMs(a.created_at) ?? 0);

/** Separa misiones activas e historial, ambas con la más reciente primero. */
export function splitMissions<T extends Pick<DroneMission, "status" | "created_at">>(
  missions: T[],
): { active: T[]; finished: T[] } {
  const sorted = [...missions].sort(byCreatedDesc);
  return { active: sorted.filter(isMissionActive), finished: sorted.filter((m) => !isMissionActive(m)) };
}

/** Lotes de cuadros enviados por un dron, el más reciente primero. */
export function droneBatchesFor(media: MediaView[], missionId: string): MediaView[] {
  return media.filter((m) => m.source === "drone" && m.mission_id === missionId).sort(byCreatedDesc);
}

/** Miniatura de un lote: el póster o el primer cuadro disponible. */
export function batchThumbUrl(m: Pick<MediaView, "urls">): string | null {
  return m.urls.poster ?? m.urls.frames[0]?.url ?? null;
}

export interface BatchChip {
  tone: Tone;
  text: string;
}

export type BatchPhase = "collecting" | "queued" | "analyzing" | "analyzed" | "failed";

export interface BatchDigest {
  phase: BatchPhase;
  /** Línea principal: resumen de la IA o estado del lote. */
  text: string;
  /** Hallazgos que importan al mando (personas en riesgo, peligros), lo más grave primero. */
  chips: BatchChip[];
  /** Si la IA no vio personas en riesgo: recordatorio de que eso no descarta víctimas. */
  noPeopleNote: string | null;
}

/** Personas que no cuentan como "en riesgo" para el resumen del lote. */
const NOT_AT_RISK: ReadonlySet<PersonStatus> = new Set<PersonStatus>(["bystander", "responder"]);
const PERSON_ORDER: PersonStatus[] = [
  "trapped",
  "at_window_or_balcony",
  "on_roof",
  "injured",
  "unknown",
  "evacuating",
];
export const BATCH_MAX_CHIPS = 5;
export const NO_PEOPLE_NOTE =
  "La IA no identificó personas en riesgo en estos cuadros. Eso no descarta víctimas: sigue la búsqueda.";

/** Resumen de un lote del dron para el panel: estado, hallazgos y aviso de víctimas. */
export function batchDigest(
  m: Pick<MediaView, "status" | "error" | "analysis" | "frames">,
  batchSize: number = LIMITS.DRONE_BATCH_FRAMES,
): BatchDigest {
  const base = { chips: [] as BatchChip[], noPeopleNote: null };
  if (m.status === "uploading") {
    return { ...base, phase: "collecting", text: `Reuniendo cuadros (${m.frames.length} de ${batchSize})` };
  }
  if (m.status === "failed") {
    return { ...base, phase: "failed", text: m.error?.trim() || "No se pudo analizar este lote." };
  }
  const a = m.analysis;
  if (m.status !== "analyzed" || !a) {
    return {
      ...base,
      phase: m.status === "analyzing" ? "analyzing" : "queued",
      text: m.status === "analyzing" ? "La IA está analizando los cuadros…" : "En cola para el análisis.",
    };
  }
  const chips: BatchChip[] = [];
  const atRisk = a.people
    .filter((p) => !NOT_AT_RISK.has(p.status))
    .sort((x, y) => PERSON_ORDER.indexOf(x.status) - PERSON_ORDER.indexOf(y.status));
  for (const p of atRisk) {
    const n = Math.max(1, Math.round(p.count));
    chips.push({ tone: personStatusTone[p.status], text: `${n} · ${personStatusLabel[p.status]}` });
  }
  const hazards = a.hazards
    .filter((h) => h.severity !== "low")
    .sort((x, y) => (x.severity === y.severity ? 0 : x.severity === "high" ? -1 : 1));
  for (const h of hazards) {
    chips.push({ tone: hazardSeverityTone[h.severity], text: hazardKindLabel[h.kind] });
  }
  if (!a.usable) {
    chips.push({ tone: "warning", text: a.unusable_reason.trim() ? `Poco útil: ${a.unusable_reason.trim()}` : "Cuadros poco útiles" });
  }
  const shown = chips.slice(0, BATCH_MAX_CHIPS);
  if (chips.length > shown.length) shown.push({ tone: "neutral", text: `+${chips.length - shown.length} más` });
  return {
    phase: "analyzed",
    text: a.summary.trim() || "Análisis sin resumen.",
    chips: shown,
    noPeopleNote: atRisk.length === 0 ? NO_PEOPLE_NOTE : null,
  };
}

/** Texto en mayúsculas de la orden pendiente, o null si el dron continúa. */
export function pendingCommandText(command: DroneMission["command"]): string | null {
  if (command === "recall") return "RETORNAR";
  if (command === "abort") return "ABORTAR";
  return null;
}

/* ───────────── Formulario ───────────── */

export const RADIUS_MIN_M = 10;
export const RADIUS_MAX_M = 500;
export const ALTITUDE_MIN_M = 10;
export const ALTITUDE_MAX_M = 120;
export const DEFAULT_RADIUS_M = 60;
export const DEFAULT_ALTITUDE_M = 45;

export interface MissionFormValues {
  mode: MissionMode;
  pattern: MissionPattern;
  /** Texto tal como lo escribió la persona. */
  radius: string;
  altitude: string;
}

export type MissionFormResult =
  | { ok: true; input: CreateMissionInput }
  | { ok: false; errors: { radius?: string; altitude?: string } };

function parseNumber(raw: string): number | null {
  const s = raw.trim().replace(",", ".");
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Valida contra CreateMissionInputSchema con mensajes en español. En "punto fijo" el radio no se usa. */
export function validateMissionForm(v: MissionFormValues): MissionFormResult {
  const errors: { radius?: string; altitude?: string } = {};
  const radius = v.pattern === "hover" ? DEFAULT_RADIUS_M : parseNumber(v.radius);
  const altitude = parseNumber(v.altitude);
  if (radius === null || radius < RADIUS_MIN_M || radius > RADIUS_MAX_M) {
    errors.radius = `Escribe un radio entre ${RADIUS_MIN_M} y ${RADIUS_MAX_M} m.`;
  }
  if (altitude === null || altitude < ALTITUDE_MIN_M || altitude > ALTITUDE_MAX_M) {
    errors.altitude = `Escribe una altura entre ${ALTITUDE_MIN_M} y ${ALTITUDE_MAX_M} m.`;
  }
  if (errors.radius || errors.altitude) return { ok: false, errors };
  const parsed = CreateMissionInputSchema.safeParse({
    mode: v.mode,
    pattern: v.pattern,
    radius_m: radius,
    altitude_m: altitude,
  });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      if (issue.path[0] === "radius_m") errors.radius = `Escribe un radio entre ${RADIUS_MIN_M} y ${RADIUS_MAX_M} m.`;
      if (issue.path[0] === "altitude_m") errors.altitude = `Escribe una altura entre ${ALTITUDE_MIN_M} y ${ALTITUDE_MAX_M} m.`;
    }
    if (!errors.radius && !errors.altitude) errors.altitude = "Revisa los valores del formulario.";
    return { ok: false, errors };
  }
  return { ok: true, input: parsed.data };
}

/* ───────────── Credenciales ───────────── */

/** URL absoluta del modo sensor. */
export function absoluteSensorUrl(origin: string, sensorPath: string): string {
  return new URL(sensorPath, origin).toString();
}

/** Cita un argumento para bash solo si hace falta. */
export function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_\-.,:/=+@%]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Comando del puente para un dron real por API (en modo --simulate, listo para probar). */
export function bridgeCommand(p: { origin: string; missionId: string; token: string; lat: number; lng: number }): string {
  return [
    "python3 tools/drone_bridge.py",
    `--url ${shellQuote(p.origin)}`,
    `--mission ${shellQuote(p.missionId)}`,
    `--token ${shellQuote(p.token)}`,
    "--simulate",
    `--lat ${p.lat.toFixed(6)}`,
    `--lng ${p.lng.toFixed(6)}`,
  ].join(" ");
}

/** true si el puesto de mando está abierto en una dirección que otro equipo de la red no puede abrir. */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname;
    return host === "localhost" || host === "::1" || host === "[::1]" || /^127\./.test(host) || host.endsWith(".localhost");
  } catch {
    return false;
  }
}
