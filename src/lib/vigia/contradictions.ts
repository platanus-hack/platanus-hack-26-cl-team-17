/**
 * Contradicciones radio ↔ imagen que Vigía detecta por su cuenta, sin esperar la fusión ni
 * depender de Claude. Puro.
 *
 * La radio afirma una ausencia ("tercer piso despejado", "sin gas", "fuego controlado") y
 * una imagen la desmiente: el análisis de un video, lo que YOLO vio en ese video o lo que
 * YOLO ve en vivo en el dron. La fusión no ve el video en vivo del dron y, sin IA, el motor
 * de reglas no entiende "piso despejado" ni cruza el gas: por eso el cruce vive aquí.
 *
 * Cada contradicción cita las dos fuentes, la imagen (M2, D1) y la transmisión (C5), y el
 * texto ya va listo para decírselo al OBAC. Ante la duda avisa: callar una contradicción
 * puede costar una vida; avisar de más cuesta una confirmación por radio.
 */
import type { SituationReport } from "@/lib/domain";
import { fold } from "./rules";
import type { World, WorldMedia, WorldRadio } from "./world";

export type Contradiction = SituationReport["contradictions"][number];

export type ClaimKind = "sin_personas" | "sin_gas" | "fuego_controlado";

export interface RadioClaim {
  kind: ClaimKind;
  /** Piso al que se limita ("tercer piso despejado" → 3); null = toda la estructura. */
  floor: number | null;
  seq: number;
  at: string;
  speaker: string;
  /** Lo que dijo la radio, para citarlo. */
  quote: string;
}

export interface CrossContradiction extends Contradiction {
  /** Involucra posibles personas: va con prioridad de vida. */
  people: boolean;
}

/* ───────────────────────────── la radio ───────────────────────────── */

const ORDINAL: Record<string, number> = {
  primer: 1, primero: 1, segundo: 2, tercer: 3, tercero: 3, cuarto: 4, quinto: 5,
  sexto: 6, septimo: 7, octavo: 8, noveno: 9, decimo: 10,
};
const ORDINAL_SRC = Object.keys(ORDINAL).join("|");
/** "despejado", "revisado sin novedad", "negativo", "sin personas"… dicho de un piso. */
const FLOOR_CLEAR_SRC = String.raw`(?:despejad[oa]|revisad[oa],? sin novedad|sin novedad|negativ[oa]|sin (?:personas|victimas|moradores|gente|nadie))`;
const FLOOR_CLEAR_RES: readonly RegExp[] = [
  new RegExp(String.raw`\b(${ORDINAL_SRC}|\d{1,2})\s*(?:er|ro|do|to|vo|mo|no|°|º)?\s+piso\s+(?:esta\s+|queda\s+)?${FLOOR_CLEAR_SRC}`),
  new RegExp(String.raw`\bpiso\s+(\d{1,2})\s+(?:esta\s+|queda\s+)?${FLOOR_CLEAR_SRC}`),
  new RegExp(
    String.raw`\b(?:no hay (?:nadie|personas|gente|victimas)|sin (?:personas|victimas|gente|moradores)|nadie) en el (${ORDINAL_SRC}|\d{1,2})\s*(?:er|ro|do|to|vo|mo|no|°|º)?\s+piso\b`,
  ),
];
/** Ausencia de personas en toda la estructura. */
const NO_PEOPLE_RES: readonly RegExp[] = [
  /\b(?:sin|no hay|no se observan|no se encuentran|no quedan|cero|ningun[oa]?) (?:personas? |victimas? |gente |moradores |ocupantes )?atrapad[oa]s?\b/,
  /\b(?:sin|no hay|no quedan|no se encuentran) (?:personas?|victimas?|gente|moradores|ocupantes|nadie) (?:en el interior|al interior|adentro|dentro)\b/,
  /\bno hay nadie(?= (?:en la (?:casa|vivienda|estructura)|en el (?:edificio|departamento|inmueble))\b|\s*(?:[.;,!]|$))/,
  /\bbusqueda (?:primaria |secundaria )?(?:negativa|sin resultados|sin victimas)\b/,
  /\b(?:primaria|secundaria) negativa\b/,
  /\b(?:vivienda|casa|inmueble|estructura|departamento|edificio) (?:despejad[oa]|deshabitad[oa]|evacuad[oa]|sin moradores)\b/,
  /\btodos (?:evacuados|afuera|fuera)\b/,
];
const NO_GAS_RES: readonly RegExp[] = [
  /\b(?:sin|no hay|no se observa|no se observan) (?:presencia de )?(?:gas|cilindros?(?: de gas)?|balon(?:es)?(?: de gas)?)\b/,
  /\bgas (?:cortado|cerrado|controlado)\b/,
  /\bcorte de gas (?:realizado|efectuado|listo|ok|confirmado)\b/,
  /\b(?:se corto|cortamos|cerramos|se cerro) (?:el |la )?(?:gas|matriz de gas|llave de gas|medidor de gas)\b/,
  /\b(?:matriz|medidor|llave) de gas (?:cortad[oa]|cerrad[oa])\b/,
];
const FIRE_CONTROLLED_RES: readonly RegExp[] = [
  /\b(?:fuego|incendio|emergencia|situacion) (?:controlad[oa]|dominad[oa]|extinguid[oa]|circunscrit[oa])\b/,
  /\bcontrolado el (?:fuego|incendio)\b/,
];

