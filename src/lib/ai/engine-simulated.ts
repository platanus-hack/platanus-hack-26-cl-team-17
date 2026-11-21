/**
 * Motor de reglas determinista (sin red y sin leer el reloj: usa `input.now`).
 *
 * Es el motor cuando no hay credencial de Anthropic y el respaldo del pipeline
 * cuando Claude falla en la fusión. NO ve imágenes: trabaja con el tipo de
 * incidente, las notas de los vecinos, la bitácora radial y los análisis previos
 * de cada medio.
 *
 * Regla epistémica central: nunca descarta víctimas. Ausencia de evidencia no es
 * evidencia de ausencia. Solo una unidad EN EL LUGAR puede despejar
 * (`cleared_by_unit`), y eso llega por radio. Los análisis hechos por este mismo
 * motor (o cualquier análisis que no venga de Claude) no son evidencia visual:
 * como mucho llevan a "possible".
 */
import type {
  CommEntry,
  CommsAnalysis,
  Confidence,
  Construction,
  EvidenceRef,
  FireStage,
  HazardKind,
  HazardSeverity,
  IncidentType,
  Likelihood,
  Media,
  MediaAnalysis,
  PersonStatus,
  Priority,
  SceneModel,
  Severity,
  SituationReport,
  SmokeColor,
  SmokeVolume,
  StructureKind,
  StructureSide,
  TrappedStatus,
  UnitStatus,
  VehicleKind,
  VehicleState,
} from "@/lib/domain";
import { cardinalOf, distanceM, isValidLatLng, toLocal } from "@/lib/geo";
import { RADIO_GLOSSARY } from "./radio-glossary";
import type {
  CommsAnalysisInput,
  Engine,
  FusionInput,
  FusionMedia,
  MediaAnalysisInput,
} from "./types";

/* ═══════════════════════════════ Texto ═══════════════════════════════ */

export interface NormalizedText {
  /** Minúsculas, sin tildes, espacios colapsados. */
  text: string;
  /** map[i] = índice en el texto original del carácter i normalizado. */
  map: number[];
}

const COMBINING_MARKS = /[̀-ͯ]/g;

/** Normaliza (minúsculas, sin tildes) conservando el mapa al texto original. */
export function normalizeWithMap(input: string): NormalizedText {
  let text = "";
  const map: number[] = [];
  for (let i = 0; i < input.length; i++) {
    let piece = input[i]
      .normalize("NFD")
      .replace(COMBINING_MARKS, "")
      .toLowerCase()
      .replace(/[‐-―−]/g, "-")
      .replace(/º/g, "o")
      .replace(/ª/g, "a");
    if (/^\s+$/.test(piece)) piece = " ";
    if (piece === " " && (text.length === 0 || text[text.length - 1] === " ")) continue;
    for (let k = 0; k < piece.length; k++) {
      text += piece[k];
      map.push(i);
    }
  }
  if (text.endsWith(" ")) {
    text = text.slice(0, -1);
    map.pop();
  }
  return { text, map };
}

export function normalizeText(input: string): string {
  return normalizeWithMap(input).text;
}

function sliceOriginal(original: string, nt: NormalizedText, start: number, end: number): string {
  const s = Math.max(0, start);
  const e = Math.min(end, nt.map.length);
  if (e <= s) return "";
  return original.slice(nt.map[s], nt.map[e - 1] + 1).trim();
}

/** Itera todas las coincidencias sin compartir estado `lastIndex` entre llamadas. */
function execAll(re: RegExp, text: string): RegExpExecArray[] {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  const out: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  while ((m = g.exec(text)) !== null) {
    out.push(m);
    if (m[0].length === 0) g.lastIndex++;
  }
  return out;
}

interface Span {
  start: number;
  end: number;
}

