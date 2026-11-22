/**
 * Ficha del incidente: modelo puro (sin React ni mapa) que convierte el snapshot del
 * incidente en lo que muestra la pantalla: tarjetas de "Lo crítico", hallazgos,
 * marcadores del mapa, conversación con Vigía y línea de tiempo.
 *
 * Reglas que se respetan aquí y no en la vista:
 *  - nunca se dice "no hay": lo que no aparece en los videos es "no se ve";
 *  - la confianza acompaña a cada hallazgo;
 *  - las posiciones de unidades salen de la radio (sin GPS) y se marcan aproximadas.
 */
import type {
  CommsAnalysis,
  Confidence,
  EvidenceRef,
  HazardKind,
  Incident,
  IncidentType,
  SceneModel,
  SituationReport,
  TimelineEvent,
} from "@/lib/domain";
import type { IncidentSnapshot, LiveInsightView, MediaView } from "@/lib/contract";
import type { VigiaUtterance } from "@/lib/vigia/types";
import { toLatLng, type LatLng, type LocalXY } from "@/lib/geo";
import { houseClearance, houseOutline, houseParts, houseSpec, roofHeightOf, vehicleParts, type HouseSpec, type Part } from "./house";

/* ───────────────────────────── Tipos ───────────────────────────── */

/** Colores con significado: rojo vidas, naranjo fuego, ámbar riesgos, azul bomberos y cámaras, verde despejado. */
export type Tone = "red" | "orange" | "amber" | "blue" | "green" | "gray";

export type LngLat = [number, number];

export type CardIcon = "person" | "fire" | "hazard" | "vehicle" | "access" | "resources" | "structure" | "clear";

export interface CriticalCard {
  id: string;
  tone: Tone;
  icon: CardIcon;
  /** Titular: un solo dato grande ("1–2 personas atrapadas"). */
  title: string;
  /** Una línea de ubicación, ya acortada. */
  location: string | null;
  confidence: Confidence | null;
  /** Fuentes como chips: "C5", "M1 · cuadro 1". */
  sources: string[];
  /** Lo que no aparece en los videos ("No se ve en los videos · 2 de 7 analizados"). */
  unseen: string | null;
  /** Marcador del mapa relacionado. */
  focus: string | null;
}

export interface Finding {
  id: string;
  tone: Tone;
  title: string;
  confidence: Confidence;
  focus: string | null;
}

export type PinKind = "person" | "fire" | "hazard" | "unit" | "post" | "camera" | "dest";

export interface MapPin {
  /** Clave estable (P1, H1, M1, U:B-4…); también la usan las burbujas de Vigía. */
  id: string;
  kind: PinKind;
  tone: Tone;
  at: LngLat;
  text: string;
  /** Segunda parte, más tenue ("confianza alta"). */
  sub: string | null;
  /** Mayor = gana el espacio si dos etiquetas chocan. */
  priority: number;
  /** Medio asociado (cámaras): abre la miniatura. */
  mediaId?: string;
}

export interface Zone {
  id: string;
  tone: "red" | "amber";
  ring: LngLat[];
}

export interface Cone {
  id: string;
  ring: LngLat[];
}

export interface Smoke {
  id: string;
  at: LngLat;
  /** Altura de salida del humo (m): el techo o donde la IA ubicó la columna. */
  base: number;
  volume: SceneModel["smoke_plumes"][number]["volume"];
  color: SceneModel["smoke_plumes"][number]["color"];
  /** Rumbo hacia donde deriva (0 = Norte); null si no se sabe. */
  driftDeg: number | null;
}

export interface FichaMap {
  center: LngLat;
  /** Columnas de humo animadas sobre las casas con fuego. */
  smokes: Smoke[];
  /** Vehículos en piezas (prismas). */
  parts: Part[];
  /** Casas para la maqueta 3D (three.js): muros, ventanas y techo. */
  houses: HouseSpec[];
  /** Las mismas casas en prismas, por si three.js no carga en este equipo. */
  houseBlocks: Part[];
  /** Contornos en el suelo (casa afectada continua, vecinas punteadas) y fachadas principales. */
  outlines: { ring: LngLat[]; front: LngLat[]; affected: boolean }[];
  /** Círculos donde se oculta el edificio del mapa base (queda la maqueta). */
  hideBase: { at: LngLat; r: number }[];
  zones: Zone[];
  cones: Cone[];
  /** Ruta de llegada (azul): desde el acceso sugerido hasta el puesto de mando. */
  route: LngLat[];
  /** Dónde está el foco (halo animado); null si no hay un punto claro. */
  halo: { at: LngLat; tone: Tone } | null;
  pins: MapPin[];
}