/** Oración de la transmisión que contiene la posición `at` del texto plegado. */
function sentenceAt(original: string, at: number): string {
  const starts = [0];
  for (const m of original.matchAll(/[.!?;]\s+/g)) starts.push((m.index ?? 0) + m[0].length);
  const start = starts.filter((s) => s <= at).at(-1) ?? 0;
  const rest = original.slice(start);
  const end = rest.search(/[.!?;](\s|$)/);
  return (end >= 0 ? rest.slice(0, end) : rest).trim();
}

function quoteOf(original: string, at: number): string {
  const s = sentenceAt(original, at);
  return s.length <= 60 ? s : `${s.slice(0, 59).trimEnd()}…`;
}

/** "todavía no hay corte de gas realizado", "no está controlado el fuego": no es una afirmación. */
function negatedBefore(t: string, index: number): boolean {
  return /\b(?:no|aun no|todavia no|nunca)\s+(?:esta|estan|hay|se ha|ha|han)?\s*$/.test(t.slice(Math.max(0, index - 24), index));
}

function firstClaim(t: string, res: readonly RegExp[]): RegExpExecArray | null {
  for (const re of res) {
    const m = re.exec(t);
    if (m && !negatedBefore(t, m.index)) return m;
  }
  return null;
}

/** Afirmaciones de ausencia en una transmisión (las preguntas no cuentan). */
export function radioClaims(line: WorldRadio): RadioClaim[] {
  if (line.obac) return [];
  const original = line.text.normalize("NFC");
  const t = fold(original);
  if (/\?\s*$/.test(t)) return [];
  // Con NFC, fold pliega cada letra a una sola: los índices del texto plegado sirven para
  // citar el original. Si no (caracteres raros), se cita el plegado.
  const quoted = t.length === original.length ? original : t;
  const base = { seq: line.seq, at: line.at, speaker: line.speaker.trim() || "una unidad" };
  const out: RadioClaim[] = [];

  const floorHit = firstClaim(t, FLOOR_CLEAR_RES);
  const floor = floorHit ? (ORDINAL[floorHit[1]] ?? Number(floorHit[1])) : NaN;
  if (floorHit && Number.isFinite(floor) && floor >= 1) {
    out.push({ ...base, kind: "sin_personas", floor, quote: quoteOf(quoted, floorHit.index) });
  } else {
    const hit = firstClaim(t, NO_PEOPLE_RES);
    if (hit) out.push({ ...base, kind: "sin_personas", floor: null, quote: quoteOf(quoted, hit.index) });
  }
  const gas = firstClaim(t, NO_GAS_RES);
  if (gas) out.push({ ...base, kind: "sin_gas", floor: null, quote: quoteOf(quoted, gas.index) });
  const fire = firstClaim(t, FIRE_CONTROLLED_RES);
  if (fire) out.push({ ...base, kind: "fuego_controlado", floor: null, quote: quoteOf(quoted, fire.index) });
  return out;
}

/* ───────────────────────────── la imagen ───────────────────────────── */

/** Personas que importan para un descarte: no transeúntes, ni bomberos, ni quien ya sale. */
const PEOPLE_AT_RISK = new Set(["trapped", "at_window_or_balcony", "on_roof", "injured"]);
/** Confianza mínima de YOLO para desmentir a la radio (las mismas que despiertan a Vigía). */
const YOLO_MIN: Record<string, number> = { persona: 0.5, cilindro_gas: 0.35 };
const FIRE_ACTIVE = new Set(["growth", "fully_developed"]);