function findSpans(text: string, res: readonly RegExp[]): Span[] {
  const out: Span[] = [];
  for (const re of res) {
    for (const m of execAll(re, text)) out.push({ start: m.index, end: m.index + m[0].length });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Reemplaza los tramos por espacios (las posiciones no cambian). */
function maskSpans(text: string, spans: readonly Span[]): string {
  if (spans.length === 0) return text;
  const chars = text.split("");
  for (const { start, end } of spans) {
    for (let i = start; i < end && i < chars.length; i++) chars[i] = " ";
  }
  return chars.join("");
}

interface Sentence extends Span {
  question: boolean;
}

function sentenceSpans(text: string): Sentence[] {
  const out: Sentence[] = [];
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    const ch = text[i];
    if (i === text.length || ch === "." || ch === ";" || ch === "!" || ch === "?") {
      const body = text.slice(start, i).trim();
      if (body.length > 0) out.push({ start, end: i, question: ch === "?" || body.startsWith("¿") });
      start = i + 1;
    }
  }
  return out;
}

function sentenceAt(sentences: readonly Sentence[], pos: number): Sentence | null {
  return sentences.find((s) => pos >= s.start && pos < s.end) ?? null;
}

function truncate(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[,;:.\s]+$/, "")}…`;
}

function uniq<T>(items: readonly T[]): T[] {
  return Array.from(new Set(items));
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Junta frases en orden de prioridad sin pasar de `maxWords` palabras.
 * Si la primera frase sola excede el límite, se corta en un límite de palabra.
 */
export function limitWords(sentences: readonly string[], maxWords: number): string {
  const out: string[] = [];
  let count = 0;
  for (const s of sentences) {
    const words = s.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    if (count + words.length <= maxWords) {
      out.push(words.join(" "));
      count += words.length;
    } else if (out.length === 0) {
      out.push(`${words.slice(0, maxWords).join(" ").replace(/[,;:.…]+$/, "")}.`);
      count = maxWords;
    }
  }
  return out.join(" ");
}

function timeOf(iso: string | null | undefined): number {
  if (!iso) return Number.NaN;
  return Date.parse(iso);
}

/* ═════════════════════════════ Etiquetas ═════════════════════════════ */

const INCIDENT_LABEL: Record<IncidentType, string> = {
  structure_fire: "Incendio estructural",
  vehicle_fire: "Incendio vehicular",
  wildland_fire: "Incendio forestal o de pastizal",
  vehicle_collision: "Colisión vehicular",
  hazmat: "Emergencia con materiales peligrosos",
  rescue: "Rescate",
  other: "Emergencia",
  unknown: "Emergencia de tipo no confirmado",
};

const HAZARD_LABEL: Record<HazardKind, string> = {
  gas_cylinder: "cilindros de gas",
  gas_line: "fuga o red de gas",
  power_lines: "tendido eléctrico",
  electrical: "riesgo eléctrico",
  fuel_spill: "derrame de combustible",
  hazmat_placard: "materiales peligrosos",
  collapse_risk: "riesgo de colapso",
  explosion_risk: "riesgo de explosión",
  ev_battery: "batería de vehículo eléctrico",
  solar_panels: "paneles solares",
  traffic: "tránsito vehicular",
  crowd: "aglomeración de público",
  water_hazard: "riesgo acuático",
  other: "otro peligro",
};

const STAGE_LABEL: Record<FireStage, string> = {
  none: "sin fuego visible",
  incipient: "compatible con etapa incipiente",
  growth: "compatible con etapa de crecimiento",
  fully_developed: "compatible con pleno desarrollo",
  decay: "compatible con decaimiento",
  unknown: "de etapa no determinada",
};

const SIDE_LABEL: Record<StructureSide, string> = {
  front: "fachada (lado Alfa)",
  rear: "lado posterior (Charlie)",
  left: "costado izquierdo",
  right: "costado derecho",
  roof: "techumbre",
  interior: "interior",
  whole_floor: "todo el piso",
  unknown: "costado no determinado",
};

const PERSON_LABEL: Record<PersonStatus, string> = {
  trapped: "atrapada",
  at_window_or_balcony: "en ventana o balcón",
  on_roof: "en el techo",
  injured: "lesionada",
  evacuating: "evacuando",
  bystander: "transeúnte",
  responder: "rescatista",
  unknown: "en condición no determinada",
};

const STRUCTURE_LABEL: Record<StructureKind, string> = {
  house_1_story: "casa de 1 piso",
  house_2_story: "casa de 2 pisos",
  apartment_building: "edificio de departamentos",
  commercial: "local comercial",
  industrial: "recinto industrial",
  warehouse: "bodega o galpón",
  informal_settlement: "vivienda de material ligero o campamento",
  other: "edificación",
  unknown: "edificación de tipo no determinado",
};

const VEHICLE_LABEL: Record<VehicleKind, string> = {
  car: "auto",
  suv_pickup: "camioneta",
  van: "furgón",
  truck: "camión",
  bus: "bus",
  motorcycle: "moto",
  bicycle: "bicicleta",
  trailer: "remolque",
  other: "vehículo",
};

const VEHICLE_STATE_LABEL: Record<VehicleState, string> = {
  upright: "sobre sus ruedas",
  on_side: "de costado",
  overturned: "volcado",
  crushed: "aplastado",
  burning: "en llamas",
  unknown: "en estado no determinado",
};

const TRAPPED_LABEL: Record<TrappedStatus, string> = {
  confirmed: "confirmadas",
  probable: "probables",
  possible: "posibles",
  no_evidence: "sin evidencia (no descarta)",
  cleared_by_unit: "descartadas por unidad en el lugar",
};

const ORDINAL_WORD: Record<number, string> = {
  1: "primer",
  2: "segundo",
  3: "tercer",
  4: "cuarto",
  5: "quinto",
  6: "sexto",
  7: "séptimo",
  8: "octavo",
  9: "noveno",
  10: "décimo",
};

function floorText(n: number): string {
  return n > 0 ? `${n}º piso` : "piso no determinado";
}

function spokenFloor(n: number): string {
  return ORDINAL_WORD[n] ? `${ORDINAL_WORD[n]} piso` : `piso ${n}`;
}

const CONF_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };
const HAZ_RANK: Record<HazardSeverity, number> = { low: 0, medium: 1, high: 2 };
const PRIORITY_RANK: Record<Priority, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const LIKELIHOOD_RANK: Record<Likelihood, number> = { no_evidence: 0, possible: 1, probable: 2, confirmed: 3 };
const STAGE_RANK: Record<FireStage, number> = {
  unknown: -1,
  none: 0,
  decay: 1,
  incipient: 2,
  growth: 3,
  fully_developed: 4,
};
const TRAPPED_PERSON: readonly PersonStatus[] = ["trapped", "at_window_or_balcony", "on_roof"];

function maxConf(a: Confidence, b: Confidence): Confidence {
  return CONF_RANK[a] >= CONF_RANK[b] ? a : b;
}

function maxLikelihood(a: Likelihood, b: Likelihood): Likelihood {
  return LIKELIHOOD_RANK[a] >= LIKELIHOOD_RANK[b] ? a : b;
}

function isFireType(t: IncidentType): boolean {
  return t === "structure_fire" || t === "vehicle_fire" || t === "wildland_fire";
}

/* ═════════════════════════ Vocabulario compartido ═════════════════════════ */

const COUNT_WORDS: Record<string, number> = {
  un: 1,
  una: 1,
  uno: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
};
const COUNT_RE =
  /\b(\d{1,2}|un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez) (personas?|victimas?|lesionad[oa]s?|herid[oa]s?|atrapad[oa]s?|ninos?|ninas?|adult[oa]s?|moradore?s?|ocupantes?|mujer(es)?|hombres?|menores?|senoras?|senores?)\b/;

function countIn(text: string): number | null {
  const m = COUNT_RE.exec(text);
  if (!m) return null;
  const n = /^\d+$/.test(m[1]) ? Number(m[1]) : (COUNT_WORDS[m[1]] ?? 0);
  return n > 0 ? n : null;
}

const ORDINAL_NUM: Record<string, number> = {
  primer: 1,
  primero: 1,
  "1er": 1,
  "1o": 1,
  segundo: 2,
  "2do": 2,
  "2o": 2,
  tercer: 3,
  tercero: 3,
  "3er": 3,
  "3ro": 3,
  "3o": 3,
  cuarto: 4,
  "4to": 4,
  "4o": 4,
  quinto: 5,
  "5to": 5,
  "5o": 5,
  sexto: 6,
  septimo: 7,
  octavo: 8,
  noveno: 9,
  decimo: 10,
};
const FLOOR_RE =
  /\b(primer|primero|1er|1o|segundo|2do|2o|tercer|tercero|3er|3ro|3o|cuarto|4to|4o|quinto|5to|5o|sexto|septimo|octavo|noveno|decimo) (piso|nivel)\b|\bpiso (\d{1,2})\b|\b(planta baja)\b/;
const FLOORS_COUNT_RE = /\b(\d{1,2}|un|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez) pisos?\b/;

function floorIn(text: string): number {
  const m = FLOOR_RE.exec(text);
  if (!m) return 0;
  if (m[1]) return ORDINAL_NUM[m[1]] ?? 0;
  if (m[3]) return Number(m[3]);
  return 1;
}

function floorsCountIn(text: string): number {
  const m = FLOORS_COUNT_RE.exec(text);
  if (!m) return 0;
  return /^\d+$/.test(m[1]) ? Number(m[1]) : (COUNT_WORDS[m[1]] ?? 0);
}

/** Negaciones de personas atrapadas ("sin personas atrapadas", "búsqueda primaria negativa"…). */
const TRAPPED_NEGATION_RES: readonly RegExp[] = [
  /\b(sin|no hay|no se observan|no se encuentran|no se registran|no quedan|no existen|cero|ninguna?) (personas? |victimas? |gente |moradores |ocupantes )?atrapad[oa]s?\b/,
  /\b(sin|no hay|no quedan|no se encuentran) (personas?|victimas?|gente|moradores|ocupantes|nadie) (en el interior|al interior|adentro|dentro)\b/,
  /\bno hay nadie (adentro|dentro|en el interior|al interior)\b/,
  /\b(sin|no hay|no se registran) (lesionad[oa]s?|herid[oa]s?|victimas?) (ni|y|o) (personas? )?atrapad[oa]s?\b/,
  /\bni (personas? )?atrapad[oa]s?\b/,
  /\bbusqueda (primaria |secundaria )?(negativa|sin resultados|sin victimas)\b/,
  /\bprimaria negativa\b/,
  /\b(sin|no hay) victimas\b/,
  /\b(vivienda|casa|inmueble|estructura|departamento|edificio) (deshabitad[oa]|sin moradores)\b/,
];

const INJURY_NEGATION_RES: readonly RegExp[] = [
  /\b(sin|no hay|no se registran|no se observan) (personas )?(lesionad[oa]s?|herid[oa]s?)\b/,
  /\bni (lesionad[oa]s?|herid[oa]s?)\b/,
];

/** Persona rescatada: confirma que hubo víctima, pero no que siga atrapada. */
const RESCUED_RES: readonly RegExp[] = [
  /\b(persona|victima|moradora?|nino|nina|mujer|hombre|adult[oa] mayor|senora|senor|paciente)s? rescatad[oa]s?\b/,
  /\b(se )?rescat(a|o|amos|aron) (a )?(una |un |dos |\d+ )?(persona|victima|moradora?|nino|nina|mujer|hombre|adult[oa]|senora|senor)s?\b/,
];

const TRAPPED_POSITIVE_RES: readonly RegExp[] = [
  /\batrapad[oa]s?\b/,
  /\bhay (gente|personas?|alguien|ninos?|una persona|moradores|ocupantes|familia|abuelit[oa]s?|adult[oa]s? mayor(es)?|una senora|un senor|guaguas?|bebes?) (adentro|dentro|en el interior|al interior|en la casa|en el departamento|en la vivienda)\b/,
  /\b(se informan|informan|quedan?|permanecen?) (personas?|gente|alguien|moradores|ocupantes|ninos?) (adentro|dentro|en el interior|al interior)\b/,
  /\b(quedan?|permanecen?) (personas?|gente|alguien|moradores|ocupantes|ninos?|una persona|dos personas|\d+ personas)\b/,
  /\b(persona|personas|gente|alguien|victimas?|ninos?|mujer|hombre|senora|senor|adult[oa] mayor)( asomad[oa]s?)? (en|a|desde) (la |el |una |un )?(ventana|balcon|techo|azotea|techumbre)\b/,
  /\bpidiendo (auxilio|ayuda)\b/,
  /\bhaciendo senas\b/,
  /\bno (puede|pueden|alcanzo a|alcanzaron a|logra|logran) salir\b/,
  /\bno salen?\b/,
  /\bno contestan? (el telefono|la puerta|el timbre|los llamados|el celular)\b/,
  /\bpersonas? desaparecid[oa]s?\b|\bpersonas? sin ubicar\b|\bdesaparecid[oa]s?\b/,
];

/** Indicios débiles (solo para notas de vecinos): personas vulnerables mencionadas. */
const VULNERABLE_RE =
  /\b(ninos?|ninas?|abuelit[oa]s?|adult[oa]s? mayor(es)?|ancian[oa]s?|guaguas?|bebes?|senora mayor|senor mayor|postrad[oa]s?)\b/;
const GOT_OUT_RE = /\b(salieron|salio|alcanzaron a salir|alcanzo a salir|afuera|a salvo|evacuad[oa]s?|estan bien)\b/;

const INJURED_POSITIVE_RES: readonly RegExp[] = [
  /\blesionad[oa]s?\b/,
  /\bherid[oa]s?\b/,
  /\binconscientes?\b/,
  /\binhalacion de humo\b/,
  /\bquemaduras?\b/,
  /\bpacientes?\b/,
  /\bfallecid[oa]s?\b|\bvictimas? fatal(es)?\b/,
];

const MAYDAY_RE =
  /\bmay ?day\b|\bbomberos? (en peligro|atrapad[oa]s?|herid[oa]s?|perdid[oa]s?|extraviad[oa]s?|lesionad[oa]s?|accidentad[oa]s?|caid[oa]s?|sin aire|desaparecid[oa]s?|no ubicad[oa]s?)\b|\bemergencia de bombero\b/;
const MAYDAY_RESOLVED_RE =
  /\bmay ?day (resuelto|controlado|cancelado|superado|finalizado|terminado)\b|\b(se cancela|cancelo|cancela|fin del?|termino del?|se levanta|levantamos|levanta) (el )?may ?day\b|\bbomberos? (ubicad[oa]s?|rescatad[oa]s?|encontrad[oa]s?|a salvo|fuera de peligro|evacuad[oa]s?)\b/;

interface HazardRule {
  kind: HazardKind;
  re: RegExp;
  severity: HazardSeverity;
}

const HAZARD_RULES: readonly HazardRule[] = [
  { kind: "gas_cylinder", re: /\bcilindros?( de gas)?\b|\bbalon(es)? de gas\b|\bbalones\b|\bglp\b|\bgas licuado\b/, severity: "high" },
  {
    kind: "gas_line",
    re: /\bfuga de gas\b|\bmatriz de gas\b|\bmedidor de gas\b|\bred de gas\b|\bcaneria de gas\b|\bolor a gas\b|\bgas natural\b/,
    severity: "high",
  },
  {
    kind: "power_lines",
    re: /\bcables?( electricos?)? (cortad[oa]s?|caid[oa]s?|en el suelo|energizad[oa]s?|sueltos?)\b|\bcables? de (alta|media) tension\b|\bposte caido\b/,
    severity: "high",
  },
  { kind: "power_lines", re: /\btendido electrico\b|\bcables\b|\bposte\b|\btransformador\b/, severity: "medium" },
  {
    kind: "electrical",
    re: /\bempalme\b|\bcortocircuito\b|\benergizad[oa]s?\b|\briesgo electrico\b|\bchispas\b|\barco electrico\b/,
    severity: "medium",
  },
  { kind: "fuel_spill", re: /\bderrame\b|\bbencina\b|\bcombustible\b|\bpetroleo\b|\bdiesel\b|\baceite\b/, severity: "medium" },
  {
    kind: "hazmat_placard",
    re: /\bmateriales? peligrosos?\b|\bmatpel\b|\bhazmat\b|\brombo\b|\bnumero onu\b|\bquimicos?\b|\btoxic[oa]s?\b|\bcorrosiv[oa]s?\b/,
    severity: "high",
  },
  {
    kind: "collapse_risk",
    re: /\bcolaps\w*|\bderrumb\w*|\bse (cae|cayo|vino abajo|hundio)\b|\b(techo|techumbre) (cedio|cede|colapsa)\b|\bgrietas?\b|\bmuro (inestable|desaplomado)\b|\briesgo de caida\b/,
    severity: "high",
  },
  { kind: "explosion_risk", re: /\bexplosi\w*|\bexplot\w*|\bestallid\w*|\bbleve\b/, severity: "high" },
  {
    kind: "ev_battery",
    re: /\b(auto|vehiculo|bus|scooter|moto|bicicleta) electric[oa]\b|\bhibrid[oa]\b|\bbaterias? de litio\b|\blitio\b/,
    severity: "high",
  },
  { kind: "solar_panels", re: /\bpaneles? solar(es)?\b|\bfotovoltaic\w*/, severity: "medium" },
  { kind: "traffic", re: /\btrafico\b|\btransito (vehicular|intenso|activo)\b|\bautopista\b|\bflujo vehicular\b/, severity: "medium" },
  { kind: "crowd", re: /\bmucha gente mirando\b|\baglomeracion\b|\bcurios[oa]s\b|\bmultitud\b/, severity: "low" },
  { kind: "water_hazard", re: /\bcanal\b|\brio\b|\bestero\b|\bal agua\b/, severity: "medium" },
];

const NEGATED_BEFORE_RE = /\b(sin|no hay|no se observan?|no existe|descarta)\s*$/;

interface HazardHit {
  kind: HazardKind;
  severity: HazardSeverity;
  start: number;
}

function findHazards(text: string): HazardHit[] {
  const hits = new Map<HazardKind, HazardHit>();
  for (const rule of HAZARD_RULES) {
    for (const m of execAll(rule.re, text)) {
      const before = text.slice(Math.max(0, m.index - 16), m.index);
      if (NEGATED_BEFORE_RE.test(before)) continue;
      const prev = hits.get(rule.kind);
      if (!prev || HAZ_RANK[rule.severity] > HAZ_RANK[prev.severity]) {
        hits.set(rule.kind, { kind: rule.kind, severity: rule.severity, start: m.index });
      }
      break;
    }
  }
  return Array.from(hits.values()).sort((a, b) => a.start - b.start);
}

const FIRE_MENTION_RE = /\bfuego\b|\bllamas?\b|\bincendio\b|\bse (esta )?quemando\b|\bse quema\b|\bardiendo\b|\bprendio\b|\bse incendi\w*/;
const SMOKE_RE = /\bhumo\b|\bhumareda\b/;
const HYDRANT_RE = /\bgrifos?\b|\bhidrantes?\b|\bred seca\b/;

/* ═════════════════════════════ Unidades ═════════════════════════════ */

const UNIT_RE = /\b([a-z]{1,3})(-| )?(\d{1,3})\b/;
const UNIT_STOPWORDS = new Set([
  "a", "al", "d", "de", "del", "el", "en", "es", "la", "las", "le", "lo", "los", "me", "mi", "n", "ni", "no", "nos",
  "nro", "num", "o", "por", "que", "se", "si", "son", "su", "sus", "te", "tu", "un", "una", "va", "y", "ya", "con",
  "mas", "hay", "km", "kg", "hrs", "hr", "min", "seg", "mts", "mt", "cm", "mm", "kv", "kw", "am", "pm", "h",
]);
/** Con espacio entre letras y número solo se aceptan prefijos de unidad conocidos ("B 3", "RX 15"). */
const UNIT_PREFIXES_WITH_SPACE = new Set([
  "b", "bx", "br", "bt", "bf", "bh", "q", "rx", "r", "z", "k", "j", "ab", "ut", "ur", "rh", "rb", "cx", "m",
]);

export interface UnitMention {
  name: string;
  start: number;
  end: number;
}

/** Busca identificadores de unidad ("B-3", "B3", "BX-2", "RX 7", "H-1"…) en texto normalizado. */
export function findUnitMentions(normText: string): UnitMention[] {
  const out: UnitMention[] = [];
  for (const m of execAll(UNIT_RE, normText)) {
    const prefix = m[1];
    const sep = m[2] ?? "";
    // "H-1" sí; "h" solo (horas) no.
    if (UNIT_STOPWORDS.has(prefix) && !(prefix === "h" && sep === "-")) continue;
    if (sep === " " && !UNIT_PREFIXES_WITH_SPACE.has(prefix)) continue;
    out.push({
      name: `${prefix.toUpperCase()}-${String(Number(m[3]))}`,
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return out;
}

export function extractUnitIds(text: string): string[] {
  return uniq(findUnitMentions(normalizeText(text)).map((u) => u.name));
}

const CENTRAL_RE = /\b(central|cat|centro de alarmas|telecomunicaciones|despacho|alarmas)\b/;

interface StatusRule {
  re: RegExp;
  status: UnitStatus;
}

// El orden importa: la primera regla que calza un tramo se queda con él.
const STATUS_RULES: readonly StatusRule[] = [
  { re: /\bllegando en \d+/, status: "en_route" },
  {
    re: /\ben el lugar\b|\ben el sitio\b|\ben la escena\b|\bllegando\b|\bllegamos\b|\barribando\b|\barribamos\b|\bllegue\b/,
    status: "on_scene",
  },
  {
    re: /\ben camino\b|\bsaliendo\b(?! de (la|el|los|las) (estructura|casa|vivienda|edificio|interior|inmueble|departamento))|\ben ruta\b|\ben transito\b|\bnos dirigimos\b|\bse dirige\b|\bvoy en ruta\b/,
    status: "en_route",
  },
  { re: /\bdespachad[oa]s?\b|\bse despacha(n)?\b|\bconcurr\w*|\bsalgan\b|\bsalir a\b/, status: "dispatched" },
  {
    re: /\btrabajando\b|\boperando\b|\barmada\b|\barmando\b|\barmamos\b|\batacando\b|\ben ataque\b|\bcon agua\b|\bposicionando\b/,
    status: "operating",
  },
  {
    re: /\bdisponible\b|\ben cuartel\b|\bretirandose\b|\bnos retiramos\b|\bse retira\b|\bregresando al? cuartel\b|\bde regreso al? cuartel\b/,
    status: "available",
  },
];

interface PhraseHit extends Span {
  status: UnitStatus;
}

/** "humo saliendo por el techo" o "el fuego está llegando al 4º piso" no hablan de una unidad. */
const NON_UNIT_SUBJECT_RE = /\b(humo|fuego|llamas?|agua|gas|gente|personas?|vecinos?|alguien|propagacion|calor)\b[^.,;]{0,15}$/;

function findStatusPhrases(text: string): PhraseHit[] {
  const hits: PhraseHit[] = [];
  for (const rule of STATUS_RULES) {
    for (const m of execAll(rule.re, text)) {
      const start = m.index;
      const end = start + m[0].length;
      if (hits.some((h) => start < h.end && end > h.start)) continue;
      if (/^(saliendo|llegando)/.test(m[0]) && NON_UNIT_SUBJECT_RE.test(text.slice(Math.max(0, start - 30), start))) continue;
      hits.push({ start, end, status: rule.status });
    }
  }
  return hits.sort((a, b) => a.start - b.start);
}

type StatusItem = { pos: number; unit: string } | { pos: number; status: UnitStatus };

/**
 * Asigna estados a unidades dentro de cada frase:
 *  - "B-3 en el lugar, RX-7 en camino" → cada unidad toma la frase de estado que le sigue.
 *  - "despachadas B-3 y RX-7" → una frase de estado sin unidad previa pasa a las que le siguen.
 *  - "en el lugar" sin unidades → el emisor (si es una unidad).
 */
function assignStatuses(
  sentences: readonly Sentence[],
  phrases: readonly PhraseHit[],
  mentions: readonly UnitMention[],
  speakerUnit: string | null,
): Array<[string, UnitStatus]> {
  const out: Array<[string, UnitStatus]> = [];
  const give = (names: readonly string[], status: UnitStatus) => {
    for (const n of names) out.push([n, status]);
  };
  const giveSpeaker = (status: UnitStatus) => {
    if (speakerUnit) out.push([speakerUnit, status]);
  };
  for (const s of sentences) {
    if (s.question) continue;
    const items: StatusItem[] = [
      ...mentions.filter((m) => m.start >= s.start && m.end <= s.end).map((m) => ({ pos: m.start, unit: m.name })),
      ...phrases.filter((p) => p.start >= s.start && p.end <= s.end).map((p) => ({ pos: p.start, status: p.status })),
    ].sort((a, b) => a.pos - b.pos);
    let pending: string[] = [];
    let headless: UnitStatus | null = null;
    for (const it of items) {
      if ("unit" in it) {
        pending.push(it.unit);
        continue;
      }
      if (headless) giveSpeaker(headless);
      if (pending.length > 0) {
        give(pending, it.status);
        pending = [];
        headless = null;
      } else {
        headless = it.status;
      }
    }
    if (headless) {
      if (pending.length > 0) give(pending, headless);
      else giveSpeaker(headless);
    }
  }
  return out;
}

function isOnScene(s: UnitStatus | undefined): boolean {
  return s === "on_scene" || s === "operating";
}

/* ═══════════════════════ Recursos solicitados ═══════════════════════ */

interface ResourceGroup {
  id: string;
  re: RegExp;
}

const RESOURCE_GROUPS: readonly ResourceGroup[] = [
  { id: "ambulance", re: /\bambulancias?\b|\bsamu\b|\bsapu\b|\bparamedic\w*/ },
  { id: "police", re: /\bcarabineros\b|\bpolicia\b|\bpdi\b/ },
  { id: "ladder", re: /\bescalas?\b|\bmecanicas?\b|\bportaescalas?\b|\bbrazo\b/ },
  { id: "rescue", re: /\b(unidad|carro|material) de rescate\b|\brescate vehicular\b|\bextricacion\b/ },
  { id: "water", re: /\baljibes?\b|\bcisternas?\b|\babastecimiento\b|\bagua\b/ },
  {
    id: "power",
    re: /\bcge\b|\benel\b|\bchilquinta\b|\bcompania electrica\b|\bempresa electrica\b|\bcorte de (luz|energia|electricidad)\b|\belectrica\b/,
  },
  { id: "gas", re: /\bmetrogas\b|\bgasco\b|\babastible\b|\blipigas\b|\bcompania de gas\b|\bempresa de gas\b|\bcorte de gas\b/ },
  { id: "hazmat", re: /\bhazmat\b|\bmateriales peligrosos\b|\bmatpel\b/ },
  { id: "drone", re: /\bdron(es)?\b/ },
  {
    id: "more_units",
    re: /\bmas (unidades|carros|material|personal|bombas|apoyo)\b|\bapoyo\b|\botra (bomba|unidad)\b|\bmaterial mayor\b|\balarma\b|\brefuerzos?\b/,
  },
];

const REQUEST_RE =
  /\b(solicito|solicita|solicitamos|se solicita|solicitar|requiero|requerimos|se requiere|necesito|necesitamos|se necesita|se necesitan|pido|pedimos|envien)\b/;
const NON_RESOURCE_RE = /^(informacion|informe|confirmar|confirmacion|que |si |datos|reporte|nombre|antecedentes|ver |saber )/;
const ARRIVAL_RE = /\b(en el lugar|llego|llegaron|llegando|arribo|arribaron|presente|se encuentra en el lugar|en la escena|recibe|recibimos)\b/;
const CANCEL_RE = /\bcancel\w*|\bse anula\b|\bya no (se )?(requiere|necesita)\b|\bsin necesidad de\b|\bno se requiere\b/;

function groupsIn(text: string): string[] {
  return RESOURCE_GROUPS.filter((g) => g.re.test(text)).map((g) => g.id);
}

/* ═══════════════════════ Otros patrones radiales ═══════════════════════ */

const ALARM_RE = /\b(segunda|2a|2da|tercera|3a|3ra|cuarta|4a|quinta|5a) alarma\b|\balarma general\b/;
const FIRE_CONTROLLED_RE =
  /\b(fuego|incendio|emergencia) (controlad[oa]|dominad[oa]|circunscrit[oa]|confinad[oa]|extinguid[oa])\b|\bcontrolado el (fuego|incendio)\b|\bremocion\b/;
const SIZE_UP_RE =
  /\bpre-? ?informe\b|\bse trata de\b|\binforme de situacion\b|\bestrategia (ofensiva|defensiva)\b|\bcasa habitacion\b|\bpeligro de propagacion\b|\bfuego (declarado )?en (un |el |la )?\w* ?(del )?(primer|segundo|tercer|cuarto|quinto|\d+\w*) piso\b|\blado principal\b/;
const ORDER_RE =
  /\b(procedan?|ingresen|evacuen|evacuar|retirense|ataquen|ventilen|protejan|revisen|corten|desplieguen|despejen|aislen)\b/;
const COMMAND_RE =
  /\basum(o|e|imos) (el )?mando\b|\bqueda a cargo\b|\ba cargo\b|\bobac\b|\bpuesto de (comando|mando)\b|\bal mando\b|\bcomandante del incidente\b/;
const POST_RE = /\bpuesto de (comando|mando) (en|ubicado en|se ubica en|instalado en|esta en|queda en)\s+/;
const NUMERIC_CODE_RE = /\b\d{1,2}-\d{1,2}\b/;

interface GlossaryMatcher {
  index: number;
  res: RegExp[];
}

const GLOSSARY_MATCHERS: readonly GlossaryMatcher[] = RADIO_GLOSSARY.map((e, index) => ({
  index,
  res: e.aliases.map((a) => new RegExp(`\\b${escapeRe(a)}\\b`)),
}));
const UNIT_IDS_GLOSSARY_INDEX = RADIO_GLOSSARY.findIndex((e) => e.aliases.length === 0);

/** Términos del glosario presentes (coincidencia más larga primero, sin solapes). */
function glossaryHits(text: string): number[] {
  const cands: Array<Span & { index: number }> = [];
  for (const gm of GLOSSARY_MATCHERS) {
    for (const re of gm.res) {
      for (const m of execAll(re, text)) cands.push({ start: m.index, end: m.index + m[0].length, index: gm.index });
    }
  }
  cands.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
  const taken: Span[] = [];
  const found: number[] = [];
  for (const c of cands) {
    if (taken.some((t) => c.start < t.end && c.end > t.start)) continue;
    taken.push(c);
    found.push(c.index);
  }
  return found;
}

/* ═════════════════════ Análisis de comunicaciones ═════════════════════ */

type CommsEvent = CommsAnalysis["events"][number];

interface UnitInfo {
  status: UnitStatus;
  lastReport: string;
}

export interface VictimReport {
  seq: number;
  kind: "trapped" | "injured" | "rescued";
  speaker: string;
  speakerUnit: string | null;
  byOnSceneUnit: boolean;
  count: number | null;
  floor: number;
  text: string;
  at: string;
}

export interface UnitDenial {
  seq: number;
  speaker: string;
  speakerUnit: string | null;
  byOnSceneUnit: boolean;
  text: string;
  at: string;
}

interface ResourceRequest {
  seq: number;
  speaker: string;
  text: string;
  groups: string[];
  units: string[];
  resolved: boolean;
}

export interface RadioHazard {
  kind: HazardKind;
  severity: HazardSeverity;
  seq: number;
  text: string;
}

/** Hechos que extraen las reglas de la bitácora (los usa también la fusión). */
export interface CommsFacts {
  units: Map<string, UnitInfo>;
  events: CommsEvent[];
  reports: VictimReport[];
  denials: UnitDenial[];
  /** seq → el emisor era una unidad en el lugar al hablar. */
  onSceneSpeakerBySeq: Map<number, boolean>;
  maydayActive: boolean;
  maydayDetail: string;
  maydaySeqs: number[];
  requests: ResourceRequest[];
  hazards: RadioHazard[];
  command: { established: boolean; commander: string; post: string; seq: number | null };
  fireControlledSeq: number | null;
  fireMentionSeqs: number[];
  hydrantSeqs: number[];
  glossary: number[];
  numericCodes: string[];
  entryCount: number;
}

export function runCommsRules(comms: readonly CommEntry[]): CommsFacts {
  const sorted = [...comms].sort((a, b) => a.seq - b.seq);
  const facts: CommsFacts = {
    units: new Map(),
    events: [],
    reports: [],
    denials: [],
    onSceneSpeakerBySeq: new Map(),
    maydayActive: false,
    maydayDetail: "",
    maydaySeqs: [],
    requests: [],
    hazards: [],
    command: { established: false, commander: "", post: "", seq: null },
    fireControlledSeq: null,
    fireMentionSeqs: [],
    hydrantSeqs: [],
    glossary: [],
    numericCodes: [],
    entryCount: sorted.length,
  };
  const glossarySet = new Set<number>();
  const codeSet = new Set<string>();

  for (const entry of sorted) {
    const seq = entry.seq;
    const nt = normalizeWithMap(entry.text);
    const t0 = nt.text;
    const speakerNorm = normalizeText(entry.speaker);
    const isCentral = CENTRAL_RE.test(speakerNorm);
    const speakerLabel = entry.speaker.trim() || "Emisor no identificado";
    const mentions = findUnitMentions(t0);
    let speakerUnit: string | null = isCentral ? null : (findUnitMentions(speakerNorm)[0]?.name ?? null);
    if (!speakerUnit && !isCentral && mentions.length > 0) {
      const first = mentions[0];
      const lead = t0.slice(Math.max(0, first.start - 7), first.start);
      if (first.start === 0 || /\b(aqui|habla)\s$/.test(lead)) speakerUnit = first.name;
    }
    const sentences = sentenceSpans(t0);
    const statements = sentences.filter((s) => !s.question);
    const sentenceOrig = (pos: number): string => {
      const s = sentenceAt(sentences, pos);
      return truncate(s ? sliceOriginal(entry.text, nt, s.start, s.end) : entry.text, 180);
    };
    const inStatement = (pos: number) => statements.some((s) => pos >= s.start && pos < s.end);
    const push = (kind: CommsEvent["kind"], text: string, priority: CommsEvent["priority"]) => {
      facts.events.push({ entry_seq: seq, kind, text, priority });
    };

    // Glosario y claves numéricas.
    for (const i of glossaryHits(`${speakerNorm} . ${t0}`)) glossarySet.add(i);
    if (mentions.length > 0 || speakerUnit) glossarySet.add(UNIT_IDS_GLOSSARY_INDEX);
    for (const m of execAll(NUMERIC_CODE_RE, t0)) codeSet.add(m[0]);

    // 1) Estados de unidades.
    const report = `C${seq}: ${truncate(entry.text, 140)}`;
    const touch = (name: string) => {
      const u = facts.units.get(name);
      if (u) u.lastReport = report;
      else facts.units.set(name, { status: "unknown", lastReport: report });
    };
    if (speakerUnit) touch(speakerUnit);
    for (const m of mentions) touch(m.name);
    const before = new Map<string, UnitStatus>();
    for (const [name, u] of facts.units) before.set(name, u.status);
    const assigned = assignStatuses(sentences, findStatusPhrases(t0), mentions, speakerUnit);
    const arrivedNow: string[] = [];
    const dispatchedNow: string[] = [];
    const availableNow: string[] = [];
    for (const [name, status] of assigned) {
      const u = facts.units.get(name);
      if (!u) continue;
      u.status = status;
      if (isOnScene(status) && !isOnScene(before.get(name)) && !arrivedNow.includes(name)) arrivedNow.push(name);
      if (status === "dispatched" && !dispatchedNow.includes(name)) dispatchedNow.push(name);
      if (status === "available" && !availableNow.includes(name)) availableNow.push(name);
    }
    const firstArrivalEver = arrivedNow.length > 0 && Array.from(before.values()).every((s) => !isOnScene(s));
    for (const name of arrivedNow) {
      const text = name === speakerUnit ? `${name} informa llegada al lugar.` : `${name} en el lugar (según ${speakerLabel}).`;
      push("arrival", text, firstArrivalEver && name === arrivedNow[0] ? "important" : "routine");
    }
    if (dispatchedNow.length > 0) push("dispatch", `Despacho de ${dispatchedNow.join(", ")}.`, "routine");
    for (const name of availableNow) push("status_update", `${name} queda disponible o se retira.`, "routine");
    const speakerOnScene = speakerUnit !== null && isOnScene(facts.units.get(speakerUnit)?.status);
    facts.onSceneSpeakerBySeq.set(seq, speakerOnScene);

    // 2) Mayday, negaciones y víctimas (sobre texto enmascarado, solo afirmaciones).
    const questionSpans = sentences.filter((s) => s.question);
    let t = maskSpans(t0, questionSpans);
    const resolvedSpans = findSpans(t, [MAYDAY_RESOLVED_RE]);
    t = maskSpans(t, resolvedSpans);
    const maydaySpans = findSpans(t, [MAYDAY_RE]);
    t = maskSpans(t, maydaySpans);
    const clearSpans = findSpans(t, TRAPPED_NEGATION_RES);
    t = maskSpans(t, clearSpans);
    t = maskSpans(t, findSpans(t, INJURY_NEGATION_RES));
    const rescuedSpans = findSpans(t, RESCUED_RES);
    t = maskSpans(t, rescuedSpans);
    const trappedSpans = findSpans(t, TRAPPED_POSITIVE_RES);
    const injuredSpans = findSpans(t, INJURED_POSITIVE_RES);

    if (maydaySpans.length > 0 || resolvedSpans.length > 0) {
      const lastMayday = maydaySpans.length > 0 ? maydaySpans[maydaySpans.length - 1].start : -1;
      const lastResolved = resolvedSpans.length > 0 ? resolvedSpans[resolvedSpans.length - 1].start : -1;
      if (maydaySpans.length > 0) {
        const s = sentenceOrig(maydaySpans[0].start);
        push("mayday", `MAYDAY (${speakerLabel}): «${s}»`, "critical");
        facts.maydaySeqs.push(seq);
      }
      if (resolvedSpans.length > 0 && (facts.maydayActive || maydaySpans.length > 0)) {
        push("status_update", `Emergencia de bombero resuelta (${speakerLabel}): «${sentenceOrig(resolvedSpans[0].start)}»`, "important");
        facts.maydaySeqs.push(seq);
      }
      if (lastMayday > lastResolved) {
        facts.maydayActive = true;
        facts.maydayDetail = `C${seq} · ${speakerLabel}: ${sentenceOrig(maydaySpans[0].start)}`;
      } else if (resolvedSpans.length > 0 && facts.maydayActive) {
        facts.maydayActive = false;
        facts.maydayDetail = `Resuelto en C${seq} · ${speakerLabel}: ${sentenceOrig(resolvedSpans[0].start)}`;
      }
    }

    const onSceneTag = speakerOnScene ? ", en el lugar" : "";
    if (trappedSpans.length > 0) {
      const s = sentenceAt(sentences, trappedSpans[0].start);
      const sNorm = s ? t0.slice(s.start, s.end) : t0;
      facts.reports.push({
        seq,
        kind: "trapped",
        speaker: speakerLabel,
        speakerUnit,
        byOnSceneUnit: speakerOnScene,
        count: countIn(sNorm),
        floor: floorIn(sNorm),
        text: sentenceOrig(trappedSpans[0].start),
        at: entry.at,
      });
      push("victim_report", `Reporte de personas atrapadas (${speakerLabel}${onSceneTag}): «${sentenceOrig(trappedSpans[0].start)}»`, "critical");
    }
    if (injuredSpans.length > 0) {
      const s = sentenceAt(sentences, injuredSpans[0].start);
      const sNorm = s ? t0.slice(s.start, s.end) : t0;
      facts.reports.push({
        seq,
        kind: "injured",
        speaker: speakerLabel,
        speakerUnit,
        byOnSceneUnit: speakerOnScene,
        count: countIn(sNorm),
        floor: floorIn(sNorm),
        text: sentenceOrig(injuredSpans[0].start),
        at: entry.at,
      });
      push("victim_report", `Reporte de lesionados (${speakerLabel}${onSceneTag}): «${sentenceOrig(injuredSpans[0].start)}»`, "important");
    }
    if (rescuedSpans.length > 0) {
      const s = sentenceAt(sentences, rescuedSpans[0].start);
      const sNorm = s ? t0.slice(s.start, s.end) : t0;
      facts.reports.push({
        seq,
        kind: "rescued",
        speaker: speakerLabel,
        speakerUnit,
        byOnSceneUnit: speakerOnScene,
        count: countIn(sNorm),
        floor: floorIn(sNorm),
        text: sentenceOrig(rescuedSpans[0].start),
        at: entry.at,
      });
      push("victim_report", `Persona rescatada (${speakerLabel}${onSceneTag}): «${sentenceOrig(rescuedSpans[0].start)}». Confirmar si quedan otras.`, "important");
    }
    if (clearSpans.length > 0) {
      const text = sentenceOrig(clearSpans[0].start);
      facts.denials.push({ seq, speaker: speakerLabel, speakerUnit, byOnSceneUnit: speakerOnScene, text, at: entry.at });
      if (speakerOnScene) {
        push("all_clear", `${speakerUnit}, en el lugar, informa que no hay personas atrapadas: «${text}»`, "important");
      } else {
        push(
          "other",
          `${speakerLabel} dice que no hay atrapados, pero no consta que esté en el lugar: no descarta víctimas. «${text}»`,
          "important",
        );
      }
    }

    // 3) Recursos: primero se resuelven solicitudes anteriores, luego se registran las nuevas.
    for (const s of statements) {
      const sText = t0.slice(s.start, s.end);
      const hasArrival = ARRIVAL_RE.test(sText);
      const hasCancel = CANCEL_RE.test(maskSpans(sText, findSpans(sText, [MAYDAY_RESOLVED_RE])));
      if (!hasArrival && !hasCancel) continue;
      const groupsHere = groupsIn(sText);
      const unitsHere = mentions.filter((m) => m.start >= s.start && m.end <= s.end).map((m) => m.name);
      let matched = false;
      for (const req of facts.requests) {
        if (req.resolved) continue;
        const byGroup = req.groups.some((g) => groupsHere.includes(g));
        const byUnit = hasCancel && req.units.some((u) => unitsHere.includes(u));
        if (byGroup || byUnit) {
          req.resolved = true;
          matched = true;
        }
      }
      if (hasCancel && !matched && groupsHere.length === 0 && unitsHere.length === 0 && /\b(solicitud|pedido|requerimiento)\b/.test(sText)) {
        const last = [...facts.requests].reverse().find((r) => !r.resolved);
        if (last) last.resolved = true;
      }
    }
    for (const name of arrivedNow) {
      for (const req of facts.requests) {
        if (req.resolved) continue;
        if (req.units.includes(name) || req.groups.includes("more_units")) req.resolved = true;
      }
    }
    for (const m of execAll(REQUEST_RE, t)) {
      if (!inStatement(m.index)) continue;
      const s = sentenceAt(sentences, m.index);
      if (!s) continue;
      const restStart = m.index + m[0].length;
      const restNorm = t0.slice(restStart, s.end).replace(/^[\s:,-]+/, "").trim();
      if (!restNorm || NON_RESOURCE_RE.test(restNorm)) continue;
      const display = truncate(sliceOriginal(entry.text, nt, restStart, s.end).replace(/^[\s:,-]+/, ""), 90);
      facts.requests.push({
        seq,
        speaker: speakerLabel,
        text: display,
        groups: groupsIn(restNorm),
        units: findUnitMentions(restNorm).map((u) => u.name),
        resolved: false,
      });
      push("resource_request", `${speakerLabel} solicita: ${display}`, "important");
    }

    // 4) Peligros.
    for (const h of findHazards(t)) {
      const text = sentenceOrig(h.start);
      facts.hazards.push({ kind: h.kind, severity: h.severity, seq, text });
      const critical = h.kind === "collapse_risk" || h.kind === "explosion_risk";
      push("hazard", `Peligro informado (${HAZARD_LABEL[h.kind]}): «${text}»`, critical ? "critical" : "important");
    }

    // 5) Alarmas, fuego controlado, pre-informe, órdenes, mando.
    const alarm = execAll(ALARM_RE, t).find((m) => inStatement(m.index));
    if (alarm) {
      const inRequest = execAll(REQUEST_RE, t).some((r) => sentenceAt(sentences, r.index) === sentenceAt(sentences, alarm.index));
      if (!inRequest) {
        push(isCentral ? "dispatch" : "status_update", `${alarm[0].replace(/^./, (c) => c.toUpperCase())}: «${sentenceOrig(alarm.index)}»`, "important");
      }
    }
    const controlled = execAll(FIRE_CONTROLLED_RE, t).find((m) => inStatement(m.index));
    if (controlled) {
      facts.fireControlledSeq = seq;
      push("status_update", `${speakerLabel} informa fuego controlado: «${sentenceOrig(controlled.index)}»`, "important");
    }
    if (FIRE_MENTION_RE.test(t)) facts.fireMentionSeqs.push(seq);
    if (HYDRANT_RE.test(t)) facts.hydrantSeqs.push(seq);
    const sizeUp = execAll(SIZE_UP_RE, t).find((m) => inStatement(m.index));
    if (sizeUp && !isCentral) push("size_up", `${speakerLabel}: «${sentenceOrig(sizeUp.index)}»`, "important");
    const order = execAll(ORDER_RE, t).find((m) => inStatement(m.index));
    if (order) {
      const evac = /^evacu/.test(order[1]);
      push("order", `${speakerLabel}: «${sentenceOrig(order.index)}»`, evac ? "important" : "routine");
    }
    const cmd = execAll(COMMAND_RE, t).find((m) => inStatement(m.index));
    if (cmd) {
      const s = sentenceAt(sentences, cmd.index);
      const unitsInSentence = s ? mentions.filter((m) => m.start >= s.start && m.end <= s.end) : [];
      const nearest = [...unitsInSentence].sort((a, b) => Math.abs(a.start - cmd.index) - Math.abs(b.start - cmd.index))[0];
      let commander = nearest?.name ?? speakerUnit ?? (!isCentral && entry.speaker.trim() ? entry.speaker.trim() : "");
      if (!commander && s) {
        commander = truncate(sliceOriginal(entry.text, nt, cmd.index + cmd[0].length, s.end).replace(/^[\s:,-]+/, ""), 40);
      }
      facts.command.established = true;
      if (commander) facts.command.commander = commander;
      facts.command.seq = seq;
      const post = execAll(POST_RE, t0)[0];
      if (post) {
        const ps = sentenceAt(sentences, post.index);
        if (ps) facts.command.post = truncate(sliceOriginal(entry.text, nt, post.index + post[0].length, ps.end), 80);
      }
      push("status_update", commander ? `Mando: ${commander}.` : "Se menciona el mando del incidente.", "important");
    }
  }

  facts.glossary = Array.from(glossarySet).filter((i) => i >= 0).sort((a, b) => a - b);
  facts.numericCodes = Array.from(codeSet);
  return facts;
}

/** Veredicto radial sobre personas atrapadas (solo reportes de atrapamiento). */
export interface RadioTrappedVerdict {
  status: "confirmed" | "reported" | "denied" | "unknown";
  /** Reportes vigentes (posteriores a la última negación válida). */
  reports: VictimReport[];
  denial: UnitDenial | null;
  /** Negaciones de alguien que no consta en el lugar (no valen como descarte). */
  invalidDenials: UnitDenial[];
}

export function radioTrappedVerdict(facts: CommsFacts): RadioTrappedVerdict {
  const trapped = facts.reports.filter((r) => r.kind === "trapped");
  const valid = facts.denials.filter((d) => d.byOnSceneUnit);
  const invalidDenials = facts.denials.filter((d) => !d.byOnSceneUnit);
  const lastDenial = valid.length > 0 ? valid[valid.length - 1] : null;
  const current = lastDenial ? trapped.filter((r) => r.seq >= lastDenial.seq) : trapped;
  if (current.length > 0) {
    // Un reporte en la misma entrada que una negación gana: ante la duda, no se descarta.
    return {
      status: current.some((r) => r.byOnSceneUnit) ? "confirmed" : "reported",
      reports: current,
      denial: null,
      invalidDenials,
    };
  }
  if (lastDenial) return { status: "denied", reports: [], denial: lastDenial, invalidDenials };
  return { status: "unknown", reports: [], denial: null, invalidDenials };
}

function commsSummary(f: CommsFacts): string {
  if (f.entryCount === 0) return "Sin tráfico radial registrado para este incidente.";
  const out: string[] = [];
  if (f.maydayActive) out.push(`Hay una emergencia de bombero (mayday) sin resolver: ${f.maydayDetail}.`);
  const v = radioTrappedVerdict(f);
  const seqs = (rs: readonly { seq: number }[]) => uniq(rs.map((r) => `C${r.seq}`)).join(", ");
  if (v.status === "confirmed") out.push(`Una unidad en el lugar informa personas atrapadas (${seqs(v.reports.filter((r) => r.byOnSceneUnit))}).`);
  else if (v.status === "reported") out.push(`Se informan personas atrapadas, sin confirmación de una unidad en el lugar (${seqs(v.reports)}).`);
  else if (v.status === "denied" && v.denial) out.push(`${v.denial.speakerUnit ?? v.denial.speaker}, en el lugar, informa que no hay personas atrapadas (C${v.denial.seq}).`);
  const injured = f.reports.filter((r) => r.kind === "injured");
  if (injured.length > 0 && out.length < 2) out.push(`Se informan lesionados (${seqs(injured)}).`);
  const onScene = Array.from(f.units).filter(([, u]) => isOnScene(u.status)).map(([n]) => n);
  const coming = Array.from(f.units).filter(([, u]) => u.status === "en_route" || u.status === "dispatched").map(([n]) => n);
  if (onScene.length > 0 || coming.length > 0) {
    const parts: string[] = [];
    if (onScene.length > 0) parts.push(`en el lugar ${onScene.join(", ")}`);
    if (coming.length > 0) parts.push(`en camino o despachadas ${coming.join(", ")}`);
    out.push(`Unidades: ${parts.join("; ")}.`);
  }
  if (f.fireControlledSeq !== null) out.push(`Se informa fuego controlado (C${f.fireControlledSeq}).`);
  if (f.command.established && f.command.commander) out.push(`Mando: ${f.command.commander}.`);
  if (out.length === 0) out.push(`${f.entryCount} entradas radiales sin hechos críticos detectados por las reglas.`);
  return out.slice(0, 3).join(" ");
}

export function commsAnalysisFromFacts(f: CommsFacts): CommsAnalysis {
  const v = radioTrappedVerdict(f);
  const lastReport = f.reports.length > 0 ? f.reports[f.reports.length - 1] : null;
  const lastValidDenial = [...f.denials].reverse().find((d) => d.byOnSceneUnit) ?? null;
  let victimsStatus: CommsAnalysis["victims"]["status"] = "unknown";
  if (lastReport && (!lastValidDenial || lastReport.seq >= lastValidDenial.seq)) victimsStatus = "reported";
  else if (lastValidDenial) victimsStatus = "denied_by_unit";

  const details: string[] = [];
  const injured = f.reports.filter((r) => r.kind === "injured");
  const rescued = f.reports.filter((r) => r.kind === "rescued");
  if (v.status === "confirmed" || v.status === "reported") {
    for (const r of v.reports.slice(-3)) {
      details.push(`C${r.seq} · ${r.speaker}${r.byOnSceneUnit ? " (en el lugar)" : " (sin confirmar en el lugar)"}: ${r.text}`);
    }
  }
  if (victimsStatus === "denied_by_unit" && lastValidDenial) {
    details.push(`${lastValidDenial.speakerUnit ?? lastValidDenial.speaker}, en el lugar, informa: ${lastValidDenial.text} (C${lastValidDenial.seq}).`);
    const earlier = f.reports.filter((r) => r.kind === "trapped" && r.seq < lastValidDenial.seq);
    if (earlier.length > 0) details.push(`Antes se había informado atrapamiento en ${uniq(earlier.map((r) => `C${r.seq}`)).join(", ")}.`);
  }
  for (const r of injured.slice(-2)) details.push(`Lesionados — C${r.seq} · ${r.speaker}: ${r.text}`);
  for (const r of rescued.slice(-2)) details.push(`Rescate — C${r.seq} · ${r.speaker}: ${r.text}`);
  for (const d of v.invalidDenials.slice(-1)) {
    details.push(`C${d.seq} · ${d.speaker} dice que no hay atrapados, pero no consta que esté en el lugar: no se considera descarte.`);
  }
  if (details.length === 0) details.push("Nadie ha informado por radio si hay personas atrapadas o lesionadas.");

  const victimSeqs = uniq([...f.reports.map((r) => r.seq), ...f.denials.map((d) => d.seq)]).sort((a, b) => a - b);

  const pending = f.requests.filter((r) => !r.resolved);
  const latestHazards = new Map<HazardKind, RadioHazard>();
  for (const h of f.hazards) latestHazards.set(h.kind, h);

  const codes: CommsAnalysis["codes_interpreted"] = [
    ...f.glossary.map((i) => ({ code: RADIO_GLOSSARY[i].term, meaning: RADIO_GLOSSARY[i].meaning, certainty: RADIO_GLOSSARY[i].certainty })),
    ...f.numericCodes.map((code) => ({ code, meaning: "Clave no verificada para este Cuerpo; confirmar", certainty: "low" as const })),
  ];

  const questions: string[] = [];
  if (f.maydayActive) questions.push("¿Ubicación y estado del bombero en emergencia (mayday)? ¿Quién lo está apoyando?");
  if (victimsStatus === "unknown") questions.push("¿Hay personas atrapadas o desaparecidas?");
  if (v.status === "reported") questions.push("¿Alguna unidad en el lugar confirma personas atrapadas? ¿Cuántas y en qué piso o sector?");
  if (v.status === "confirmed") questions.push("¿Cuántas personas atrapadas y en qué piso o sector? ¿Se están rescatando?");
  if (rescued.length > 0 && v.status !== "denied") questions.push("Tras el rescate informado, ¿quedan otras personas sin ubicar?");
  if (v.status !== "denied" && v.invalidDenials.length > 0) questions.push("Confirmar con la unidad en el lugar si la búsqueda descartó personas atrapadas.");
  if (!f.command.established) questions.push("¿Quién está al mando (OBAC) y dónde está el puesto de comando?");
  else if (!f.command.post) questions.push("¿Dónde está el puesto de comando?");
  for (const r of pending.slice(0, 2)) questions.push(`¿Llegó lo solicitado en C${r.seq} (${truncate(r.text, 50)})?`);
  const coming = Array.from(f.units).filter(([, u]) => u.status === "en_route" || u.status === "dispatched").map(([n]) => n);
  if (coming.length > 0) questions.push(`¿Tiempo estimado de llegada de ${coming.slice(0, 4).join(", ")}?`);
  for (const c of f.numericCodes.slice(0, 2)) questions.push(`Confirmar el significado de la clave «${c}» para este Cuerpo.`);
  if (f.entryCount > 0 && f.hazards.length === 0) questions.push("¿Hay cilindros de gas, riesgo eléctrico u otros peligros especiales?");

  return {
    summary: commsSummary(f),
    units: Array.from(f.units).map(([name, u]) => ({ name, status: u.status, last_report: u.lastReport })),
    events: f.events,
    victims: { status: victimsStatus, detail: details.join(" "), entry_seqs: victimSeqs },
    mayday: {
      active: f.maydayActive,
      detail: f.maydayActive ? f.maydayDetail : f.maydayDetail || "Sin emergencia de bombero informada.",
    },
    resource_requests: pending.map((r) => `C${r.seq} · ${r.speaker}: ${r.text}`),
    hazards: Array.from(latestHazards.values()).map((h) => `${HAZARD_LABEL[h.kind]} — C${h.seq}: ${h.text}`),
    command: { established: f.command.established, commander: f.command.commander, post_location: f.command.post },
    codes_interpreted: codes,
    open_questions: questions.slice(0, 6),
  };
}

export function simulateCommsAnalysis(input: CommsAnalysisInput): CommsAnalysis {
  return commsAnalysisFromFacts(runCommsRules(input.comms));
}

/* ═══════════════════════════ Notas de vecinos ═══════════════════════════ */

export interface NoteFacts {
  original: string;
  norm: string;
  trapped: { status: PersonStatus; phrase: string; floor: number; count: number } | null;
  injured: { phrase: string; count: number } | null;
  evacuating: boolean;
  hazards: Array<{ kind: HazardKind; severity: HazardSeverity; phrase: string }>;
  fire: boolean;
  smoke: { color: SmokeColor; volume: SmokeVolume } | null;
  floor: number;
  side: StructureSide;
  floors: number;
  structureMentioned: boolean;
  structureKind: StructureKind;
  construction: Construction;
  vehicle: { kind: VehicleKind; state: VehicleState; leaking: boolean; entrapment: boolean } | null;
  hydrant: boolean;
  incidentType: IncidentType | null;
  informative: boolean;
}

const STRUCTURE_WORD_RE =
  /\b(casa|casas|departamento|depto|edificio|vivienda|local|bodega|galpon|mediagua|cite|block|negocio|fabrica|industria|taller|colegio|jardin infantil|hogar|pieza|segundo piso|techo|entretecho)\b/;
const VEHICLE_WORD_RE = /\b(auto|autos|vehiculos?|camion(es)?|bus(es)?|micro|moto|motos|camioneta|furgon|taxi|colectivo|bicicleta)\b/;
const COLLISION_RE = /\bchoque\b|\bchoco\b|\bchocaron\b|\bcolision\b|\bvolcad[oa]s?\b|\bvolcamiento\b|\bse volco\b|\batropell\w*|\baccidente (de transito|vehicular)\b/;
const WILDLAND_RE = /\bpastizal\w*|\bforestal\b|\bcerro\b|\bmatorral\w*|\bbosque\b|\bquebrada\b|\bvegetacion\b|\bpasto\b|\bmalezas?\b|\bsitio eriazo\b/;

function vehicleKindIn(text: string): VehicleKind {
  if (/\bbus(es)?\b|\bmicro\b/.test(text)) return "bus";
  if (/\bcamion(es)?\b/.test(text)) return "truck";
  if (/\bcamioneta\b/.test(text)) return "suv_pickup";
  if (/\bfurgon\b/.test(text)) return "van";
  if (/\bmotos?\b/.test(text)) return "motorcycle";
  if (/\bbicicleta\b/.test(text)) return "bicycle";
  if (/\b(auto|autos|taxi|colectivo)\b/.test(text)) return "car";
  return "other";
}

export function readNote(note: string): NoteFacts {
  const nt = normalizeWithMap(note);
  const t0 = nt.text;
  const sentences = sentenceSpans(t0);
  const phraseAt = (pos: number) => {
    const s = sentenceAt(sentences, pos);
    return truncate(s ? sliceOriginal(note, nt, s.start, s.end) : note, 120);
  };
  let t = maskSpans(t0, findSpans(t0, TRAPPED_NEGATION_RES));
  t = maskSpans(t, findSpans(t, INJURY_NEGATION_RES));
  const rescued = findSpans(t, RESCUED_RES);
  t = maskSpans(t, rescued);

  let trapped: NoteFacts["trapped"] = null;
  const strong = findSpans(t, TRAPPED_POSITIVE_RES);
  let hitPos = strong.length > 0 ? strong[0].start : -1;
  if (hitPos < 0) {
    const weak = VULNERABLE_RE.exec(t);
    if (weak && !GOT_OUT_RE.test(t)) hitPos = weak.index;
  }
  if (hitPos >= 0) {
    const s = sentenceAt(sentences, hitPos);
    const sNorm = s ? t.slice(s.start, s.end) : t;
    const status: PersonStatus = /\b(ventana|balcon)\b/.test(sNorm)
      ? "at_window_or_balcony"
      : /\b(techo|azotea|techumbre)\b/.test(sNorm)
        ? "on_roof"
        : "trapped";
    trapped = { status, phrase: phraseAt(hitPos), floor: floorIn(sNorm) || floorIn(t), count: countIn(sNorm) ?? 1 };
  }
  const injuredSpan = findSpans(t, INJURED_POSITIVE_RES)[0];
  const injured = injuredSpan ? { phrase: phraseAt(injuredSpan.start), count: countIn(t) ?? 1 } : null;

  const hazards = findHazards(t).map((h) => ({ kind: h.kind, severity: h.severity, phrase: phraseAt(h.start) }));
  const fire = FIRE_MENTION_RE.test(t);
  let smoke: NoteFacts["smoke"] = null;
  if (SMOKE_RE.test(t)) {
    const color: SmokeColor = /\bhumo (muy )?negro\b|\bnegro\b/.test(t)
      ? "black"
      : /\bhumo (muy )?gris\b/.test(t)
        ? "gray"
        : /\bhumo (muy )?blanco\b/.test(t)
          ? "white"
          : /\bhumo (muy )?amarillo\b/.test(t)
            ? "yellow"
            : /\bhumo (muy )?cafe\b/.test(t)
              ? "brown"
              : "unknown";
    const volume: SmokeVolume = /\bmucho humo\b|\bhumo (muy )?(denso|espeso)\b|\bharto humo\b|\bhumareda\b/.test(t)
      ? "heavy"
      : /\bpoco humo\b|\balgo de humo\b/.test(t)
        ? "light"
        : "moderate";
    smoke = { color, volume };
  }
  const side: StructureSide = /\b(atras|detras|patio trasero|parte trasera|posterior|fondo)\b/.test(t)
    ? "rear"
    : /\b(frente|fachada|delantera|hacia la calle)\b/.test(t)
      ? "front"
      : /\b(techo|techumbre|entretecho|azotea)\b/.test(t)
        ? "roof"
        : "unknown";
  const floors = floorsCountIn(t);
  const structureMentioned = STRUCTURE_WORD_RE.test(t);
  let structureKind: StructureKind = "unknown";
  if (/\b(departamento|depto|edificio|block)\b/.test(t)) structureKind = "apartment_building";
  else if (/\b(local|negocio|tienda|supermercado|restaurant)\b/.test(t)) structureKind = "commercial";
  else if (/\b(bodega|galpon)\b/.test(t)) structureKind = "warehouse";
  else if (/\b(fabrica|industria|planta industrial)\b/.test(t)) structureKind = "industrial";
  else if (/\b(mediagua|campamento|toma)\b/.test(t)) structureKind = "informal_settlement";
  else if (/\bcasa\b/.test(t)) structureKind = floors >= 2 || /\bsegundo piso\b/.test(t) ? "house_2_story" : floors === 1 ? "house_1_story" : "unknown";
  const construction: Construction = /\bmadera\b/.test(t)
    ? "wood"
    : /\b(material ligero|material liviano|mediagua)\b/.test(t)
      ? "light_materials"
      : /\b(ladrillo|albanileria|adobe)\b/.test(t)
        ? "masonry"
        : /\b(hormigon|concreto|cemento)\b/.test(t)
          ? "concrete"
          : "unknown";
  const vehicleMentioned = VEHICLE_WORD_RE.test(t) || COLLISION_RE.test(t);
  const vehicle: NoteFacts["vehicle"] = vehicleMentioned
    ? {
        kind: vehicleKindIn(t),
        state: /\bvolcad[oa]\b|\bse volco\b|\bvolcamiento\b/.test(t)
          ? "overturned"
          : /\bde (lado|costado)\b/.test(t)
            ? "on_side"
            : VEHICLE_WORD_RE.test(t) && fire
              ? "burning"
              : "unknown",
        leaking: /\bderrame\b|\bbencina\b|\baceite\b|\bcombustible\b/.test(t),
        entrapment: trapped !== null || /\bapretad[oa]s?\b|\bno pueden? salir\b/.test(t),
      }
    : null;
  let incidentType: IncidentType | null = null;
  if (COLLISION_RE.test(t)) incidentType = "vehicle_collision";
  else if (VEHICLE_WORD_RE.test(t) && fire && !structureMentioned) incidentType = "vehicle_fire";
  else if (WILDLAND_RE.test(t) && (fire || smoke)) incidentType = "wildland_fire";
  else if (structureMentioned && (fire || smoke)) incidentType = "structure_fire";
  else if (/\bfuga de gas\b|\bquimic\w*|\bolor (fuerte|a quimico)\b/.test(t)) incidentType = "hazmat";

  const evacuating = /\b(evacuando|bajando|saliendo|salieron|estan saliendo|arrancando)\b/.test(t);
  const hydrant = HYDRANT_RE.test(t);
  const informative =
    trapped !== null ||
    injured !== null ||
    hazards.length > 0 ||
    fire ||
    smoke !== null ||
    vehicle !== null ||
    hydrant ||
    structureMentioned ||
    evacuating ||
    rescued.length > 0;
  return {
    original: note.trim(),
    norm: t0,
    trapped,
    injured,
    evacuating,
    hazards,
    fire,
    smoke,
    floor: floorIn(t),
    side,
    floors,
    structureMentioned,
    structureKind,
    construction,
    vehicle,
    hydrant,
    incidentType,
    informative,
  };
}

/* ═══════════════════════════ Análisis de un medio ═══════════════════════════ */

export const SIMULATED_MEDIA_UNCERTAINTY = "Motor simulado: los fotogramas no fueron analizados";

const SOURCE_LABEL: Record<Media["source"], string> = {
  citizen: "vecino",
  drone: "dron",
  responder: "personal de Bomberos",
  demo: "demostración",
};

export function simulateMediaAnalysis(input: MediaAnalysisInput): MediaAnalysis {
  const { media, incident } = input;
  const note = readNote(media.reporter_note ?? "");
  const hasNote = note.original.length > 0;
  const quoted = hasNote ? `«${truncate(note.original, 160)}»` : "";
  const kindLabel = media.kind === "video" ? "video" : media.kind === "photo" ? "foto" : "fotogramas";
  const nFrames = input.frames.length;
  const fireType = isFireType(incident.type);
  const incidentType = note.incidentType ?? incident.type;
  const hasGps = isValidLatLng(media.lat, media.lng);

  const summary = [
    `${media.label} (${kindLabel} de ${SOURCE_LABEL[media.source]}, ${nFrames} fotograma${nFrames === 1 ? "" : "s"}) sin análisis visual: motor simulado.`,
    hasNote ? `La nota dice: ${quoted}.` : "Sin nota del informante.",
  ].join(" ");

  const people: MediaAnalysis["people"] = [];
  if (note.trapped) {
    people.push({
      status: note.trapped.status,
      count: note.trapped.count,
      location: `Según la nota: «${note.trapped.phrase}»`,
      floor: note.trapped.floor,
      frame_refs: [],
      confidence: "low",
      description: "Reportado en la nota del informante; no verificado en imágenes.",
    });
  }
  if (note.injured) {
    people.push({
      status: "injured",
      count: note.injured.count,
      location: `Según la nota: «${note.injured.phrase}»`,
      floor: 0,
      frame_refs: [],
      confidence: "low",
      description: "Lesionado mencionado en la nota; no verificado en imágenes.",
    });
  }

  const vehicles: MediaAnalysis["vehicles"] = note.vehicle
    ? [
        {
          kind: note.vehicle.kind,
          state: note.vehicle.state,
          damage: "unknown",
          occupants_visible: "unknown",
          entrapment_suspected: note.vehicle.entrapment,
          leaking_fluids: note.vehicle.leaking,
          position: "No determinada (sin análisis visual).",
          description: "Vehículo mencionado en la nota; no verificado en imágenes.",
          frame_refs: [],
        },
      ]
    : [];

  const fireLocations: MediaAnalysis["fire"]["locations"] =
    note.fire && (note.floor > 0 || note.side !== "unknown")
      ? [{ floor: note.floor, side: note.side, description: "Según la nota del informante (no verificado)." }]
      : [];

  const firstFrame = input.frames.length > 0 ? input.frames[0].idx : media.frames.length > 0 ? media.frames[0].idx : null;

  const uncertainties = [
    SIMULATED_MEDIA_UNCERTAINTY,
    "No se puede confirmar ni descartar personas, fuego ni peligros desde este medio.",
    hasNote ? "Lo indicado proviene solo de la nota del informante, sin verificar." : "No hay nota del informante.",
    "La escena pudo cambiar desde la grabación.",
  ];

  return {
    usable: note.informative,
    unusable_reason: note.informative
      ? ""
      : "Motor simulado: no se analizaron los fotogramas y la nota no aporta datos. Revisa el medio directamente.",
    incident_type: incidentType,
    summary,
    viewpoint: {
      position_description: hasGps
        ? `Posición GPS del teléfono${media.accuracy_m !== null ? ` (±${Math.round(media.accuracy_m)} m)` : ""}; encuadre no analizado.`
        : "Desconocida: sin GPS y sin análisis visual.",
      facing: media.heading_deg !== null && Number.isFinite(media.heading_deg) ? cardinalOf(media.heading_deg) : "unknown",
      distance_m:
        hasGps && media.lat !== null && media.lng !== null
          ? Math.round(distanceM({ lat: incident.lat, lng: incident.lng }, { lat: media.lat, lng: media.lng }))
          : 0,
      elevation: media.source === "drone" ? "aerial" : "unknown",
    },
    structure: {
      present: note.structureMentioned || incidentType === "structure_fire",
      kind: note.structureKind,
      floors_visible: 0,
      construction: note.construction,
      exposures: "",
      description: note.structureMentioned ? "Edificación mencionada en la nota; no verificada en imágenes." : "No evaluada (motor simulado).",
    },
    fire: {
      present: note.fire || fireType,
      stage: "unknown",
      flames_visible: false,
      locations: fireLocations,
      smoke: {
        present: note.smoke !== null,
        color: note.smoke?.color ?? "unknown",
        volume: note.smoke?.volume ?? "none",
        description: note.smoke ? "Humo mencionado en la nota; no evaluado en imágenes." : "No evaluado (motor simulado).",
      },
      spread_risk: "unknown",
    },
    people,
    vehicles,
    hazards: note.hazards.map((h) => ({
      kind: h.kind,
      description: `Mencionado en la nota (no verificado): «${h.phrase}»`,
      severity: h.severity,
      frame_refs: [],
    })),
    access: {
      description: "No evaluado (motor simulado).",
      obstructions: [],
      water_sources: note.hydrant ? ["Grifo o red seca mencionado en la nota (ubicación y operatividad no verificadas)."] : [],
    },
    key_frames: firstFrame !== null ? [{ frame: firstFrame, caption: "No analizado (motor simulado)" }] : [],
    visible_text: [],
    uncertainties,
    confidence: "low",
  };
}

/* ═══════════════════════════════ Fusión ═══════════════════════════════ */

interface MediaItem {
  fm: FusionMedia;
  media: Media;
  label: string;
  analysis: MediaAnalysis | null;
  /** Solo los análisis de Claude utilizables cuentan como evidencia visual. */
  visual: boolean;
  note: NoteFacts;
  time: number;
}

interface PersonGroup {
  label: string;
  status: PersonStatus;
  count: number;
  floor: number;
  location: string;
  confidence: Confidence;
  source: "visual" | "analysis" | "note" | "radio";
  evidence: EvidenceRef[];
  time: number;
  phrase: string;
}

interface FireLocation {
  label: string;
  floor: number;
  side: StructureSide;
  description: string;
  confidence: Confidence;
  stage: FireStage;
  flames: boolean;
}

interface VehicleFact {
  label: string;
  kind: VehicleKind;
  state: VehicleState;
  entrapment: boolean;
  leaking: boolean;
  description: string;
  visual: boolean;
}

interface FusionFacts {
  input: FusionInput;
  items: MediaItem[];
  visualItems: MediaItem[];
  radio: CommsFacts;
  verdict: RadioTrappedVerdict;
  incidentType: IncidentType;
  people: PersonGroup[];
  trapped: SituationReport["trapped"];
  trappedContradictions: SituationReport["contradictions"];
  injured: SituationReport["injured"];
  fire: {
    present: boolean;
    stage: FireStage;
    flames: boolean;
    locations: FireLocation[];
    smokeColor: SmokeColor;
    smokeVolume: SmokeVolume;
    smokeSources: string[];
    spreadRisk: "low" | "moderate" | "high" | "unknown";
    exposures: string[];
    sources: string[];
  };
  structure: {
    present: boolean;
    kind: StructureKind;
    floors: number;
    construction: Construction;
    exposures: string[];
    descriptions: string[];
  };
  vehicles: VehicleFact[];
  vehicleEntrapment: Likelihood;
  hazards: SituationReport["hazards"];
  water: string[];
  obstructions: string[];
  accessDescriptions: string[];
  hydrantMentioned: boolean;
  hydrantSources: string[];
}

const TYPE_ORDER: readonly IncidentType[] = [
  "structure_fire",
  "vehicle_collision",
  "vehicle_fire",
  "wildland_fire",
  "hazmat",
  "rescue",
  "other",
  "unknown",
];

function majorityType(items: readonly MediaItem[], fallback: IncidentType): IncidentType {
  const counts = new Map<IncidentType, number>();
  for (const it of items) {
    if (!it.analysis || !it.analysis.usable || it.analysis.incident_type === "unknown") continue;
    counts.set(it.analysis.incident_type, (counts.get(it.analysis.incident_type) ?? 0) + (it.visual ? 2 : 1));
  }
  if (counts.size === 0) return fallback;
  const best = Math.max(...counts.values());
  const tied = TYPE_ORDER.filter((t) => counts.get(t) === best);
  return tied.includes(fallback) ? fallback : tied[0];
}

function mostCommon<T extends string>(values: readonly T[], skip: readonly T[]): T | null {
  const counts = new Map<T, number>();
  for (const v of values) if (!skip.includes(v)) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: T | null = null;
  let n = 0;
  for (const [v, c] of counts) {
    if (c > n) {
      best = v;
      n = c;
    }
  }
  return best;
}

function framesRefs(label: string, frames: readonly number[], note: string): EvidenceRef[] {
  if (frames.length === 0) return [{ ref: label, frame: -1, note }];
  return uniq(frames).slice(0, 3).map((frame) => ({ ref: label, frame, note }));
}

function dedupeEvidence(refs: readonly EvidenceRef[], max = 8): EvidenceRef[] {
  const seen = new Set<string>();
  const out: EvidenceRef[] = [];
  for (const r of refs) {
    const key = `${r.ref}#${r.frame}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
    if (out.length >= max) break;
  }
  return out;
}