export type ChatFrom = "vigia" | "obac";

export interface ChatMessage {
  id: string;
  at: string;
  from: ChatFrom;
  text: string;
  /** Rótulo chico arriba de la burbuja ("Radio", "Informe", "Alerta"). */
  tag: string | null;
  focus: string | null;
  /** true si la respuesta es de plantilla, sin IA (se rotula siempre). */
  template?: boolean;
}

export type TimelineFilter = "all" | "alerts" | "radio" | "videos";

export interface TimelineItem {
  id: string;
  at: string;
  tone: Tone;
  group: Exclude<TimelineFilter, "all"> | "other";
  title: string;
}

export interface FichaHeader {
  typeLabel: string;
  place: string;
  code: string;
  startedAt: string;
  status: Incident["status"];
  /** Reporte de vecino que el mando aún no confirma. */
  unverified: boolean;
}

export interface Ficha {
  header: FichaHeader;
  /** Sin informe ni escena todavía: pantalla "llegando". */
  arriving: boolean;
  cards: CriticalCard[];
  findings: Finding[];
  map: FichaMap;
  chat: ChatMessage[];
  timeline: TimelineItem[];
  /** Videos analizados y totales (para "no se ve en los videos"). */
  coverage: { analyzed: number; total: number };
}

/* ───────────────────────────── Textos ───────────────────────────── */

const TYPE_LABEL: Record<IncidentType, string> = {
  structure_fire: "Incendio estructural",
  vehicle_fire: "Incendio de vehículo",
  wildland_fire: "Incendio forestal",
  vehicle_collision: "Accidente de tránsito",
  hazmat: "Materiales peligrosos",
  rescue: "Rescate",
  other: "Emergencia",
  unknown: "Emergencia",
};

export const CONFIDENCE_WORD: Record<Confidence, string> = { high: "alta", medium: "media", low: "baja" };

const HAZARD_TEXT: Record<HazardKind, string> = {
  gas_cylinder: "Cilindros de gas",
  gas_line: "Fuga de gas",
  power_lines: "Cables eléctricos",
  electrical: "Riesgo eléctrico",
  fuel_spill: "Derrame de combustible",
  hazmat_placard: "Materiales peligrosos",
  collapse_risk: "Riesgo de colapso",
  explosion_risk: "Riesgo de explosión",
  ev_battery: "Auto eléctrico · energizado",
  solar_panels: "Paneles solares",
  traffic: "Tránsito activo",
  crowd: "Curiosos en la zona",
  water_hazard: "Agua",
  other: "Peligro",
};

const SIDE_LETTER: Record<string, string> = { front: "A", left: "B", rear: "C", right: "D" };

/** Unidades de bomberos según su sigla de radio (B-4, RX-15, Q-8, BX-2…). */
const FIRE_UNIT = /^[A-Z]{1,3}-\d{1,3}$/;

/* ───────────────────────────── Utilidades ───────────────────────────── */

const PRIORITY_RANK = { critical: 4, high: 3, medium: 2, low: 1 } as const;

/** "V1, auto volcado sobre el techo, pista central de…: asiento" → "V1, auto volcado sobre el techo". */
export function shortPlace(text: string, maxParts = 2): string {
  // Corta en ":" o ";" (no en puntos: "Av." y "Gral." son parte del nombre).
  const clean = text.replace(/\s*\([^)]*\)/g, "").split(/[:;]/)[0].trim();
  return clean
    .replace(/\.$/, "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, maxParts)
    .join(", ");
}

/** Chip de fuente: "C5", "M1 · cuadro 4" (el índice de cuadro de la IA parte en 0). */
export function sourceChip(ref: EvidenceRef): string {
  return ref.frame >= 0 && /^M\d+/.test(ref.ref) ? `${ref.ref} · cuadro ${ref.frame + 1}` : ref.ref;
}

function uniqueChips(refs: readonly EvidenceRef[], max = 4): string[] {
  const out: string[] = [];
  for (const r of refs) {
    const c = sourceChip(r);
    if (!out.includes(c)) out.push(c);
    if (out.length >= max) break;
  }
  return out;
}