function floorInText(location: string): number | null {
  const t = fold(location);
  const m = new RegExp(String.raw`\b(${ORDINAL_SRC}|\d{1,2})\s*(?:er|ro|do|to|vo|mo|no|°|º)?\s+piso\b`).exec(t) ?? /\bpiso\s+(\d{1,2})\b/.exec(t);
  if (!m) return null;
  const n = ORDINAL[m[1]] ?? Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function pct(conf: number): string {
  return `${Math.round(conf * 100)} %`;
}

function said(c: RadioClaim): string {
  return `${c.speaker} informó «${c.quote}» (C${c.seq})`;
}

function usableMedia(world: World): WorldMedia[] {
  return world.media.filter((m) => m.status === "analyzed" && m.analysis !== null && m.analysis.usable !== false);
}

function peopleContradictions(world: World, c: RadioClaim): CrossContradiction[] {
  const out: CrossContradiction[] = [];
  for (const m of usableMedia(world)) {
    const p = (m.analysis?.people ?? []).find((x) => {
      if (!PEOPLE_AT_RISK.has(x.status)) return false;
      if (c.floor === null) return true;
      const floor = x.floor > 0 ? x.floor : floorInText(x.location);
      return floor === c.floor;
    });
    if (!p) continue;
    const where = p.location.trim() ? ` en ${p.location.trim()}` : c.floor ? ` en el piso ${c.floor}` : "";
    out.push({
      description: `${m.label} muestra posible persona${where}, pero ${said(c)}.`,
      sources: [m.label, `C${c.seq}`],
      people: true,
    });
  }
  // YOLO en vivo no sabe en qué piso está la persona: solo desmiente un descarte de toda la estructura.
  if (c.floor === null) {
    for (const d of world.drones) {
      const hits = (d.live?.result.detections ?? []).filter((x) => x.label === "persona" && x.conf >= YOLO_MIN.persona);
      if (hits.length === 0) continue;
      const best = Math.max(...hits.map((x) => x.conf));
      const lying = hits.some((x) => x.pose === "tendido");
      out.push({
        description: `El dron ${d.label} detecta posible persona${lying ? " tendida" : ""} (detección automática ${pct(best)}), pero ${said(c)}.`,
        sources: [d.label, `C${c.seq}`],
        people: true,
      });
    }
  }
  return out;
}

function gasContradictions(world: World, c: RadioClaim): CrossContradiction[] {
  const out: CrossContradiction[] = [];
  for (const m of usableMedia(world)) {
    const hazard = (m.analysis?.hazards ?? []).find((h) => h.kind === "gas_cylinder" || h.kind === "gas_line");
    const yolo = (m.detections ?? []).find((x) => x.label === "cilindro_gas" && x.max_conf >= YOLO_MIN.cilindro_gas);
    if (!hazard && !yolo) continue;
    const what = hazard
      ? `muestra ${hazard.kind === "gas_line" ? "posible fuga o red de gas" : "posible cilindro de gas"}`
      : `muestra posible cilindro de gas (detección automática ${pct(yolo?.max_conf ?? 0)})`;
    out.push({ description: `${m.label} ${what}, pero ${said(c)}.`, sources: [m.label, `C${c.seq}`], people: false });
  }
  for (const d of world.drones) {
    const hits = (d.live?.result.detections ?? []).filter((x) => x.label === "cilindro_gas" && x.conf >= YOLO_MIN.cilindro_gas);
    if (hits.length === 0) continue;
    out.push({
      description: `El dron ${d.label} detecta posible cilindro de gas (detección automática ${pct(Math.max(...hits.map((x) => x.conf)))}), pero ${said(c)}.`,
      sources: [d.label, `C${c.seq}`],
      people: false,
    });
  }
  return out;
}

function fireContradictions(world: World, c: RadioClaim): CrossContradiction[] {
  const claimAt = Date.parse(c.at);
  // Solo lo grabado después: antes del control el fuego ardía, eso no contradice nada.
  return usableMedia(world)
    .filter((m) => {
      const f = m.analysis?.fire;
      return Number.isFinite(claimAt) && Date.parse(m.created_at) > claimAt && f?.flames_visible === true && FIRE_ACTIVE.has(f.stage);
    })
    .map((m) => ({
      description: `${m.label}, grabado después, muestra llamas activas, pero ${said(c)}.`,
      sources: [m.label, `C${c.seq}`],
      people: false,
    }));
}

/** Clave de una contradicción por sus fuentes (la misma que usa el pipeline para no repetir alertas). */
export function sourcesKey(sources: readonly string[]): string {
  return `src:${[...new Set(sources.map((s) => s.trim().toUpperCase()).filter(Boolean))].sort().join("|")}`;
}

/** Todas las contradicciones radio ↔ imagen a la vista (las de personas primero). */
export function crossCheck(world: World): CrossContradiction[] {
  const out: CrossContradiction[] = [];
  const keys = new Set<string>();
  for (const line of world.radio) {
    for (const claim of radioClaims(line)) {
      const found =
        claim.kind === "sin_personas"
          ? peopleContradictions(world, claim)
          : claim.kind === "sin_gas"
            ? gasContradictions(world, claim)
            : fireContradictions(world, claim);
      for (const c of found) {
        const k = sourcesKey(c.sources);
        if (keys.has(k)) continue;
        keys.add(k);
        out.push(c);
      }
    }
  }
  return out.sort((a, b) => Number(b.people) - Number(a.people));
}

/**
 * Texto para el OBAC con las dos fuentes siempre a la vista: si el recorte se comió alguna
 * etiqueta, se agregan al final.
 */
export function contradictionText(c: Contradiction, max = 200): string {
  const d = c.description.trim().replace(/\s+/g, " ");
  const body = d.length <= max ? d : `${d.slice(0, max - 1).trimEnd()}…`;
  const missing = c.sources.filter((s) => !new RegExp(String.raw`(^|[^A-Za-z0-9])${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9]|$)`).test(body));
  return `OBAC, Vigía: no calza: ${body}${missing.length > 0 ? ` Fuentes: ${c.sources.join(" y ")}.` : ""}`;
}