function radioRef(seq: number, speaker: string, text: string): EvidenceRef {
  return { ref: `C${seq}`, frame: -1, note: truncate(`${speaker}: ${text}`, 140) };
}

function buildFacts(input: FusionInput): FusionFacts {
  const items: MediaItem[] = [...input.media]
    .sort((a, b) => a.media.label.localeCompare(b.media.label, "es", { numeric: true }))
    .map((fm) => {
      const t = timeOf(fm.media.captured_at ?? fm.media.created_at);
      return {
        fm,
        media: fm.media,
        label: fm.media.label,
        analysis: fm.analysis,
        visual: fm.analysis !== null && fm.analysis_engine === "claude" && fm.analysis.usable,
        note: readNote(fm.media.reporter_note ?? ""),
        time: Number.isFinite(t) ? t : Number.POSITIVE_INFINITY,
      };
    });
  const visualItems = items.filter((i) => i.visual);
  const radio = runCommsRules(input.comms);
  const verdict = mergeRadioVerdict(radioTrappedVerdict(radio), input.commsAnalysis, radio);
  const incidentType = majorityType(items, input.incident.type);

  /* ── Personas ── */
  const people: PersonGroup[] = [];
  for (const it of items) {
    const a = it.analysis;
    let analysisTrapped = false;
    if (a) {
      for (const p of a.people) {
        if (p.status === "bystander" || p.status === "responder") continue;
        const source: PersonGroup["source"] = it.visual ? "visual" : "analysis";
        if (TRAPPED_PERSON.includes(p.status)) analysisTrapped = true;
        people.push({
          label: it.label,
          status: p.status,
          count: Math.max(1, Math.round(Number.isFinite(p.count) ? p.count : 1)),
          floor: Number.isFinite(p.floor) ? Math.max(0, Math.round(p.floor)) : 0,
          location: p.location,
          confidence: it.visual ? p.confidence : "low",
          source,
          evidence: framesRefs(it.label, it.visual ? p.frame_refs : [], truncate(`${PERSON_LABEL[p.status]}: ${p.location}`, 140)),
          time: it.time,
          phrase: it.note.trapped?.phrase ?? "",
        });
      }
    }
    if (it.note.trapped && !analysisTrapped) {
      people.push({
        label: it.label,
        status: it.note.trapped.status,
        count: it.note.trapped.count,
        floor: it.note.trapped.floor,
        location: `según la nota de ${it.label}`,
        confidence: "low",
        source: "note",
        evidence: [{ ref: it.label, frame: -1, note: `Nota del informante: «${it.note.trapped.phrase}»` }],
        time: it.time,
        phrase: it.note.trapped.phrase,
      });
    }
    if (it.note.injured && !(a && a.people.some((p) => p.status === "injured"))) {
      people.push({
        label: it.label,
        status: "injured",
        count: it.note.injured.count,
        floor: 0,
        location: `según la nota de ${it.label}`,
        confidence: "low",
        source: "note",
        evidence: [{ ref: it.label, frame: -1, note: `Nota del informante: «${it.note.injured.phrase}»` }],
        time: it.time,
        phrase: it.note.injured.phrase,
      });
    }
  }
  for (const r of verdict.reports) {
    people.push({
      label: `C${r.seq}`,
      status: "trapped",
      count: r.count ?? 1,
      floor: r.floor,
      location: truncate(r.text, 100),
      confidence: r.byOnSceneUnit ? "high" : "low",
      source: "radio",
      evidence: [radioRef(r.seq, r.speaker, r.text)],
      time: timeOf(r.at),
      phrase: r.text,
    });
  }

  /* ── Vehículos ── */
  const vehicles: VehicleFact[] = [];
  const vehicleSource = [...visualItems].sort((a, b) => (b.analysis?.vehicles.length ?? 0) - (a.analysis?.vehicles.length ?? 0))[0];
  if (vehicleSource?.analysis && vehicleSource.analysis.vehicles.length > 0) {
    for (const v of vehicleSource.analysis.vehicles) {
      vehicles.push({
        label: vehicleSource.label,
        kind: v.kind,
        state: v.state,
        entrapment: v.entrapment_suspected,
        leaking: v.leaking_fluids,
        description: v.description || v.position,
        visual: true,
      });
    }
  } else {
    const fromOther = items.find((i) => (i.analysis?.vehicles.length ?? 0) > 0);
    if (fromOther?.analysis) {
      for (const v of fromOther.analysis.vehicles) {
        vehicles.push({
          label: fromOther.label,
          kind: v.kind,
          state: v.state,
          entrapment: v.entrapment_suspected,
          leaking: v.leaking_fluids,
          description: `${v.description} (sin verificación visual)`,
          visual: false,
        });
      }
    } else {
      const noted = items.find((i) => i.note.vehicle !== null);
      if (noted?.note.vehicle) {
        vehicles.push({
          label: noted.label,
          kind: noted.note.vehicle.kind,
          state: noted.note.vehicle.state,
          entrapment: noted.note.vehicle.entrapment,
          leaking: noted.note.vehicle.leaking,
          description: `Mencionado en la nota de ${noted.label} (sin verificar)`,
          visual: false,
        });
      }
    }
  }
  const visualEntrapment = visualItems.filter((i) => i.analysis?.vehicles.some((v) => v.entrapment_suspected));

  /* ── Personas atrapadas: regla epistémica ── */
  const { trapped, contradictions } = decideTrapped(items, people, visualEntrapment, verdict);

  /* ── Lesionados ── */
  const injuredGroups = people.filter((p) => p.status === "injured");
  let injuredStatus: Likelihood = "no_evidence";
  const injuredDetail: string[] = [];
  for (const g of injuredGroups) {
    const l: Likelihood = g.source === "visual" ? (g.confidence === "high" ? "probable" : "possible") : "possible";
    injuredStatus = maxLikelihood(injuredStatus, l);
    injuredDetail.push(`${g.source === "visual" ? "Visto en" : "Mencionado en la nota de"} ${g.label}: ${truncate(g.location, 80)}`);
  }
  const radioInjured = radio.reports.filter((r) => r.kind === "injured" || r.kind === "rescued");
  for (const r of radioInjured) {
    injuredStatus = maxLikelihood(injuredStatus, r.byOnSceneUnit ? "confirmed" : "possible");
    injuredDetail.push(`C${r.seq} · ${r.speaker}${r.byOnSceneUnit ? " (en el lugar)" : ""}: ${truncate(r.text, 100)}`);
  }
  const injuredCount = Math.max(
    0,
    ...injuredGroups.map((g) => g.count),
    ...radioInjured.map((r) => r.count ?? 1),
  );
  const injured: SituationReport["injured"] = {
    status: injuredStatus,
    count_estimate: injuredStatus === "no_evidence" ? 0 : injuredCount,
    detail:
      injuredDetail.length > 0
        ? truncate(injuredDetail.join(" · "), 400)
        : "No se observan ni se informan lesionados en el material disponible; no los descarta.",
  };

  /* ── Fuego ── */
  const fireLocations: FireLocation[] = [];
  let stage: FireStage = "unknown";
  let flames = false;
  const fireSources: string[] = [];
  const smokeColors: SmokeColor[] = [];
  let smokeVolume: SmokeVolume = "none";
  const smokeSources: string[] = [];
  let spreadRisk: FusionFacts["fire"]["spreadRisk"] = "unknown";
  const spreadRank = { unknown: -1, low: 0, moderate: 1, high: 2 } as const;
  const volumeRank: Record<SmokeVolume, number> = { none: 0, light: 1, moderate: 2, heavy: 3 };
  const exposures: string[] = [];
  for (const it of visualItems) {
    const f = it.analysis?.fire;
    if (!f) continue;
    if (f.present) {
      fireSources.push(it.label);
      if (STAGE_RANK[f.stage] > STAGE_RANK[stage]) stage = f.stage;
      flames = flames || f.flames_visible;
      for (const loc of f.locations) {
        fireLocations.push({
          label: it.label,
          floor: Number.isFinite(loc.floor) ? Math.max(0, Math.round(loc.floor)) : 0,
          side: loc.side,
          description: loc.description,
          confidence: it.analysis?.confidence ?? "low",
          stage: f.stage,
          flames: f.flames_visible,
        });
      }
    }
    if (f.smoke.present) {
      smokeColors.push(f.smoke.color);
      if (volumeRank[f.smoke.volume] > volumeRank[smokeVolume]) smokeVolume = f.smoke.volume;
      smokeSources.push(it.label);
    }
    if (spreadRank[f.spread_risk] > spreadRank[spreadRisk]) spreadRisk = f.spread_risk;
    const exp = it.analysis?.structure.exposures.trim();
    if (exp) exposures.push(`${exp} (${it.label})`);
  }
  const noteFireItems = items.filter((i) => i.note.fire || (!i.visual && i.analysis?.fire.present && i.analysis.fire.locations.length > 0));
  for (const it of items) {
    if (it.visual) continue;
    const fromNote = it.note.fire && (it.note.floor > 0 || it.note.side !== "unknown");
    if (fromNote) {
      fireLocations.push({
        label: it.label,
        floor: it.note.floor,
        side: it.note.side,
        description: `Según la nota de ${it.label} (sin verificar)`,
        confidence: "low",
        stage: "unknown",
        flames: false,
      });
    } else if (it.analysis) {
      for (const loc of it.analysis.fire.locations) {
        fireLocations.push({
          label: it.label,
          floor: Number.isFinite(loc.floor) ? Math.max(0, Math.round(loc.floor)) : 0,
          side: loc.side,
          description: `${loc.description} (sin verificación visual)`,
          confidence: "low",
          stage: "unknown",
          flames: false,
        });
      }
    }
    if (it.note.smoke && smokeSources.length === 0) {
      smokeColors.push(it.note.smoke.color);
      if (volumeRank[it.note.smoke.volume] > volumeRank[smokeVolume]) smokeVolume = it.note.smoke.volume;
      smokeSources.push(`nota de ${it.label}`);
    }
  }
  const firePresent =
    fireSources.length > 0 || noteFireItems.length > 0 || radio.fireMentionSeqs.length > 0 || isFireType(incidentType);

  /* ── Estructura ── */
  const structItems = visualItems.filter((i) => i.analysis?.structure.present);
  const kinds = structItems.map((i) => i.analysis?.structure.kind ?? "unknown");
  const noteKinds = items.map((i) => i.note.structureKind);
  const nonVisualKinds = items.filter((i) => !i.visual && i.analysis?.structure.present).map((i) => i.analysis?.structure.kind ?? "unknown");
  const kind =
    mostCommon(kinds, ["unknown"]) ?? mostCommon(nonVisualKinds, ["unknown"]) ?? mostCommon(noteKinds, ["unknown"]) ?? "unknown";
  const floors = Math.max(
    0,
    ...structItems.map((i) => Math.round(i.analysis?.structure.floors_visible ?? 0)),
    ...(structItems.length === 0 ? items.map((i) => i.note.floors) : []),
    ...(structItems.length === 0 ? items.filter((i) => !i.visual).map((i) => Math.round(i.analysis?.structure.floors_visible ?? 0)) : []),
  );
  const construction =
    mostCommon(structItems.map((i) => i.analysis?.structure.construction ?? "unknown"), ["unknown"]) ??
    mostCommon(items.map((i) => i.note.construction), ["unknown"]) ??
    "unknown";
  const structurePresent =
    structItems.length > 0 ||
    items.some((i) => i.note.structureMentioned || (i.analysis?.structure.present ?? false)) ||
    incidentType === "structure_fire";

  /* ── Peligros ── */
  const hazardMap = new Map<HazardKind, SituationReport["hazards"][number]>();
  const addHazard = (kind: HazardKind, severity: HazardSeverity, description: string, evidence: EvidenceRef[]) => {
    const prev = hazardMap.get(kind);
    if (!prev) {
      hazardMap.set(kind, { kind, description, severity, evidence: dedupeEvidence(evidence) });
      return;
    }
    if (HAZ_RANK[severity] > HAZ_RANK[prev.severity]) {
      prev.severity = severity;
      prev.description = description;
    }
    prev.evidence = dedupeEvidence([...prev.evidence, ...evidence]);
  };
  for (const it of items) {
    for (const h of it.analysis?.hazards ?? []) {
      const desc = it.visual ? h.description : `${h.description}${/no verificad/.test(normalizeText(h.description)) ? "" : " (sin verificación visual)"}`;
      addHazard(h.kind, h.severity, truncate(desc, 200), framesRefs(it.label, it.visual ? h.frame_refs : [], truncate(h.description, 140)));
    }
    for (const h of it.note.hazards) {
      addHazard(h.kind, h.severity, `Mencionado en la nota de ${it.label} (sin verificar): «${h.phrase}»`, [
        { ref: it.label, frame: -1, note: `Nota del informante: «${h.phrase}»` },
      ]);
    }
  }
  for (const h of radio.hazards) {
    const speaker = input.comms.find((c) => c.seq === h.seq)?.speaker ?? "";
    addHazard(h.kind, h.severity, `Informado por radio (C${h.seq}): ${h.text}`, [radioRef(h.seq, speaker || "Radio", h.text)]);
  }
  const hazards = Array.from(hazardMap.values()).sort((a, b) => HAZ_RANK[b.severity] - HAZ_RANK[a.severity]);

  /* ── Acceso y agua ── */
  const water: string[] = [];
  const obstructions: string[] = [];
  const accessDescriptions: string[] = [];
  for (const it of visualItems) {
    const acc = it.analysis?.access;
    if (!acc) continue;
    for (const w of acc.water_sources) water.push(`${w} (${it.label})`);
    for (const o of acc.obstructions) obstructions.push(`${o} (${it.label})`);
    if (acc.description.trim()) accessDescriptions.push(`${acc.description.trim()} (${it.label})`);
  }
  const hydrantSources = uniq([
    ...items.filter((i) => i.note.hydrant).map((i) => i.label),
    ...items.filter((i) => i.visual && (i.analysis?.access.water_sources.length ?? 0) > 0).map((i) => i.label),
    ...radio.hydrantSeqs.map((s) => `C${s}`),
  ]);

  /* ── Atrapamiento vehicular ── */
  let vehicleEntrapment: Likelihood = "no_evidence";
  for (const it of visualEntrapment) {
    vehicleEntrapment = maxLikelihood(vehicleEntrapment, it.analysis?.confidence === "high" ? "probable" : "possible");
  }
  if (vehicles.some((v) => !v.visual && v.entrapment)) vehicleEntrapment = maxLikelihood(vehicleEntrapment, "possible");
  const vehicleIncident = incidentType === "vehicle_collision" || incidentType === "vehicle_fire";
  if (vehicleIncident && (verdict.status === "confirmed" || verdict.status === "reported")) {
    vehicleEntrapment = maxLikelihood(vehicleEntrapment, verdict.status === "confirmed" ? "confirmed" : "possible");
  }

  return {
    input,
    items,
    visualItems,
    radio,
    verdict,
    incidentType,
    people,
    trapped,
    trappedContradictions: contradictions,
    injured,
    fire: {
      present: firePresent,
      stage,
      flames,
      locations: fireLocations,
      smokeColor: mostCommon(smokeColors, ["unknown", "none"]) ?? (smokeSources.length > 0 ? "unknown" : "none"),
      smokeVolume,
      smokeSources,
      spreadRisk,
      exposures: uniq(exposures),
      sources: fireSources,
    },
    structure: {
      present: structurePresent,
      kind,
      floors,
      construction,
      exposures: uniq(exposures),
      descriptions: structItems.map((i) => `${truncate(i.analysis?.structure.description ?? "", 140)} (${i.label})`).filter((d) => d.length > 5),
    },
    vehicles,
    vehicleEntrapment,
    hazards,
    water: uniq(water),
    obstructions: uniq(obstructions),
    accessDescriptions,
    hydrantMentioned: hydrantSources.length > 0,
    hydrantSources,
  };
}