function personWord(n: number): string {
  return n === 1 ? "persona" : "personas";
}

function countRange(min: number, max: number): string {
  const lo = Math.max(1, min);
  return max > lo ? `${lo}–${max}` : String(lo);
}

/** Textos del modelo que en realidad dicen "no se sabe" ("No determinada en el material disponible"). */
function isUnknownText(t: string): boolean {
  return !t.trim() || /no determinad|desconocid|no se sabe|no se ve|sin informaci|no evaluad|no disponible/i.test(t);
}

function lngLat(origin: LatLng, p: LocalXY): LngLat {
  const ll = toLatLng(origin, p);
  return [ll.lng, ll.lat];
}

/** Círculo como polígono (metros, en la escena local). */
export function circleRing(origin: LatLng, c: LocalXY, r: number, steps = 48): LngLat[] {
  const ring: LngLat[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    ring.push(lngLat(origin, { x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r }));
  }
  return ring;
}

/** Cono de visión de una cámara: vértice en la cámara, abre `fov` grados hacia `heading`. */
export function coneRing(origin: LatLng, c: LocalXY, headingDeg: number, length = 16, fov = 40): LngLat[] {
  const ring: LngLat[] = [lngLat(origin, c)];
  const steps = 8;
  for (let i = 0; i <= steps; i++) {
    const h = ((headingDeg - fov / 2 + (fov * i) / steps) * Math.PI) / 180;
    ring.push(lngLat(origin, { x: c.x + Math.sin(h) * length, y: c.y + Math.cos(h) * length }));
  }
  ring.push(ring[0]);
  return ring;
}

function finite(n: unknown, fallback = 0): number {
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
}

/* ───────────────────────────── Lo crítico ───────────────────────────── */

function trappedConfidence(status: SituationReport["trapped"]["status"]): Confidence {
  return status === "confirmed" ? "high" : status === "probable" ? "medium" : "low";
}

function insightTone(category: SituationReport["insights"][number]["category"]): { tone: Tone; icon: CardIcon } {
  switch (category) {
    case "life_safety":
      return { tone: "red", icon: "person" };
    case "fire_behavior":
      return { tone: "orange", icon: "fire" };
    case "hazard":
      return { tone: "amber", icon: "hazard" };
    case "vehicle":
      return { tone: "amber", icon: "vehicle" };
    case "structure":
      return { tone: "amber", icon: "structure" };
    case "access":
      return { tone: "blue", icon: "access" };
    case "resources":
      return { tone: "blue", icon: "resources" };
    default:
      return { tone: "gray", icon: "hazard" };
  }
}

/** Relaciona un hallazgo con un marcador del mapa por las referencias que nombra (V1, P1, H2…) o por su tema. */
export function focusFor(text: string, scene: SceneModel | null): string | null {
  if (!scene) return null;
  const t = text.toLowerCase();
  if (/atrapad|ocupante/.test(t)) {
    const p = scene.people?.find((x) => x.status === "trapped");
    if (p) return p.id;
  }
  const kinds: [RegExp, string][] = [
    [/derrame|combustible/, "fuel_spill"],
    [/el[eé]ctric|bater/, "ev_battery"],
    [/gas/, "gas_line"],
    [/cable/, "power_lines"],
  ];
  for (const [re, kind] of kinds) {
    if (re.test(t)) {
      const h = scene.hazards?.find((x) => x.kind === kind);
      if (h) return h.id;
    }
  }
  if (/inestable|volcad/.test(t)) {
    const h = scene.hazards?.find((x) => x.kind === "other" && x.severity === "high");
    if (h) return h.id;
  }
  if (/lesionad/.test(t)) {
    const p = scene.people?.find((x) => x.status === "injured");
    if (p) return p.id;
  }
  if (/fuego|foco|llamas/.test(t)) {
    if (scene.fire_zones?.length) return "F0";
  }
  return null;
}

