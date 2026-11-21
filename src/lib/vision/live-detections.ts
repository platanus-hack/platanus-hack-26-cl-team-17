/**
 * Detecciones del video en vivo del dron: tipos y funciones puras compartidas por el servidor
 * (src/lib/drone/live.ts, ruta …/live/detections) y el navegador (LiveFeed dibuja las cajas).
 */
import { CRITICAL_LABELS, detectionText, type Detection, type DetectResult } from "./types";

/** Detección de un cuadro en vivo; `seq` es el del cuadro (X-Live-Seq). */
export interface LiveDetection {
  seq: number;
  at: string;
  result: DetectResult;
}

/**
 * GET /api/drone/[missionId]/live/detections[?after=<seq>]
 * `enabled` = el servidor tiene detector configurado; `recent` = detecciones con seq > after
 * (vacío sin after), en orden de seq.
 */
export interface LiveDetectionsResponse {
  enabled: boolean;
  latest: LiveDetection | null;
  recent: LiveDetection[];
}

/** Peligros a los que el detector da confianzas bajas aunque estén: se muestran desde más abajo. */
const LOW_CONF_LABELS: ReadonlySet<string> = new Set(["fuego", "humo", "cilindro_gas", "cable_caido"]);
const MIN_CONF_LOW = 0.15;
const MIN_CONF = 0.3;

/** Lo que se dibuja encima del video: sin ruido de confianza muy baja. */
export function overlayDetections(result: DetectResult): Detection[] {
  return result.detections.filter((d) => d.conf >= (LOW_CONF_LABELS.has(d.label) ? MIN_CONF_LOW : MIN_CONF));
}

const PLURAL: Record<string, string> = {
  persona: "personas",
  bombero: "bomberos",
  ventana: "ventanas",
  puerta: "puertas",
  balcon: "balcones",
  cilindro_gas: "cilindros de gas",
  cable_caido: "cables caídos",
  poste: "postes",
  auto: "autos",
  camioneta: "camionetas",
  camion: "camiones",
  bus: "buses",
  moto: "motos",
  bicicleta: "bicicletas",
  carro_bomba: "carros bomba",
  ambulancia: "ambulancias",
  carabineros: "carabineros",
  escalera: "escaleras",
  grifo: "grifos",
};
/** Sustantivos de masa: se nombran sin número ("humo", no "2 humos"). */
const MASS_LABELS: ReadonlySet<string> = new Set(["fuego", "humo", "escombros", "agua"]);
const CRITICAL_ORDER = ["persona", "fuego", "humo", "cilindro_gas", "cable_caido"];

/** "2 personas · humo · 1 auto": primero lo crítico, luego por cantidad. "" sin detecciones. */
export function detectionCountsLine(detections: readonly Detection[], max = 4): string {
  const counts = new Map<string, number>();
  for (const d of detections) counts.set(d.label, (counts.get(d.label) ?? 0) + 1);
  const rank = (label: string) => {
    const i = CRITICAL_ORDER.indexOf(label);
    return i >= 0 ? i : CRITICAL_ORDER.length;
  };
  const items = [...counts.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]) || b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([label, n]) => {
      if (MASS_LABELS.has(label)) return detectionText(label);
      if (n === 1) return `1 ${detectionText(label)}`;
      return `${n} ${PLURAL[label] ?? detectionText(label)}`;
    });
  const shown = items.slice(0, max);
  if (items.length > max) shown.push(`+${items.length - max}`);
  return shown.join(" · ");
}

export function hasCritical(detections: readonly Detection[]): boolean {
  return detections.some((d) => CRITICAL_LABELS.has(d.label));
}

/**
 * Detección para el cuadro que se está mostrando: la del mismo seq si ya llegó; si no, la
 * más cercana anterior (o posterior) dentro de `maxLagMs` (seq ≈ ms de llegada al servidor).
 */
export function pickDetectionForSeq(
  list: readonly LiveDetection[],
  seq: number,
  maxLagMs = 1500,
): LiveDetection | null {
  let before: LiveDetection | null = null;
  let after: LiveDetection | null = null;
  for (const d of list) {
    if (d.seq === seq) return d;
    if (d.seq < seq && seq - d.seq <= maxLagMs && (!before || d.seq > before.seq)) before = d;
    if (d.seq > seq && d.seq - seq <= maxLagMs && (!after || d.seq < after.seq)) after = d;
  }
  return before ?? after;
}

/** Junta detecciones nuevas a las conocidas (sin duplicar seq), ordenadas, quedándose con las últimas `keep`. */
export function mergeLiveDetections(
  known: readonly LiveDetection[],
  incoming: readonly LiveDetection[],
  keep = 30,
): LiveDetection[] {
  const bySeq = new Map<number, LiveDetection>();
  for (const d of known) bySeq.set(d.seq, d);
  for (const d of incoming) bySeq.set(d.seq, d);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq).slice(-keep);
}