/**
 * Combina el veredicto de las reglas con el análisis de comunicaciones recibido
 * (que puede venir de Claude). Nunca baja el estado: un reporte de cualquiera de
 * los dos gana; un descarte solo vale si las reglas verifican que lo dijo una
 * unidad en el lugar.
 */
function mergeRadioVerdict(rules: RadioTrappedVerdict, ca: CommsAnalysis | null, facts: CommsFacts): RadioTrappedVerdict {
  if (!ca || ca.victims.status !== "reported") return rules;
  if (rules.status === "confirmed" || rules.status === "reported") return rules;
  const detail = normalizeText(ca.victims.detail);
  const aboutTrapped = /atrapad|adentro|dentro|interior|sin ubicar|desaparecid|ventana|balcon/.test(detail);
  const aboutInjuredOnly = !aboutTrapped && /lesionad|herid|paciente|inhalacion/.test(detail);
  if (aboutInjuredOnly) return rules;
  const seqs = ca.victims.entry_seqs.filter((s) => !rules.denial || s >= rules.denial.seq);
  if (rules.denial && seqs.length === 0) return rules;
  const reports: VictimReport[] = (seqs.length > 0 ? seqs : [-1]).map((seq) => {
    const entry = facts.events.find((e) => e.entry_seq === seq);
    return {
      seq,
      kind: "trapped" as const,
      speaker: "Análisis de comunicaciones",
      speakerUnit: null,
      byOnSceneUnit: seq >= 0 && (facts.onSceneSpeakerBySeq.get(seq) ?? false),
      count: null,
      floor: floorIn(detail),
      text: truncate(entry?.text ?? ca.victims.detail, 160),
      at: "",
    };
  });
  const valid = reports.filter((r) => r.seq >= 0);
  return {
    status: valid.some((r) => r.byOnSceneUnit) ? "confirmed" : "reported",
    reports: valid,
    denial: null,
    invalidDenials: rules.invalidDenials,
  };
}