export function buildCards(
  situation: SituationReport | null,
  scene: SceneModel | null,
  coverage: { analyzed: number; total: number },
): { cards: CriticalCard[]; findings: Finding[] } {
  if (!situation) return { cards: [], findings: [] };
  const cards: CriticalCard[] = [];
  const t = situation.trapped;
  const unseenLine = coverage.total > 0 ? `No se ve en los videos · ${coverage.analyzed} de ${coverage.total} analizados` : "Aún no hay videos analizados";

  if (t.status === "cleared_by_unit") {
    cards.push({
      id: "trapped",
      tone: "green",
      icon: "clear",
      title: "Sin atrapados según unidad en el lugar",
      location: null,
      confidence: "high",
      sources: uniqueChips(t.evidence),
      unseen: null,
      focus: null,
    });
  } else if (t.status === "no_evidence") {
    cards.push({
      id: "trapped",
      tone: "gray",
      icon: "person",
      title: "Atrapados: no se ven",
      location: null,
      confidence: null,
      sources: uniqueChips(t.evidence),
      unseen: unseenLine,
      focus: null,
    });
  } else {
    const n = countRange(t.count_min, t.count_max);
    const plural = n !== "1";
    const base = `${n} ${plural ? "personas atrapadas" : "persona atrapada"}`;
    const prefix = t.status === "probable" ? "Probable: " : t.status === "possible" ? "Posible: " : "";
    cards.push({
      id: "trapped",
      tone: "red",
      icon: "person",
      title: prefix + base,
      location: t.locations[0] ? shortPlace(t.locations[0]) : null,
      confidence: trappedConfidence(t.status),
      sources: uniqueChips(t.evidence),
      unseen: null,
      focus: scene?.people?.find((p) => p.status === "trapped")?.id ?? null,
    });
  }

  if (situation.fire.present) {
    cards.push({
      id: "fire",
      tone: "orange",
      icon: "fire",
      title: isUnknownText(situation.fire.location) ? "Fuego informado" : `Fuego · ${shortPlace(situation.fire.location, 1)}`,
      location: isUnknownText(situation.fire.location) ? null : isUnknownText(situation.fire.spread) ? null : shortPlace(situation.fire.spread, 1),
      unseen: isUnknownText(situation.fire.location) ? "Foco: no se ve en los videos" : null,
      confidence: situation.overall_confidence,
      sources: [],
      focus: scene?.fire_zones?.length ? "F0" : null,
    });
  }

  const insights = [...(situation.insights ?? [])].sort((a, b) => PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority]);
  const coversTrapped = (title: string) => /atrapad|ocupante/i.test(title);
  for (const ins of insights) {
    if (cards.length >= 3) break;
    if (ins.priority === "low") continue;
    if (coversTrapped(ins.title) && ins.category === "life_safety") continue;
    if (situation.fire.present && ins.category === "fire_behavior") continue;
    const { tone, icon } = insightTone(ins.category);
    cards.push({
      id: `I:${ins.id}`,
      tone,
      icon,
      title: ins.title,
      location: null,
      confidence: ins.confidence,
      sources: uniqueChips(ins.evidence, 3),
      unseen: null,
      focus: focusFor(ins.title, scene),
    });
  }

  const findings: Finding[] = insights.map((ins) => ({
    id: ins.id,
    tone: insightTone(ins.category).tone,
    title: ins.title,
    confidence: ins.confidence,
    focus: focusFor(ins.title, scene),
  }));
  return { cards: cards.slice(0, 3), findings };
}

/* ───────────────────────── Lo crítico: dron en vivo ───────────────────────── */

/** Una observación del dron cuenta para «Lo crítico» mientras es de los últimos 5 minutos. */
export const DRONE_CARD_MAX_AGE_MS = 5 * 60_000;
/** Como mucho dos tarjetas del dron, para no tapar lo que viene de la radio y los videos. */
const DRONE_CARDS_MAX = 2;

function droneIcon(text: string): CardIcon {
  const t = text.toLowerCase();
  if (/persona|atrapad|ocupante|v[ií]ctima|herid|lesionad/.test(t)) return "person";
  if (/fuego|llama|humo|incendi|foco/.test(t)) return "fire";
  if (/auto|veh[ií]culo|cami[oó]n|moto/.test(t)) return "vehicle";
  return "hazard";
}

function clipTitle(text: string, max = 90): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Tarjetas de «Lo crítico» con lo importante que vio el dron: la observación crítica más
 * reciente y la de advertencia más reciente (si no repite la crítica), de los últimos minutos.
 * Lo informativo se queda en el video y en el historial de Vigía.
 */
export function buildDroneCards(
  insights: readonly LiveInsightView[],
  droneLabel: string,
  nowMs: number,
  scene: SceneModel | null,
): CriticalCard[] {
  const recent = insights
    .filter((i) => i.engine !== "error" && i.summary.trim() !== "")
    .filter((i) => i.severity === "critical" || i.severity === "warning")
    .filter((i) => nowMs - Date.parse(i.at) <= DRONE_CARD_MAX_AGE_MS)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const picked: LiveInsightView[] = [];
  const critical = recent.find((i) => i.severity === "critical");
  if (critical) picked.push(critical);
  const warning = recent.find((i) => i.severity === "warning");
  if (warning && (!critical || Date.parse(warning.at) > Date.parse(critical.at))) picked.push(warning);
  return picked.slice(0, DRONE_CARDS_MAX).map((i) => ({
    id: `D:${i.id}`,
    tone: i.severity === "critical" ? "red" : "amber",
    icon: droneIcon(i.summary),
    title: clipTitle(i.summary),
    location: i.observations[0] ? clipTitle(i.observations[0], 80) : null,
    confidence: null,
    sources: [`Dron ${droneLabel}`],
    unseen: null,
    focus: focusFor(`${i.summary} ${i.observations.join(" ")}`, scene),
  }));
}

/**
 * Suma las tarjetas del dron a «Lo crítico»: las críticas van después de la de atrapados (que
 * siempre va primero), las de advertencia al final. Hasta 4 tarjetas en total.
 */
export function withDroneCards(cards: readonly CriticalCard[], drone: readonly CriticalCard[]): CriticalCard[] {
  if (drone.length === 0) return [...cards];
  const red = drone.filter((c) => c.tone === "red");
  const rest = drone.filter((c) => c.tone !== "red");
  const head = cards[0]?.id === "trapped" ? [cards[0]] : [];
  const tail = cards.slice(head.length);
  const merged = [...head, ...red, ...tail, ...rest];
  // Lo que viene del dron no se corta: se recortan primero las tarjetas de más abajo de la radio/videos.
  const max = 4;
  if (merged.length <= max) return merged;
  const keepOthers = max - drone.length;
  const others = [...head, ...tail].slice(0, Math.max(keepOthers, 0));
  return [...others.slice(0, head.length), ...red, ...others.slice(head.length), ...rest].slice(0, max);
}

/* ───────────────────────────── Mapa ───────────────────────────── */

function unitStatusText(status: CommsAnalysis["units"][number]["status"]): string {
  switch (status) {
    case "on_scene":
    case "operating":
      return "6-3 en el lugar";
    case "en_route":
    case "dispatched":
      return "en camino";
    case "available":
      return "6-8 disponible";
    default:
      return "sin informe";
  }
}