function decideTrapped(
  items: readonly MediaItem[],
  people: readonly PersonGroup[],
  visualEntrapment: readonly MediaItem[],
  verdict: RadioTrappedVerdict,
): { trapped: SituationReport["trapped"]; contradictions: SituationReport["contradictions"] } {
  const trappedGroups = people.filter((p) => TRAPPED_PERSON.includes(p.status));
  const visual = trappedGroups.filter((p) => p.source === "visual");
  const weak = trappedGroups.filter((p) => p.source === "note" || p.source === "analysis");
  const visualLabels = uniq(visual.map((p) => p.label));
  let visualStatus: TrappedStatus | null = null;
  if (visual.length > 0) visualStatus = visual.some((p) => p.confidence === "high") || visualLabels.length >= 2 ? "probable" : "possible";
  if (!visualStatus && visualEntrapment.length > 0) visualStatus = "possible";

  const contradictions: SituationReport["contradictions"] = [];
  const evidence: EvidenceRef[] = [];
  const basis: string[] = [];
  const locations: string[] = [];
  let status: TrappedStatus = "no_evidence";

  const describeWeak = (groups: readonly PersonGroup[]): string[] =>
    groups.map((g) =>
      g.source === "note" || g.phrase
        ? `nota del informante en ${g.label}: «${truncate(g.phrase, 90)}» (sin corroborar)`
        : `análisis sin verificación visual en ${g.label}`,
    );
  const pushGroups = (groups: readonly PersonGroup[]) => {
    for (const g of groups) {
      evidence.push(...g.evidence);
      locations.push(g.source === "visual" ? `${truncate(g.location, 80)} (${g.label})` : g.source === "radio" ? `${truncate(g.location, 80)} (${g.label})` : `${g.floor > 0 ? floorText(g.floor) : "ubicación no precisada"} (nota ${g.label})`);
    }
  };
  const visualDesc = () =>
    `persona(s) ${uniq(visual.map((p) => PERSON_LABEL[p.status])).join(" / ")} en ${visualLabels.join(", ")}`;

  const radioReports = verdict.reports;
  if (verdict.status === "confirmed") {
    status = "confirmed";
    const by = radioReports.filter((r) => r.byOnSceneUnit);
    basis.push(`Unidad en el lugar informa personas atrapadas por radio (${by.map((r) => `C${r.seq} · ${r.speaker}`).join("; ")}).`);
    pushGroups(people.filter((p) => p.source === "radio"));
    if (visual.length > 0) {
      basis.push(`Coincide con video: ${visualDesc()}.`);
      pushGroups(visual);
    }
    if (weak.length > 0) {
      basis.push(`También: ${describeWeak(weak).join("; ")}.`);
      pushGroups(weak);
    }
  } else if (verdict.status === "denied" && verdict.denial) {
    const d = verdict.denial;
    const denialT = timeOf(d.at);
    const unit = d.speakerUnit ?? d.speaker;
    const newerWeak = weak.filter((g) => !Number.isFinite(denialT) || g.time > denialT);
    const olderWeak = weak.filter((g) => !newerWeak.includes(g));
    if (visualStatus) {
      status = visualStatus;
      basis.push(`Video muestra ${visual.length > 0 ? visualDesc() : `posible atrapamiento en vehículo (${uniq(visualEntrapment.map((i) => i.label)).join(", ")})`}, aunque ${unit} informó por radio que no hay atrapados (C${d.seq}). No se baja el estado: verificar.`);
      pushGroups(visual);
      for (const it of visualEntrapment) evidence.push({ ref: it.label, frame: -1, note: "Posible atrapamiento en vehículo" });
      const labels = uniq([...visualLabels, ...visualEntrapment.map((i) => i.label)]);
      contradictions.push({
        description: `${labels.join(", ")} muestra(n) ${visual.length > 0 ? "persona(s) en situación de atrapamiento" : "posible atrapamiento en vehículo"}, pero ${unit} informó por radio que no hay personas atrapadas (C${d.seq}). Confirmar con la unidad.`,
        sources: [...labels, `C${d.seq}`],
      });
    }
    if (newerWeak.length > 0) {
      if (!visualStatus) status = "possible";
      basis.push(`Después del informe de ${unit} (C${d.seq}) llegó: ${describeWeak(newerWeak).join("; ")}.`);
      pushGroups(newerWeak);
      contradictions.push({
        description: `${uniq(newerWeak.map((g) => g.label)).join(", ")} indica(n) posibles personas atrapadas después de que ${unit} informó que no hay (C${d.seq}). Confirmar con la unidad.`,
        sources: [...uniq(newerWeak.map((g) => g.label)), `C${d.seq}`],
      });
    }
    if (status === "no_evidence") {
      status = "cleared_by_unit";
      basis.push(`${unit}, unidad en el lugar, informó por radio que no hay personas atrapadas (C${d.seq}): «${truncate(d.text, 100)}». Ninguna imagen lo contradice.`);
      if (olderWeak.length > 0) basis.push(`Antes de ese informe: ${describeWeak(olderWeak).join("; ")}.`);
    }
    evidence.push(radioRef(d.seq, d.speaker, d.text));
  } else {
    if (visualStatus) {
      status = visualStatus;
      if (visual.length > 0) {
        const high = visual.filter((p) => p.confidence === "high");
        basis.push(
          high.length > 0
            ? `Video con confianza alta: ${visualDesc()}.`
            : visualLabels.length >= 2
              ? `Visto en ${visualLabels.length} medios distintos: ${visualDesc()}.`
              : `Indicios visuales de confianza ${visual.map((p) => (p.confidence === "medium" ? "media" : "baja"))[0]}: ${visualDesc()}.`,
        );
        pushGroups(visual);
      } else {
        basis.push(`Posible atrapamiento en vehículo según video (${uniq(visualEntrapment.map((i) => i.label)).join(", ")}).`);
        for (const it of visualEntrapment) evidence.push({ ref: it.label, frame: -1, note: "Posible atrapamiento en vehículo" });
      }
    }
    if (weak.length > 0) {
      if (!visualStatus) status = "possible";
      basis.push(`${visualStatus ? "Además" : "Indicio sin corroborar"}: ${describeWeak(weak).join("; ")}.`);
      pushGroups(weak);
    }
    if (verdict.status === "reported") {
      status = status === "no_evidence" ? "possible" : status;
      basis.push(`Reporte radial sin confirmación de una unidad en el lugar (${radioReports.map((r) => `C${r.seq}`).join(", ")}).`);
      pushGroups(people.filter((p) => p.source === "radio"));
    }
    if (status === "no_evidence") {
      basis.push("Sin indicios en las fuentes disponibles; no descarta víctimas.");
      const analyzed = items.filter((i) => i.analysis).map((i) => i.label);
      basis.push(
        analyzed.length > 0
          ? `Medios revisados: ${analyzed.join(", ")}${items.some((i) => i.analysis && !i.visual) ? " (algunos sin análisis visual)" : ""}.`
          : "Aún no hay medios analizados.",
      );
      if (verdict.invalidDenials.length > 0) {
        const d = verdict.invalidDenials[verdict.invalidDenials.length - 1];
        basis.push(`C${d.seq}: ${d.speaker} dijo que no hay atrapados, pero no consta que esté en el lugar.`);
      }
    }
  }

  // Cantidades.
  const perMedia = new Map<string, number>();
  for (const g of visual) perMedia.set(g.label, (perMedia.get(g.label) ?? 0) + g.count);
  const visualMax = Math.max(0, ...perMedia.values());
  const visualSum = Array.from(perMedia.values()).reduce((a, b) => a + b, 0);
  const otherMax = Math.max(0, ...weak.map((g) => g.count), ...radioReports.map((r) => r.count ?? 1));
  let countMin = 0;
  let countMax = 0;
  if (status === "confirmed") {
    countMin = Math.max(1, ...radioReports.filter((r) => r.byOnSceneUnit).map((r) => r.count ?? 1));
    countMax = Math.max(countMin, visualSum, otherMax);
  } else if (status === "probable") {
    countMin = Math.max(1, visualMax);
    countMax = Math.max(countMin, visualSum, otherMax);
  } else if (status === "possible") {
    countMin = 0;
    countMax = Math.max(1, visualSum, otherMax);
  }

  return {
    trapped: {
      status,
      count_min: countMin,
      count_max: countMax,
      locations: uniq(locations).slice(0, 5),
      basis: truncate(basis.join(" "), 700),
      evidence: dedupeEvidence(evidence, 10),
    },
    contradictions,
  };
}

/* ─────────────────────────── Informe de situación ─────────────────────────── */

type Insight = SituationReport["insights"][number];
type Action = SituationReport["recommended_actions"][number];

function rearViewAvailable(facts: FusionFacts): boolean {
  return facts.visualItems.some((it) => {
    const a = it.analysis;
    if (!a) return false;
    if (a.fire.locations.some((l) => l.side === "rear")) return true;
    if (a.viewpoint.elevation === "aerial") return true;
    return /\b(posterior|trasero|trasera|patio|atras|detras|charlie|fondo)\b/.test(normalizeText(a.viewpoint.position_description));
  });
}

function minutesAgo(nowIso: string, iso: string | null): number | null {
  const now = timeOf(nowIso);
  const t = timeOf(iso);
  if (!Number.isFinite(now) || !Number.isFinite(t)) return null;
  return Math.max(0, Math.round((now - t) / 60000));
}

export function simulateSituation(input: FusionInput): SituationReport {
  const f = buildFacts(input);
  const incident = input.incident;
  const typeLabel = INCIDENT_LABEL[f.incidentType];
  const radio = f.radio;
  const trapped = f.trapped;
  const vehicleIncident = f.incidentType === "vehicle_collision" || f.incidentType === "vehicle_fire";
  const fireControlled = radio.fireControlledSeq !== null;

  /* Severidad */
  let severity: Severity = "low";
  const raise = (s: Severity) => {
    const rank: Record<Severity, number> = { low: 0, moderate: 1, high: 2, critical: 3 };
    if (rank[s] > rank[severity]) severity = s;
  };
  if (f.fire.present || vehicleIncident || f.hazards.length > 0 || f.injured.status !== "no_evidence") raise("moderate");
  const structureBurning = f.structure.present && f.fire.sources.length > 0 && f.fire.flames;
  if (!fireControlled && (f.fire.stage === "fully_developed" || structureBurning)) raise("high");
  if (f.hazards.some((h) => h.severity === "high")) raise("high");
  if (trapped.status === "possible") raise("high");
  if (f.injured.status === "confirmed" || f.injured.status === "probable") raise("high");
  if (f.vehicleEntrapment === "confirmed" || f.vehicleEntrapment === "probable") raise("high");
  if (trapped.status === "confirmed" || trapped.status === "probable" || radio.maydayActive) raise("critical");

  /* Fuego */
  const fireLocText = uniq(
    f.fire.locations.map((l) => `${l.floor > 0 ? floorText(l.floor) : "piso no determinado"}, ${SIDE_LABEL[l.side]} (${l.label})`),
  ).slice(0, 4);
  const smokeText =
    f.fire.smokeSources.length > 0
      ? `Humo ${f.fire.smokeColor !== "unknown" && f.fire.smokeColor !== "none" ? colorLabel(f.fire.smokeColor) : "de color no determinado"}, volumen ${volumeLabel(f.fire.smokeVolume)} (${f.fire.smokeSources.join(", ")}). El color en video es poco confiable.`
      : "Humo no evaluado en el material disponible.";
  const spreadParts: string[] = [];
  if (f.fire.spreadRisk !== "unknown") spreadParts.push(`Riesgo de propagación ${riskLabel(f.fire.spreadRisk)} según video`);
  if (f.fire.exposures.length > 0) spreadParts.push(`exposiciones: ${f.fire.exposures.slice(0, 3).join("; ")}`);
  if (fireControlled) spreadParts.push(`radio informa fuego controlado (C${radio.fireControlledSeq})`);
  const fire: SituationReport["fire"] = {
    present: f.fire.present,
    stage: f.fire.stage,
    location: fireLocText.length > 0 ? fireLocText.join("; ") : f.fire.present ? "No determinada en el material disponible." : "",
    spread: spreadParts.length > 0 ? `${spreadParts.join("; ")}.` : "No evaluada; confirmar exposiciones por todos los costados al llegar.",
    smoke: smokeText,
  };

  /* Estructura */
  const structure: SituationReport["structure"] = {
    description: f.structure.present
      ? f.structure.descriptions.length > 0
        ? truncate(f.structure.descriptions.join(" "), 300)
        : `${f.structure.kind !== "unknown" ? STRUCTURE_LABEL[f.structure.kind] : "Edificación"} según notas o tipo de incidente; sin verificación visual.`
      : "",
    floors: f.structure.floors,
    construction: f.structure.construction,
    exposures: f.structure.exposures.join("; "),
  };

  /* Vehículos */
  const vehicles: SituationReport["vehicles"] = {
    count: f.vehicles.length,
    description:
      f.vehicles.length > 0
        ? f.vehicles.map((v) => `${VEHICLE_LABEL[v.kind]} ${VEHICLE_STATE_LABEL[v.state]} (${v.label}${v.visual ? "" : ", sin verificar"})`).join("; ")
        : vehicleIncident
          ? "Sin imágenes analizadas de los vehículos."
          : "",
    entrapment: f.vehicleEntrapment,
    details:
      f.vehicles.length > 0
        ? f.vehicles
            .map((v) => `${VEHICLE_LABEL[v.kind]}: ${truncate(v.description, 100)}${v.leaking ? "; posible derrame de fluidos" : ""}${v.entrapment ? "; posible atrapamiento" : ""}`)
            .join(" · ")
        : "",
  };

  /* Acceso */
  const waterSupply =
    f.water.length > 0
      ? `Fuentes observadas: ${f.water.slice(0, 3).join("; ")}. Operatividad no verificada.`
      : f.hydrantMentioned
        ? `Grifo mencionado en ${f.hydrantSources.join(", ")}; ubicación y operatividad no verificadas.`
        : "No se observan fuentes de agua en el material disponible; no asumir grifos cercanos.";
  const access: SituationReport["access"] = {
    best_approach:
      f.accessDescriptions.length > 0
        ? truncate(f.accessDescriptions.join(" "), 300)
        : `Por ${incident.address || "la dirección informada"}; sin imágenes del acceso, confirmar al llegar.`,
    obstructions: f.obstructions.slice(0, 6),
    water_supply: waterSupply,
    staging_suggestion: vehicleIncident
      ? "Considerar posicionar el primer carro protegiendo la escena del tránsito y dejar espacio para ambulancias."
      : f.incidentType === "wildland_fire"
        ? "Considerar una zona de espera con salida segura, fuera de la dirección de avance del fuego."
        : "Considerar una zona de espera fuera del frente inmediato de la estructura, sin bloquear el acceso de escalas ni de otras unidades.",
  };

  /* Contradicciones */
  const contradictions: SituationReport["contradictions"] = [...f.trappedContradictions];
  if (fireControlled && radio.fireControlledSeq !== null) {
    const ctrlEntry = input.comms.find((c) => c.seq === radio.fireControlledSeq);
    const ctrlT = timeOf(ctrlEntry?.at);
    const later = f.visualItems.filter(
      (i) => Number.isFinite(ctrlT) && i.time > ctrlT && i.analysis?.fire.flames_visible && STAGE_RANK[i.analysis.fire.stage] >= STAGE_RANK.growth,
    );
    if (later.length > 0) {
      contradictions.push({
        description: `Radio informa fuego controlado (C${radio.fireControlledSeq}), pero ${later.map((i) => i.label).join(", ")}, grabado(s) después, muestra(n) llamas activas.`,
        sources: [...later.map((i) => i.label), `C${radio.fireControlledSeq}`],
      });
    }
  }
  const visualTypes = uniq(
    f.visualItems.map((i) => i.analysis?.incident_type ?? "unknown").filter((t) => t !== "unknown" && t !== "other"),
  );
  if (visualTypes.length > 1) {
    const labelsByType = visualTypes.map((t) => `${f.visualItems.filter((i) => i.analysis?.incident_type === t).map((i) => i.label).join(", ")}: ${INCIDENT_LABEL[t].toLowerCase()}`);
    contradictions.push({
      description: `Los videos muestran emergencias de distinto tipo (${labelsByType.join("; ")}). Pueden ser emergencias distintas o un medio mal asociado.`,
      sources: f.visualItems.filter((i) => i.analysis && (visualTypes as readonly IncidentType[]).includes(i.analysis.incident_type)).map((i) => i.label),
    });
  }

  /* Hallazgos */
  const insights: Omit<Insight, "id">[] = [];
  if (radio.maydayActive) {
    insights.push({
      category: "life_safety",
      priority: "critical",
      title: "MAYDAY activo: bombero en emergencia",
      detail: truncate(radio.maydayDetail, 240),
      confidence: "high",
      evidence: radio.maydaySeqs.slice(-2).map((s) => {
        const e = input.comms.find((c) => c.seq === s);
        return radioRef(s, e?.speaker ?? "Radio", e?.text ?? "");
      }),
    });
  }
  insights.push(trappedInsight(trapped));
  if (f.injured.status !== "no_evidence") {
    insights.push({
      category: "life_safety",
      priority: f.injured.status === "confirmed" || f.injured.status === "probable" ? "high" : "medium",
      title: `Lesionados ${likelihoodLabel(f.injured.status)}${f.injured.count_estimate > 0 ? ` (≈${f.injured.count_estimate})` : ""}`,
      detail: f.injured.detail,
      confidence: f.injured.status === "confirmed" ? "high" : "low",
      evidence: dedupeEvidence(
        f.people.filter((p) => p.status === "injured").flatMap((p) => p.evidence),
        4,
      ),
    });
  }
  if (f.vehicleEntrapment !== "no_evidence" && (vehicleIncident || f.vehicles.length > 0)) {
    insights.push({
      category: "vehicle",
      priority: f.vehicleEntrapment === "possible" ? "high" : "critical",
      title: `Atrapamiento en vehículo ${likelihoodLabel(f.vehicleEntrapment)}`,
      detail: vehicles.details || vehicles.description,
      confidence: f.vehicleEntrapment === "confirmed" ? "high" : f.vehicleEntrapment === "probable" ? "medium" : "low",
      evidence: dedupeEvidence(f.vehicles.map((v) => ({ ref: v.label, frame: -1, note: truncate(v.description, 120) })), 4),
    });
  }
  if (f.fire.sources.length > 0) {
    const conf = f.visualItems
      .filter((i) => f.fire.sources.includes(i.label))
      .map((i) => i.analysis?.confidence ?? "low")
      .reduce<Confidence>((a, b) => maxConf(a, b), "low");
    const keyRefs = f.visualItems
      .filter((i) => f.fire.sources.includes(i.label))
      .flatMap((i) => framesRefs(i.label, (i.analysis?.key_frames ?? []).map((k) => k.frame), "Fuego visible"));
    insights.push({
      category: "fire_behavior",
      priority: f.fire.stage === "fully_developed" && !fireControlled ? "high" : "medium",
      title: `Fuego ${STAGE_LABEL[f.fire.stage]}${fireLocText.length > 0 ? ` en ${fireLocText[0]}` : ""}`,
      detail: `${fire.location} ${fire.smoke}`.trim(),
      confidence: conf,
      evidence: dedupeEvidence(keyRefs, 4),
    });
  } else if (f.fire.present && f.visualItems.length === 0) {
    insights.push({
      category: "fire_behavior",
      priority: "medium",
      title: "Fuego informado, sin verificación visual",
      detail: `${fire.location || "Ubicación no determinada."} ${fire.smoke}`.trim(),
      confidence: "low",
      evidence: dedupeEvidence(
        f.items.filter((i) => i.note.fire).map((i) => ({ ref: i.label, frame: -1, note: `Nota: «${truncate(i.note.original, 100)}»` })),
        3,
      ),
    });
  }
  if (f.fire.exposures.length > 0 || f.fire.spreadRisk === "high") {
    insights.push({
      category: "fire_behavior",
      priority: f.fire.spreadRisk === "high" ? "high" : "medium",
      title: `Riesgo de propagación ${riskLabel(f.fire.spreadRisk)}`,
      detail: fire.spread,
      confidence: "medium",
      evidence: dedupeEvidence(f.visualItems.filter((i) => i.analysis?.structure.exposures.trim()).map((i) => ({ ref: i.label, frame: -1, note: truncate(i.analysis?.structure.exposures ?? "", 120) })), 3),
    });
  }
  for (const h of f.hazards.slice(0, 4)) {
    const visualRef = h.evidence.some((e) => f.visualItems.some((i) => i.label === e.ref));
    const radioRefd = h.evidence.some((e) => e.ref.startsWith("C"));
    insights.push({
      category: "hazard",
      priority: h.severity === "high" ? "high" : h.severity === "medium" ? "medium" : "low",
      title: `Peligro: ${HAZARD_LABEL[h.kind]}`,
      detail: h.description,
      confidence: visualRef ? "medium" : radioRefd ? "medium" : "low",
      evidence: h.evidence.slice(0, 4),
    });
  }
  if (fireControlled) {
    const e = input.comms.find((c) => c.seq === radio.fireControlledSeq);
    insights.push({
      category: "fire_behavior",
      priority: "medium",
      title: "Radio informa fuego controlado",
      detail: "Puede seguir el trabajo de remoción y hay riesgo de reignición.",
      confidence: "medium",
      evidence: e ? [radioRef(e.seq, e.speaker, e.text)] : [],
    });
  }
  const pending = radio.requests.filter((r) => !r.resolved);
  if (pending.length > 0) {
    insights.push({
      category: "resources",
      priority: "medium",
      title: "Recursos solicitados sin confirmar en el lugar",
      detail: pending.map((r) => `C${r.seq} · ${r.speaker}: ${r.text}`).join("; "),
      confidence: "medium",
      evidence: pending.slice(0, 4).map((r) => ({ ref: `C${r.seq}`, frame: -1, note: truncate(`${r.speaker} solicita ${r.text}`, 120) })),
    });
  }
  if (f.obstructions.length > 0) {
    insights.push({
      category: "access",
      priority: "medium",
      title: "Obstáculos en el acceso",
      detail: f.obstructions.slice(0, 4).join("; "),
      confidence: "medium",
      evidence: [],
    });
  }
  const nonVisual = f.items.filter((i) => !i.visual);
  if (nonVisual.length > 0) {
    insights.push({
      category: "other",
      priority: "low",
      title: `${nonVisual.length} medio(s) sin análisis visual del modelo`,
      detail: `${nonVisual.map((i) => i.label).join(", ")}: lo que aportan proviene de notas o reglas, no de las imágenes. Revisa esos videos directamente.`,
      confidence: "low",
      evidence: nonVisual.slice(0, 4).map((i) => ({ ref: i.label, frame: -1, note: "Sin análisis visual" })),
    });
  }
  const sortedInsights: Insight[] = insights
    .map((ins, i) => ({ ins, i }))
    .sort((a, b) => PRIORITY_RANK[a.ins.priority] - PRIORITY_RANK[b.ins.priority] || a.i - b.i)
    .slice(0, 10)
    .map(({ ins }, i) => ({ id: `I${i + 1}`, ...ins }));

  /* Incógnitas */
  const unknowns: string[] = [];
  if (f.visualItems.length === 0) unknowns.push("No hay imágenes analizadas por el modelo; la situación se basa en notas, radio y reglas.");
  if (f.structure.present && !rearViewAvailable(f)) unknowns.push("No hay imágenes del lado Charlie (posterior)");
  if (vehicleIncident) unknowns.push("Sin vista completa (360°) de los vehículos: ocupantes, eyectados y tipo de propulsión.");
  if (trapped.status === "no_evidence" || trapped.status === "possible") {
    unknowns.push("Si hay personas en el interior: ninguna fuente lo ha confirmado ni descartado.");
  }
  if (f.structure.present) unknowns.push("Condición interior y de la techumbre (no visible desde el exterior).");
  if (!f.hazards.some((h) => h.kind === "gas_cylinder" || h.kind === "gas_line")) unknowns.push("Si hay cilindros de gas o red de gas comprometidos.");
  if (!f.hazards.some((h) => h.kind === "power_lines" || h.kind === "electrical")) unknowns.push("Estado del empalme y del tendido eléctrico.");
  if (f.water.length === 0) unknowns.push("Ubicación y operatividad de grifos cercanos.");
  if (input.comms.length === 0) unknowns.push("Sin comunicaciones radiales registradas.");
  else if (!radio.command.established) unknowns.push("Quién está al mando (OBAC) y dónde está el puesto de comando.");
  const newest = [...f.items].filter((i) => Number.isFinite(i.time)).sort((a, b) => b.time - a.time)[0];
  if (newest) {
    const mins = minutesAgo(input.now, newest.media.captured_at ?? newest.media.created_at);
    if (mins !== null && mins >= 5) unknowns.push(`El medio más reciente (${newest.label}) tiene unos ${mins} min; la escena pudo cambiar.`);
  }

  /* Consideraciones de apoyo (nunca estrategia) */
  const actions: Action[] = [];
  const locs = trapped.locations.length > 0 ? ` (${trapped.locations.slice(0, 2).join("; ")})` : "";
  if (radio.maydayActive) {
    actions.push({
      action: "Considerar priorizar el apoyo al bombero en emergencia (mayday) y despejar el canal de radio.",
      rationale: truncate(radio.maydayDetail, 160),
      priority: "critical",
    });
  }
  if (trapped.status === "confirmed" || trapped.status === "probable") {
    actions.push({ action: `Considerar priorizar búsqueda y rescate${locs}.`, rationale: truncate(trapped.basis, 200), priority: "critical" });
  } else if (trapped.status === "possible") {
    actions.push({
      action: `Considerar verificar con prioridad la posible persona atrapada${locs}.`,
      rationale: truncate(trapped.basis, 200),
      priority: "high",
    });
  } else if (trapped.status === "no_evidence") {
    actions.push({
      action: "Considerar preguntar a moradores y vecinos si falta alguien.",
      rationale: "Sin indicios en las fuentes disponibles; no descarta víctimas.",
      priority: "high",
    });
  } else {
    actions.push({
      action: "Considerar mantener la confirmación con la unidad en el lugar sobre la búsqueda secundaria.",
      rationale: "El descarte proviene de una unidad en el lugar; puede cambiar si aparece nueva información.",
      priority: "medium",
    });
  }
  if (f.vehicleEntrapment !== "no_evidence" && vehicleIncident) {
    actions.push({
      action: "Considerar recursos de rescate vehicular, estabilización y control de riesgos inminentes.",
      rationale: `Atrapamiento ${likelihoodLabel(f.vehicleEntrapment)} según las fuentes.`,
      priority: "high",
    });
  }
  const has = (k: HazardKind) => f.hazards.some((h) => h.kind === k);
  if (has("gas_cylinder") || has("gas_line")) {
    actions.push({
      action: "Considerar ubicar y aislar cilindros de gas y coordinar el corte de suministro.",
      rationale: "Hay indicios de gas en las fuentes.",
      priority: "high",
    });
  }
  if (has("power_lines") || has("electrical")) {
    actions.push({
      action: "Considerar solicitar el corte de energía a la compañía eléctrica y señalizar cables.",
      rationale: "Hay indicios de riesgo eléctrico en las fuentes.",
      priority: "high",
    });
  }
  if (has("collapse_risk")) {
    actions.push({
      action: "Considerar delimitar una zona de colapso alrededor de la estructura.",
      rationale: "Hay indicios de riesgo de colapso; la construcción liviana puede fallar sin aviso.",
      priority: "high",
    });
  }
  if (vehicleIncident && (has("traffic") || f.incidentType === "vehicle_collision")) {
    actions.push({
      action: "Considerar proteger la escena del tránsito con un carro de bloqueo y señalización.",
      rationale: "Tránsito activo es un riesgo inminente en rescate vehicular.",
      priority: "medium",
    });
  }
  if (f.fire.exposures.length > 0 && !fireControlled) {
    actions.push({
      action: "Considerar proteger las exposiciones identificadas.",
      rationale: truncate(f.fire.exposures.join("; "), 160),
      priority: "high",
    });
  }
  if (f.structure.present && !rearViewAvailable(f)) {
    actions.push({
      action: "Considerar obtener vista del lado Charlie (posterior), por ejemplo con el dron o una unidad.",
      rationale: "Ninguna fuente muestra ese costado.",
      priority: "medium",
    });
  }
  if (pending.length > 0) {
    actions.push({
      action: "Confirmar el arribo de los recursos solicitados.",
      rationale: pending.slice(0, 3).map((r) => `C${r.seq}: ${r.text}`).join("; "),
      priority: "medium",
    });
  }
  const recommended = actions
    .map((a, i) => ({ a, i }))
    .sort((x, y) => PRIORITY_RANK[x.a.priority] - PRIORITY_RANK[y.a.priority] || x.i - y.i)
    .slice(0, 6)
    .map(({ a }) => a);

  /* Briefing */
  const place = incident.address ? ` en ${incident.address}` : "";
  const spokenParts: string[] = [];
  if (radio.maydayActive) spokenParts.push("Atención: hay un mayday activo.");
  const floorsWord = f.structure.floors > 0 ? `, ${f.structure.floors} ${f.structure.floors === 1 ? "piso" : "pisos"}` : "";
  spokenParts.push(`${typeLabel}${place}${f.structure.present && f.structure.kind !== "unknown" ? `, ${STRUCTURE_LABEL[f.structure.kind]}` : ""}${f.structure.kind === "unknown" ? floorsWord : ""}.`);
  spokenParts.push(spokenTrapped(trapped));
  if (f.fire.present && fireLocText.length > 0) {
    const l = f.fire.locations[0];
    spokenParts.push(`Fuego ${l.floor > 0 ? `en el ${spokenFloor(l.floor)}` : "de ubicación no determinada"}${l.side !== "unknown" ? `, ${SIDE_LABEL[l.side].replace(/ \(.*\)$/, "")}` : ""}.`);
  } else if (f.fire.present) {
    spokenParts.push("Fuego informado, ubicación no confirmada.");
  }
  if (vehicleIncident && f.vehicles.length > 0) {
    spokenParts.push(`${f.vehicles.length} ${f.vehicles.length === 1 ? "vehículo" : "vehículos"}: ${uniq(f.vehicles.map((v) => `${VEHICLE_LABEL[v.kind]} ${VEHICLE_STATE_LABEL[v.state]}`)).slice(0, 2).join(", ")}.`);
  }
  if (f.hazards.length > 0) spokenParts.push(`Peligros: ${f.hazards.slice(0, 3).map((h) => HAZARD_LABEL[h.kind]).join(", ")}.`);
  if (fireControlled) spokenParts.push("Radio informa fuego controlado.");
  spokenParts.push(f.water.length > 0 || f.hydrantMentioned ? "Hay un grifo mencionado; operatividad no verificada." : "No hay grifos confirmados.");
  if (f.structure.present && !rearViewAvailable(f)) spokenParts.push("No hay imágenes de la parte posterior.");
  const spoken = limitWords(spokenParts, 90);

  const bullets: string[] = [];
  if (radio.maydayActive) bullets.push("MAYDAY ACTIVO");
  bullets.push(`${typeLabel}${incident.address ? ` · ${truncate(incident.address, 60)}` : ""}`);
  bullets.push(
    `Atrapados: ${TRAPPED_LABEL[trapped.status]}${trapped.count_max > 0 ? ` (${trapped.count_min}–${trapped.count_max})` : ""}`,
  );
  bullets.push(`Lesionados: ${likelihoodLabel(f.injured.status)}`);
  if (f.fire.present) bullets.push(`Fuego: ${fireLocText[0] ?? "ubicación no determinada"}`);
  if (vehicleIncident || f.vehicles.length > 0) bullets.push(`Vehículos: ${f.vehicles.length > 0 ? vehicles.description : "sin imágenes"}`);
  bullets.push(`Peligros: ${f.hazards.length > 0 ? f.hazards.slice(0, 3).map((h) => HAZARD_LABEL[h.kind]).join(", ") : "no informados (no se descartan)"}`);
  const onScene = Array.from(radio.units).filter(([, u]) => isOnScene(u.status)).map(([n]) => n);
  bullets.push(
    input.comms.length > 0
      ? `Radio: ${onScene.length > 0 ? `en el lugar ${onScene.slice(0, 4).join(", ")}` : "sin unidades en el lugar"}${radio.command.established && radio.command.commander ? ` · mando ${radio.command.commander}` : ""}`
      : "Radio: sin registros",
  );
  bullets.push(`Agua: ${f.water.length > 0 || f.hydrantMentioned ? "grifo mencionado, sin verificar" : "sin fuentes confirmadas"}`);
  const finalBullets = bullets.slice(0, 8);

  /* Confianza global */
  const corroborating = f.visualItems.filter((i) => i.analysis && i.analysis.confidence !== "low");
  const agreeing = corroborating.filter((i) => i.analysis?.incident_type === f.incidentType);
  const overall: Confidence = agreeing.length >= 2 ? "medium" : "low";

  /* Titular */
  const lifeShort: Record<TrappedStatus, string> = {
    confirmed: "personas atrapadas confirmadas por unidad en el lugar",
    probable: "probable persona atrapada",
    possible: "posible persona atrapada (sin confirmar)",
    no_evidence: "sin indicios de atrapados (no descarta)",
    cleared_by_unit: "unidad en el lugar informa sin atrapados",
  };
  const headParts = [
    `${typeLabel}${f.structure.present && f.structure.kind !== "unknown" ? ` · ${STRUCTURE_LABEL[f.structure.kind]}` : ""}`,
    lifeShort[trapped.status],
  ];
  if (f.hazards[0]?.severity === "high") headParts.push(HAZARD_LABEL[f.hazards[0].kind]);
  const headline = `${radio.maydayActive ? "MAYDAY ACTIVO — " : ""}${headParts.join("; ")}`;

  return {
    headline: truncate(headline, 140),
    incident_type: f.incidentType,
    severity,
    trapped,
    injured: f.injured,
    fire,
    structure,
    vehicles,
    hazards: f.hazards,
    access,
    insights: sortedInsights,
    contradictions,
    unknowns: uniq(unknowns).slice(0, 8),
    recommended_actions: recommended,
    briefing: { spoken, bullets: finalBullets },
    overall_confidence: overall,
  };
}