export function buildMap(
  incident: Pick<Incident, "lat" | "lng" | "origin">,
  scene: SceneModel | null,
  comms: CommsAnalysis | null,
  media: readonly Pick<MediaView, "id" | "label" | "lat" | "lng" | "heading_deg">[],
  opts: { arriving: boolean },
): FichaMap {
  const origin: LatLng = { lat: incident.lat, lng: incident.lng };
  const center: LngLat = [incident.lng, incident.lat];
  const parts: Part[] = [];
  const houses: HouseSpec[] = [];
  const houseBlocks: Part[] = [];
  const smokes: Smoke[] = [];
  const hideBase: FichaMap["hideBase"] = [];
  const outlines: FichaMap["outlines"] = [];
  const zones: Zone[] = [];
  const cones: Cone[] = [];
  const pins: MapPin[] = [];
  let halo: FichaMap["halo"] = null;
  const s = opts.arriving ? null : scene;

  if (s) {
    for (const st of s.structures ?? []) {
      if (st.role === "reference") continue;
      houses.push(houseSpec(st, s.fire_zones ?? []));
      houseBlocks.push(...houseParts(origin, st, s.fire_zones ?? []));
      hideBase.push(houseClearance(origin, st));
      outlines.push(houseOutline(origin, st));
    }
    for (const v of s.vehicles ?? []) parts.push(...vehicleParts(origin, v));

    // Humo: las columnas que ubicó la IA; si no hay, una por foco de fuego (desde el techo de su casa).
    const roofOf = (structureId: string, x: number, y: number) => {
      const st = (s.structures ?? []).find((t) => t.id === structureId) ??
        (s.structures ?? []).find((t) => Math.abs(t.x - x) <= finite(t.width_m, 8) / 2 + 1 && Math.abs(t.y - y) <= finite(t.depth_m, 10) / 2 + 1);
      // Desde la cumbrera si el techo es a dos aguas.
      return st ? Math.max(1, Math.round(finite(st.floors, 1))) * finite(st.floor_height_m, 2.7) + roofHeightOf(st) + 1 : 4;
    };
    for (const k of s.smoke_plumes ?? []) {
      if (k.volume === "none") continue;
      smokes.push({
        id: k.id || `K${smokes.length}`,
        at: lngLat(origin, { x: finite(k.x), y: finite(k.y) }),
        base: finite(k.z, 0) > 0 ? finite(k.z) : roofOf("", finite(k.x), finite(k.y)),
        volume: k.volume,
        color: k.color,
        driftDeg: finite(k.drift_deg, -1) >= 0 ? finite(k.drift_deg) : null,
      });
    }
    if (!smokes.length) {
      (s.fire_zones ?? []).forEach((f, i) => {
        const volume = f.intensity === "heavy" ? "heavy" : f.intensity === "light" ? "light" : "moderate";
        smokes.push({
          id: `KF${i}`,
          at: lngLat(origin, { x: finite(f.x), y: finite(f.y) }),
          base: roofOf(f.structure_id, finite(f.x), finite(f.y)),
          volume,
          color: f.intensity === "heavy" ? "black" : "gray",
          driftDeg: null,
        });
      });
    }
    (s.fire_zones ?? []).forEach((f, i) => {
      const at = lngLat(origin, { x: finite(f.x), y: finite(f.y) });
      if (i === 0) halo = { at, tone: "orange" };
      const floor = finite(f.floor, 0);
      const side = SIDE_LETTER[f.side as string];
      const parts = [floor > 0 ? `${floor}º piso` : null, side ? `lado ${side}` : null].filter(Boolean);
      pins.push({ id: `F${i}`, kind: "fire", tone: "orange", at, text: parts.length ? `Foco · ${parts.join(", ")}` : "Foco", sub: null, priority: 90 - i });
    });
    // Personas: las del mismo estado a menos de 3 m se juntan en un solo marcador ("2 personas atrapadas").
    const groups: { id: string; status: string; x: number; y: number; n: number; conf: Confidence; atRisk: boolean }[] = [];
    const rank: Record<Confidence, number> = { high: 3, medium: 2, low: 1 };
    for (const p of s.people ?? []) {
      const atRisk = p.status === "trapped" || p.status === "at_window_or_balcony" || p.status === "on_roof";
      if (!atRisk && p.status !== "injured") continue;
      const x = finite(p.x);
      const y = finite(p.y);
      const n = Math.max(1, finite(p.count, 1));
      const near = groups.find((g) => g.status === p.status && Math.hypot(g.x - x, g.y - y) < 3);
      if (near) {
        near.n += n;
        if (rank[p.confidence] < rank[near.conf]) near.conf = p.confidence;
      } else groups.push({ id: p.id, status: p.status, x, y, n, conf: p.confidence, atRisk });
    }
    for (const g of groups) {
      const at = lngLat(origin, { x: g.x, y: g.y });
      const text = g.atRisk
        ? `${g.n} ${personWord(g.n)} ${g.status === "trapped" ? (g.n > 1 ? "atrapadas" : "atrapada") : g.status === "on_roof" ? "en el techo" : "en ventana"}`
        : `${g.n} ${g.n > 1 ? "lesionados" : "lesionado"}`;
      pins.push({ id: g.id, kind: "person", tone: "red", at, text, sub: `confianza ${CONFIDENCE_WORD[g.conf]}`, priority: g.atRisk ? 100 : 70 });
      if (g.atRisk && !halo) halo = { at, tone: "red" };
    }
    for (const h of s.hazards ?? []) {
      if (h.severity === "low") continue;
      const c = { x: finite(h.x), y: finite(h.y) };
      const r = Math.min(40, Math.max(2, finite(h.radius_m, 4)));
      const lifeThreat = h.severity === "high" && h.kind !== "traffic" && h.kind !== "crowd";
      if (h.kind !== "traffic" && h.kind !== "crowd") zones.push({ id: h.id, tone: lifeThreat ? "red" : "amber", ring: circleRing(origin, c, r) });
      const text = h.kind === "other" ? shortPlace(h.note || "Peligro", 1).slice(0, 34) || "Peligro" : (HAZARD_TEXT[h.kind] ?? "Peligro");
      pins.push({
        id: h.id,
        kind: "hazard",
        tone: h.kind === "traffic" || h.kind === "crowd" ? "gray" : "amber",
        at: lngLat(origin, c),
        text,
        sub: null,
        priority: h.kind === "traffic" || h.kind === "crowd" ? 30 : h.severity === "high" ? 60 : 40,
      });
    }
  }

  // Cámaras de vecinos: posición y rumbo de la escena (lo que la IA ubicó) o, si no, el GPS del teléfono.
  for (const m of media) {
    const sc = s?.cameras?.find((c) => c.media_ref === m.label);
    let c: LocalXY | null = null;
    let heading: number | null = null;
    if (sc) {
      c = { x: finite(sc.x), y: finite(sc.y) };
      heading = finite(sc.facing_deg);
    } else if (m.lat !== null && m.lng !== null) {
      const dy = (m.lat - origin.lat) * 111_320;
      const dx = (m.lng - origin.lng) * 111_320 * Math.cos((origin.lat * Math.PI) / 180);
      c = { x: dx, y: dy };
      heading = m.heading_deg;
    }
    if (!c) continue;
    if (heading !== null) cones.push({ id: m.label, ring: coneRing(origin, c, heading) });
    pins.push({ id: m.label, kind: "camera", tone: "blue", at: lngLat(origin, c), text: m.label, sub: null, priority: 20, mediaId: m.id });
  }

  // Puesto de mando, ruta de llegada y unidades (posición según radio, sin GPS).
  const access = scene?.access_points ?? [];
  const post = access.find((a) => a.kind === "command_post");
  const staging = access.find((a) => a.kind === "staging");
  const entry = access.find((a) => a.kind === "street_entry");
  const route: LngLat[] = [];
  const pathPts = [entry, staging, post].filter((a): a is NonNullable<typeof a> => Boolean(a));
  if (pathPts.length >= 2) {
    for (const a of pathPts) route.push(lngLat(origin, { x: finite(a.x), y: finite(a.y) }));
  }
  if (post && !opts.arriving) {
    pins.push({ id: "post", kind: "post", tone: "blue", at: lngLat(origin, { x: finite(post.x), y: finite(post.y) }), text: "Puesto de mando", sub: null, priority: 50 });
  }
  const units = (comms?.units ?? []).filter((u) => FIRE_UNIT.test(u.name.trim()));
  units.forEach((u, i) => {
    const onScene = u.status === "on_scene" || u.status === "operating";
    let at: LngLat | null = null;
    if (onScene && post && !opts.arriving) {
      at = lngLat(origin, { x: finite(post.x) + 6 + i * 7, y: finite(post.y) - 4 });
    } else if (route.length >= 2) {
      // En camino: sobre la ruta, más atrás cuanto más tarde aparece en la radio.
      const k = Math.max(0, Math.min(route.length - 2, 0));
      const a = route[k];
      const b = route[k + 1];
      const f = 0.55 - i * 0.18;
      at = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
    }
    if (!at) return;
    pins.push({ id: `U:${u.name}`, kind: "unit", tone: "blue", at, text: u.name, sub: opts.arriving ? "en camino" : unitStatusText(u.status), priority: 45 - i });
  });

  if (opts.arriving) {
    pins.push({ id: "dest", kind: "dest", tone: "gray", at: center, text: "Destino", sub: null, priority: 80 });
  }

  if (!halo && s) {
    const v = s.vehicles?.find((x) => x.entrapment_suspected || x.burning);
    if (v) halo = { at: lngLat(origin, { x: finite(v.x), y: finite(v.y) }), tone: "orange" };
  }
  return { center, smokes, parts, houses, houseBlocks, outlines, hideBase, zones, cones, route, halo, pins };
}