function trappedInsight(trapped: SituationReport["trapped"]): Omit<Insight, "id"> {
  const s = trapped.status;
  const priority: Priority = s === "confirmed" || s === "probable" ? "critical" : s === "possible" ? "high" : "medium";
  const title: Record<TrappedStatus, string> = {
    confirmed: "Personas atrapadas confirmadas por unidad en el lugar",
    probable: "Probable persona atrapada",
    possible: "Posible persona atrapada",
    no_evidence: "Sin indicios de personas atrapadas — no descarta víctimas",
    cleared_by_unit: "Unidad en el lugar informa que no hay atrapados",
  };
  const conf: Confidence = s === "confirmed" || s === "cleared_by_unit" ? "high" : s === "probable" ? "medium" : "low";
  return {
    category: "life_safety",
    priority,
    title: title[s],
    detail: trapped.basis,
    confidence: conf,
    evidence: trapped.evidence.slice(0, 6),
  };
}

function spokenTrapped(trapped: SituationReport["trapped"]): string {
  const where = trapped.locations.length > 0 ? `, ${trapped.locations[0].replace(/\s*\((M|C|nota )[^)]*\)\s*$/, "")}` : "";
  switch (trapped.status) {
    case "confirmed":
      return `Unidad en el lugar confirma personas atrapadas${where}.`;
    case "probable":
      return `Probable persona atrapada${where}, vista en video.`;
    case "possible":
      return "Posible persona atrapada, sin confirmar.";
    case "cleared_by_unit":
      return "La unidad en el lugar informa que no hay personas atrapadas.";
    default:
      return "Sin indicios de personas atrapadas; no se descartan víctimas.";
  }
}

function likelihoodLabel(l: Likelihood): string {
  return { confirmed: "confirmados", probable: "probables", possible: "posibles", no_evidence: "sin evidencia (no descarta)" }[l];
}

function riskLabel(r: "low" | "moderate" | "high" | "unknown"): string {
  return { low: "bajo", moderate: "moderado", high: "alto", unknown: "no determinado" }[r];
}

function colorLabel(c: SmokeColor): string {
  return { none: "ausente", white: "blanco", gray: "gris", black: "negro", brown: "café", yellow: "amarillento", unknown: "de color no determinado" }[c];
}

function volumeLabel(v: SmokeVolume): string {
  return { none: "nulo", light: "bajo", moderate: "moderado", heavy: "abundante" }[v];
}

/* ─────────────────────────── Reconstrucción espacial ─────────────────────────── */

interface StructureDims {
  width: number;
  depth: number;
  floors: number;
  floorH: number;
}

function structureDims(kind: StructureKind, floorsKnown: number): StructureDims {
  const f = floorsKnown > 0 ? floorsKnown : 0;
  switch (kind) {
    case "house_1_story":
      return { width: 8, depth: 10, floors: f || 1, floorH: 2.7 };
    case "house_2_story":
      return { width: 8, depth: 10, floors: f || 2, floorH: 2.7 };
    case "apartment_building":
      return { width: 20, depth: 15, floors: f || 4, floorH: 2.7 };
    case "commercial":
      return { width: 12, depth: 15, floors: f || 1, floorH: 3.5 };
    case "industrial":
      return { width: 25, depth: 35, floors: f || 1, floorH: 6 };
    case "warehouse":
      return { width: 20, depth: 30, floors: f || 1, floorH: 6 };
    case "informal_settlement":
      return { width: 4, depth: 6, floors: f || 1, floorH: 2.4 };
    default:
      return f >= 3 ? { width: 20, depth: 15, floors: f, floorH: 2.7 } : { width: 8, depth: 10, floors: f || 1, floorH: 2.7 };
  }
}

const VEHICLE_DIMS: Record<VehicleKind, [number, number]> = {
  car: [4.5, 1.8],
  suv_pickup: [5.2, 1.9],
  van: [5.2, 2],
  truck: [9, 2.5],
  bus: [12, 2.55],
  motorcycle: [2.1, 0.8],
  bicycle: [1.8, 0.6],
  trailer: [8, 2.5],
  other: [4.5, 1.8],
};

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function streetName(address: string): string {
  const m = /^([^\d,]+?)\s*(\d|,|$)/.exec(address.trim());
  return m ? m[1].trim() : "";
}

function lateralOffset(text: string, width: number): number {
  const t = normalizeText(text);
  if (/\bizquierd/.test(t)) return -width / 4;
  if (/\bderech/.test(t)) return width / 4;
  return 0;
}