/* ───────────────────────────── Vigía y línea de tiempo ───────────────────────────── */

export function buildChat(incident: Incident, scene: SceneModel | null, events: readonly TimelineEvent[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  const ca = incident.comms_analysis;
  if (ca?.summary && incident.comms_analysis_updated_at) {
    out.push({ id: "radio", at: incident.comms_analysis_updated_at, from: "vigia", text: ca.summary, tag: "Resumen de radio", focus: null });
  }
  const sit = incident.situation;
  if (sit && incident.situation_updated_at) {
    out.push({
      id: "report",
      at: incident.situation_updated_at,
      from: "vigia",
      text: sit.headline,
      tag: "Informe",
      focus: focusFor(sit.headline, scene) ?? scene?.people?.find((p) => p.status === "trapped")?.id ?? null,
    });
  }
  // Alertas posteriores al último informe (las anteriores ya quedaron resumidas en él).
  const since = incident.situation_updated_at ?? "";
  for (const e of events) {
    if (e.severity !== "critical" || e.at <= since) continue;
    if (e.kind !== "alert" && e.kind !== "comms_alert") continue;
    out.push({ id: `E:${e.id}`, at: e.at, from: "vigia", text: e.title, tag: "Alerta", focus: focusFor(`${e.title} ${e.detail}`, scene) });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at)).slice(-5);
}

/* Agente Vigía: su historial (un mensaje por intervención) como entradas del panel derecho. */

const AGENT_KIND: Record<VigiaUtterance["kind"], string> = {
  presentacion: "Presentación",
  alerta: "Alerta",
  resumen: "Resumen de radio",
  respuesta: "Respuesta",
  pendiente: "Pendiente",
  contradiccion: "No calza",
  pedido_video: "Pedido de video",
  propuesta: "Propuesta de mensaje",
};

/** Mensajes del agente, de más antiguo a más reciente, con el marcador del mapa al que se refieren. */
export function agentMessages(utterances: readonly VigiaUtterance[], scene: SceneModel | null): ChatMessage[] {
  return [...utterances]
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(-12)
    .map((u) => ({
      id: `V:${u.id}`,
      at: u.at,
      from: "vigia" as const,
      text: u.text,
      tag: AGENT_KIND[u.kind] ?? null,
      focus: focusFor(u.text, scene) ?? u.evidence.find((e) => /^M\d+$/.test(e)) ?? null,
      template: u.engine === "plantilla",
    }));
}

export function buildTimeline(events: readonly TimelineEvent[]): TimelineItem[] {
  return events.slice(0, 60).map((e) => {
    const group: TimelineItem["group"] =
      e.kind === "comms" || e.kind === "comms_alert"
        ? "radio"
        : e.kind === "media_received" || e.kind === "media_analyzed" || e.kind === "media_failed"
          ? "videos"
          : e.kind === "alert"
            ? "alerts"
            : "other";
    const tone: Tone = e.severity === "critical" ? "red" : e.severity === "warning" ? "amber" : group === "radio" || group === "videos" ? "blue" : "gray";
    return { id: e.id, at: e.at, tone, group: e.severity === "critical" || e.severity === "warning" ? (group === "other" ? "alerts" : group) : group, title: e.title };
  });
}

export function filterTimeline(items: readonly TimelineItem[], f: TimelineFilter): TimelineItem[] {
  if (f === "all") return [...items];
  if (f === "alerts") return items.filter((i) => i.tone === "red" || i.tone === "amber" || i.group === "alerts");
  return items.filter((i) => i.group === f);
}

/* ───────────────────────────── Ficha completa ───────────────────────────── */

/** Camino al lugar: solo la creación y el primer despacho (lo demás aún no ocurre o no se analizó). */
function arrivingEvents(events: readonly TimelineEvent[]): TimelineEvent[] {
  const created = events.filter((e) => e.kind === "incident_created");
  const radio = events.filter((e) => e.kind === "comms");
  const first = radio.length ? [radio[radio.length - 1]] : [];
  return [...first, ...created];
}

export function buildFicha(snapshot: IncidentSnapshot, opts: { forceArriving?: boolean } = {}): Ficha {
  const { incident, media, events } = snapshot;
  const citizen = media.filter((m) => m.source !== "drone");
  const coverage = { analyzed: citizen.filter((m) => m.status === "analyzed").length, total: citizen.length };
  const arriving = Boolean(opts.forceArriving) || (!incident.situation && !incident.scene);
  const scene = incident.scene;
  const { cards, findings } = arriving ? { cards: [], findings: [] } : buildCards(incident.situation, scene, coverage);
  const map = buildMap(incident, scene, incident.comms_analysis, arriving ? [] : citizen, { arriving });
  const chat = arriving ? [] : buildChat(incident, scene, events);
  return {
    header: {
      typeLabel: TYPE_LABEL[incident.type] ?? "Emergencia",
      place: incident.address ? shortPlace(incident.address, 1) : "Sin dirección",
      code: incident.code,
      startedAt: incident.created_at,
      status: incident.status,
      unverified: !incident.verified,
    },
    arriving,
    cards,
    findings,
    map,
    chat,
    timeline: buildTimeline(arriving ? arrivingEvents(events) : events),
    coverage,
  };
}