export function simulateScene(input: FusionInput): SceneModel {
  const f = buildFacts(input);
  const notes: string[] = ["Reconstrucción por reglas: no se analizó la geometría de las imágenes."];
  const type = f.incidentType;
  const vehicleIncident = type === "vehicle_collision" || type === "vehicle_fire";
  const hasStructure = f.structure.present && !(vehicleIncident && !f.structure.descriptions.length && !f.items.some((i) => i.note.structureMentioned));

  let kind: StructureKind = f.structure.kind;
  if (kind === "unknown" || kind === "other") {
    kind = f.structure.floors >= 3 ? "apartment_building" : f.structure.floors === 2 ? "house_2_story" : "house_1_story";
    if (hasStructure) notes.push(`Tipo de edificación supuesto: ${STRUCTURE_LABEL[kind]}.`);
  }
  const dims = structureDims(kind, f.structure.floors);
  const height = dims.floors * dims.floorH;
  const roadY = hasStructure ? -(dims.depth / 2 + 7) : vehicleIncident ? 0 : -12;
  const frontY = hasStructure ? -dims.depth / 2 : roadY + 3.5;
  const name = streetName(input.incident.address);

  notes.push(
    "Calle principal supuesta al sur del incidente, de Este a Oeste (sin datos de trazado).",
    hasStructure
      ? `Dimensiones típicas asumidas: ${dims.width}×${dims.depth} m en planta, ${dims.floors} piso(s) de ${String(dims.floorH).replace(".", ",")} m; calle de 7 m.`
      : "Calle de 7 m de ancho asumida.",
  );
  if (hasStructure) notes.push("Fachada principal (lado Alfa) supuesta hacia la calle (rumbo 180°); lados izquierdo/derecho vistos desde la calle.");

  const roads: SceneModel["roads"] = [
    { id: "R1", name, x1: -50, y1: round1(roadY), x2: 50, y2: round1(roadY), width_m: 7, blocked: false },
  ];

  const structures: SceneModel["structures"] = hasStructure
    ? [
        {
          id: "S1",
          label: `${STRUCTURE_LABEL[kind].replace(/^./, (c) => c.toUpperCase())} (incidente)`,
          kind,
          role: "involved",
          x: 0,
          y: 0,
          width_m: dims.width,
          depth_m: dims.depth,
          floors: dims.floors,
          floor_height_m: dims.floorH,
          rotation_deg: 180,
          roof: "unknown",
          construction: f.structure.construction,
          confidence: "low",
          notes: f.structure.floors > 0 ? "Pisos según las fuentes; planta supuesta." : "Pisos y planta supuestos.",
        },
      ]
    : [];

  /* Vehículos */
  const vehicleList: VehicleFact[] =
    f.vehicles.length > 0
      ? f.vehicles
      : vehicleIncident
        ? [
            {
              label: "",
              kind: "car",
              state: type === "vehicle_fire" ? "burning" : "unknown",
              entrapment: false,
              leaking: false,
              description: "Vehículo supuesto: no hay imágenes analizadas del vehículo.",
              visual: false,
            },
          ]
        : [];
  if (vehicleIncident && f.vehicles.length === 0) notes.push("Vehículo dibujado por supuesto (4,5×1,8 m) sobre la vía; no hay imágenes analizadas.");
  if (vehicleList.length > 0) notes.push("Vehículos ubicados sobre la vía en fila; posición relativa no determinada.");
  const vehicles: SceneModel["vehicles"] = vehicleList.slice(0, 8).map((v, i, arr) => {
    const [len, wid] = VEHICLE_DIMS[v.kind];
    return {
      id: `V${i + 1}`,
      kind: v.kind,
      state: v.state,
      x: round1((i - (arr.length - 1) / 2) * 6.5),
      y: round1(roadY),
      rotation_deg: 90,
      length_m: len,
      width_m: wid,
      entrapment_suspected: v.entrapment,
      burning: v.state === "burning",
      note: truncate(`${v.label ? `${v.label}: ` : ""}${v.description}`, 160),
    };
  });

  /* Focos */
  const fireZones: SceneModel["fire_zones"] = [];
  const seenZone = new Set<string>();
  const intensityOf = (stage: FireStage, flames: boolean): SceneModel["fire_zones"][number]["intensity"] =>
    stage === "fully_developed" ? "heavy" : stage === "growth" ? "moderate" : stage === "incipient" || stage === "decay" ? "light" : flames ? "moderate" : "smoke_only";
  if (hasStructure) {
    for (const loc of f.fire.locations) {
      const floor = loc.floor > 0 ? Math.min(loc.floor, dims.floors) : 1;
      const key = `${floor}|${loc.side}`;
      if (seenZone.has(key)) continue;
      seenZone.add(key);
      const p = sidePoint(loc.side, dims.width, dims.depth);
      fireZones.push({
        id: `F${fireZones.length + 1}`,
        structure_id: "S1",
        floor,
        side: loc.side,
        x: round1(p.x),
        y: round1(p.y),
        z: round1(loc.side === "roof" ? height : (floor - 1) * dims.floorH + dims.floorH / 2),
        radius_m: loc.side === "whole_floor" ? round1(Math.max(dims.width, dims.depth) / 2) : kind === "warehouse" || kind === "industrial" ? 6 : 2.5,
        intensity: intensityOf(loc.stage, loc.flames),
        confidence: loc.confidence === "high" ? "medium" : "low",
        note: truncate(`${loc.label}: ${loc.description}${loc.floor > 0 ? "" : " (piso no determinado)"}`, 160),
      });
    }
    if (fireZones.length === 0 && f.fire.present && !vehicleIncident) {
      fireZones.push({
        id: "F1",
        structure_id: "S1",
        floor: 1,
        side: "unknown",
        x: 0,
        y: 0,
        z: round1(dims.floorH / 2),
        radius_m: 2.5,
        intensity: intensityOf(f.fire.stage, f.fire.flames),
        confidence: "low",
        note: "Ubicación del foco no determinada; se dibuja al centro de la estructura.",
      });
    }
  }
  for (const v of vehicles) {
    if (!v.burning) continue;
    fireZones.push({
      id: `F${fireZones.length + 1}`,
      structure_id: "",
      floor: 0,
      side: "unknown",
      x: v.x,
      y: v.y,
      z: 0.8,
      radius_m: 2.5,
      intensity: "moderate",
      confidence: "low",
      note: `Vehículo ${v.id} en llamas${f.vehicles.length === 0 ? " (supuesto por el tipo de incidente)" : ""}.`,
    });
  }
  if (type === "wildland_fire" && fireZones.length === 0 && f.fire.present) {
    fireZones.push({
      id: "F1",
      structure_id: "",
      floor: 0,
      side: "unknown",
      x: 0,
      y: 0,
      z: 0.5,
      radius_m: 15,
      intensity: intensityOf(f.fire.stage, f.fire.flames),
      confidence: "low",
      note: "Frente de fuego supuesto en el punto informado; extensión no determinada.",
    });
    notes.push("Extensión del incendio de vegetación no determinada; se dibuja un círculo de 15 m.");
  }

  /* Humo */
  const smokePlumes: SceneModel["smoke_plumes"] =
    f.fire.smokeSources.length > 0 && f.fire.smokeVolume !== "none"
      ? [
          {
            id: "SM1",
            x: fireZones[0]?.x ?? 0,
            y: fireZones[0]?.y ?? 0,
            z: round1((hasStructure ? height : 1) + 3),
            drift_deg: -1,
            volume: f.fire.smokeVolume,
            color: f.fire.smokeColor,
          },
        ]
      : [];

  /* Personas */
  const people: SceneModel["people"] = [];
  const groups = new Map<string, PersonGroup & { refs: EvidenceRef[]; labels: string[] }>();
  for (const g of f.people) {
    if (g.status === "bystander" || g.status === "responder") continue;
    if (g.source === "radio" && f.people.some((p) => p.source !== "radio" && TRAPPED_PERSON.includes(p.status))) continue;
    const key = `${g.status}|${g.floor}`;
    const prev = groups.get(key);
    if (prev) {
      prev.count = Math.max(prev.count, g.count);
      prev.confidence = maxConf(prev.confidence, g.confidence);
      prev.refs = dedupeEvidence([...prev.refs, ...g.evidence], 6);
      if (!prev.labels.includes(g.label)) prev.labels.push(g.label);
    } else {
      groups.set(key, { ...g, refs: [...g.evidence], labels: [g.label] });
    }
  }
  let outsideIdx = 0;
  for (const g of groups.values()) {
    const floor = g.floor > 0 ? Math.min(g.floor, hasStructure ? dims.floors : g.floor) : hasStructure ? 1 : 0;
    let x = 0;
    let y = 0;
    let z = 0;
    let structureId = "";
    const inVehicle = !hasStructure && vehicles.length > 0 && (g.status === "trapped" || g.status === "unknown");
    if (inVehicle) {
      x = vehicles[0].x;
      y = vehicles[0].y;
      z = 0.8;
    } else if (hasStructure && g.status === "at_window_or_balcony") {
      x = lateralOffset(g.location, dims.width);
      y = frontY - 0.3;
      z = (floor - 1) * dims.floorH + 1.2;
      structureId = "S1";
    } else if (hasStructure && g.status === "on_roof") {
      z = height + 0.3;
      structureId = "S1";
    } else if (hasStructure && (g.status === "trapped" || g.status === "unknown")) {
      x = lateralOffset(g.location, dims.width);
      z = (floor - 1) * dims.floorH + 0.9;
      structureId = "S1";
    } else {
      x = (outsideIdx % 2 === 0 ? -1 : 1) * (3 + 2 * Math.floor(outsideIdx / 2));
      y = hasStructure ? frontY - 3 : roadY + 5;
      outsideIdx++;
    }
    people.push({
      id: `P${people.length + 1}`,
      status: g.status,
      count: g.count,
      structure_id: structureId,
      floor: structureId ? floor : 0,
      x: round1(x),
      y: round1(y),
      z: round1(z),
      confidence: g.source === "visual" ? g.confidence : g.source === "radio" ? (g.confidence === "high" ? "medium" : "low") : "low",
      note: truncate(`${g.labels.join(", ")}: ${g.location}${g.floor > 0 ? "" : " (piso no determinado)"}`, 160),
      evidence: g.refs,
    });
  }
  if (people.length > 0) notes.push("Personas ubicadas de forma aproximada según piso y ubicación descrita (ventana → en la fachada).");

  /* Peligros */
  const base = hasStructure ? { x: 0, y: 0 } : vehicles[0] ? { x: vehicles[0].x, y: vehicles[0].y } : { x: 0, y: 0 };
  const hazards: SceneModel["hazards"] = f.hazards.slice(0, 10).map((h, i) => {
    const desc = normalizeText(h.description);
    const rearHint = /\b(patio|atras|detras|posterior|fondo)\b/.test(desc);
    let p = { x: base.x, y: base.y, z: 0.5 };
    let r = 5;
    switch (h.kind) {
      case "gas_cylinder":
        p = hasStructure ? { x: dims.width / 2 + 1.5, y: rearHint ? dims.depth / 2 - 1.5 : 0, z: 0.6 } : { x: base.x + 4, y: base.y + 3, z: 0.6 };
        r = 10;
        break;
      case "gas_line":
        p = hasStructure ? { x: dims.width / 2 - 0.5, y: frontY - 0.5, z: 0.5 } : p;
        r = 10;
        break;
      case "power_lines":
        p = { x: base.x, y: roadY + 4.5, z: 7 };
        r = 5;
        break;
      case "electrical":
        p = hasStructure ? { x: -dims.width / 2 + 0.5, y: frontY - 0.3, z: 2.5 } : p;
        r = 3;
        break;
      case "fuel_spill":
      case "ev_battery":
        p = vehicles[0] ? { x: vehicles[0].x, y: vehicles[0].y, z: 0.2 } : { x: base.x, y: roadY, z: 0.2 };
        r = h.kind === "ev_battery" ? 8 : 4;
        break;
      case "solar_panels":
        p = { x: 0, y: 0, z: hasStructure ? height : 3 };
        r = 3;
        break;
      case "collapse_risk":
        p = { x: 0, y: 0, z: 0 };
        r = round1(Math.max(5, 1.5 * height));
        break;
      case "explosion_risk":
        p = { x: base.x, y: base.y, z: 1 };
        r = 20;
        break;
      case "traffic":
        p = { x: base.x, y: roadY, z: 0 };
        r = 15;
        break;
      case "crowd":
        p = { x: base.x, y: roadY - 6, z: 0 };
        r = 6;
        break;
      case "water_hazard":
        p = { x: base.x, y: (hasStructure ? dims.depth / 2 : 0) + 10, z: 0 };
        r = 5;
        break;
      case "hazmat_placard":
        p = vehicles[0] ? { x: vehicles[0].x, y: vehicles[0].y, z: 1 } : { x: base.x, y: base.y, z: 1 };
        r = 10;
        break;
      default:
        p = { x: base.x, y: frontY - 2, z: 0.5 };
        r = 5;
    }
    return {
      id: `H${i + 1}`,
      kind: h.kind,
      x: round1(p.x),
      y: round1(p.y),
      z: round1(p.z),
      radius_m: r,
      severity: h.severity,
      note: truncate(`${h.description} Ubicación aproximada; radio esquemático, no es una distancia de aislamiento.`, 200),
    };
  });
  if (hazards.length > 0) notes.push("Peligros dibujados en ubicaciones aproximadas junto a la estructura o al vehículo; los radios son esquemáticos.");

  /* Cámaras */
  const origin = { lat: input.incident.lat, lng: input.incident.lng };
  const cameras: SceneModel["cameras"] = [];
  const noGps = input.media.filter((fm) => !mediaPosition(fm.media));
  let noGpsIdx = 0;
  for (const fm of [...input.media].sort((a, b) => a.media.label.localeCompare(b.media.label, "es", { numeric: true }))) {
    const pos = mediaPosition(fm.media);
    const drone = fm.media.source === "drone";
    if (pos) {
      const local = toLocal(origin, pos);
      const acc = fm.media.accuracy_m;
      cameras.push({
        media_ref: fm.media.label,
        x: round1(local.x),
        y: round1(local.y),
        z: round1(drone ? (pos.alt ?? 40) : 1.5),
        facing_deg: pos.heading ?? -1,
        confidence: acc === null ? "medium" : acc <= 15 ? "high" : acc <= 50 ? "medium" : "low",
      });
    } else {
      const slot = noGpsIdx - (noGps.length - 1) / 2;
      noGpsIdx++;
      cameras.push({
        media_ref: fm.media.label,
        x: round1(slot * 8),
        y: round1(drone ? roadY - 20 : roadY - 6),
        z: drone ? 40 : 1.5,
        facing_deg: 0,
        confidence: "low",
      });
    }
  }
  if (noGps.length > 0) {
    notes.push(`Cámaras sin GPS (${noGps.map((m) => m.media.label).join(", ")}) ubicadas por supuesto al otro lado de la calle, mirando al norte.`);
  }

  /* Accesos */
  const accessPoints: SceneModel["access_points"] = [
    {
      id: "A1",
      kind: "street_entry",
      x: 0,
      y: round1(hasStructure ? frontY - 1 : roadY + 3.5),
      label: "Acceso desde la calle (supuesto)",
      note: "Acceso supuesto por el frente; confirmar al llegar.",
    },
  ];
  if (f.hydrantMentioned) {
    accessPoints.push({
      id: "A2",
      kind: "hydrant",
      x: 12,
      y: round1(roadY + 4.5),
      label: "Grifo mencionado",
      note: `Mencionado en ${f.hydrantSources.join(", ")}; ubicación aproximada y operatividad no verificada.`,
    });
  }

  /* Anotaciones */
  const annotations: SceneModel["annotations"] = [{ x: 20, y: round1(roadY), z: 0.2, text: name ? `${name} (trazado supuesto)` : "Calle supuesta" }];
  if (hasStructure) {
    annotations.push(
      { x: 0, y: round1(frontY - 1), z: round1(height + 1), text: "Lado Alfa (fachada, supuesta)" },
      { x: 0, y: round1(dims.depth / 2 + 1), z: round1(height + 1), text: "Lado Charlie (posterior)" },
    );
  }
  if (f.trapped.status === "confirmed" || f.trapped.status === "probable" || f.trapped.status === "possible") {
    annotations.push({ x: 0, y: 0, z: round1((hasStructure ? height : 2) + 2.5), text: `Personas atrapadas: ${TRAPPED_LABEL[f.trapped.status]}` });
  }

  const description = [
    "Reconstrucción esquemática por reglas.",
    hasStructure ? `${STRUCTURE_LABEL[kind].replace(/^./, (c) => c.toUpperCase())} al centro, fachada hacia la calle supuesta al sur.` : "Sin edificación involucrada; vía supuesta por el punto del incidente.",
    vehicles.length > 0 ? `${vehicles.length} vehículo(s) sobre la vía.` : "",
    fireZones.length > 0 ? `${fireZones.length} foco(s) aproximados.` : "",
    people.length > 0 ? `${people.length} grupo(s) de personas ubicados de forma aproximada.` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return {
    description,
    ground: { street_axis_deg: 90, notes: "Eje de la calle supuesto Este-Oeste, al sur del incidente." },
    roads,
    structures,
    fire_zones: fireZones,
    smoke_plumes: smokePlumes,
    people,
    vehicles,
    hazards,
    access_points: accessPoints,
    cameras,
    annotations,
    uncertainty_notes: uniq(notes),
    confidence: "low",
  };
}

function sidePoint(side: StructureSide, width: number, depth: number): { x: number; y: number } {
  // Fachada mirando al sur: frente = sur (y-), izquierda vista desde la calle = oeste (x-).
  switch (side) {
    case "front":
      return { x: 0, y: -depth / 2 };
    case "rear":
      return { x: 0, y: depth / 2 };
    case "left":
      return { x: -width / 2, y: 0 };
    case "right":
      return { x: width / 2, y: 0 };
    default:
      return { x: 0, y: 0 };
  }
}

function mediaPosition(m: Media): { lat: number; lng: number; alt: number | null; heading: number | null } | null {
  const heading = (h: number | null | undefined) => (h !== null && h !== undefined && Number.isFinite(h) ? h : null);
  if (m.lat !== null && m.lng !== null && isValidLatLng(m.lat, m.lng)) {
    const fr = m.frames.find((x) => x.alt_m !== null);
    return { lat: m.lat, lng: m.lng, alt: fr?.alt_m ?? null, heading: heading(m.heading_deg) ?? heading(m.frames[0]?.heading_deg) };
  }
  const fr = m.frames.find((x) => x.lat !== null && x.lng !== null && isValidLatLng(x.lat, x.lng));
  if (fr && fr.lat !== null && fr.lng !== null) {
    return { lat: fr.lat, lng: fr.lng, alt: fr.alt_m, heading: heading(fr.heading_deg) ?? heading(m.heading_deg) };
  }
  return null;
}

/* ═══════════════════════════════ Motor ═══════════════════════════════ */

export function createSimulatedEngine(): Engine {
  return {
    kind: "simulated",
    async analyzeMedia(input) {
      return simulateMediaAnalysis(input);
    },
    async analyzeComms(input) {
      return simulateCommsAnalysis(input);
    },
    async fuseSituation(input) {
      return simulateSituation(input);
    },
    async fuseScene(input) {
      return simulateScene(input);
    },
  };
}
