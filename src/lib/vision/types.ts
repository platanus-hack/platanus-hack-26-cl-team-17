/**
 * Detecciones del servicio YOLO (vigia/detector). Tipos y funciones puras: sirven en el
 * servidor y en el navegador (el video en vivo dibuja las cajas encima del cuadro).
 */

export type ZoneH = "izquierda" | "centro" | "derecha";
export type ZoneV = "alto" | "medio" | "bajo";

export interface Detection {
  /** Etiqueta en español del vocabulario de Vigía: persona, fuego, humo, cilindro_gas… */
  label: string;
  conf: number;
  /** [x1, y1, x2, y2] normalizado 0..1, origen arriba a la izquierda. */
  box: [number, number, number, number];
  zone: { h: ZoneH; v: ZoneV };
  /** Solo personas: tendido / de pie; null si no se pudo determinar. */
  pose: "tendido" | "de_pie" | null;
}

export interface DetectResult {
  width: number;
  height: number;
  /** Tiempo de inferencia del servicio. */
  ms: number;
  detections: Detection[];
  counts: Record<string, number>;
  /** JPEG con las cajas dibujadas (solo si se pidió annotate). */
  annotated_jpeg_b64?: string;
}

/** Etiquetas que importan para la vida o el riesgo: se destacan y deciden el cuadro anotado. */
export const CRITICAL_LABELS: ReadonlySet<string> = new Set(["persona", "fuego", "humo", "cilindro_gas", "cable_caido"]);

/** Nombre legible de una etiqueta del detector. */
export const DETECTION_LABEL_TEXT: Record<string, string> = {
  persona: "persona",
  bombero: "bombero",
  ventana: "ventana",
  puerta: "puerta",
  balcon: "balcón",
  fuego: "fuego",
  humo: "humo",
  cilindro_gas: "cilindro de gas",
  cable_caido: "cable caído",
  poste: "poste",
  auto: "auto",
  camioneta: "camioneta",
  camion: "camión",
  bus: "bus",
  moto: "moto",
  bicicleta: "bicicleta",
  carro_bomba: "carro bomba",
  ambulancia: "ambulancia",
  carabineros: "carabineros",
  escalera: "escalera",
  grifo: "grifo",
  escombros: "escombros",
  agua: "agua",
};

export function detectionText(label: string): string {
  return DETECTION_LABEL_TEXT[label] ?? label.replace(/_/g, " ");
}

/** Valida y normaliza lo que respondió el servicio (no confiar en la red). null si no cumple. */
export function parseDetectResult(raw: unknown): DetectResult | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.width !== "number" || typeof r.height !== "number" || !Array.isArray(r.detections)) return null;
  const detections: Detection[] = [];
  for (const d of r.detections as unknown[]) {
    if (!d || typeof d !== "object") continue;
    const x = d as Record<string, unknown>;
    const box = x.box;
    if (typeof x.label !== "string" || typeof x.conf !== "number" || !Array.isArray(box) || box.length !== 4) continue;
    const nums = box.map(Number);
    if (nums.some((n) => !Number.isFinite(n))) continue;
    const zone = (x.zone ?? {}) as Record<string, unknown>;
    const h: ZoneH = zone.h === "izquierda" || zone.h === "derecha" ? zone.h : "centro";
    const v: ZoneV = zone.v === "alto" || zone.v === "bajo" ? zone.v : "medio";
    detections.push({
      label: x.label,
      conf: Math.max(0, Math.min(1, x.conf)),
      box: [nums[0], nums[1], nums[2], nums[3]].map((n) => Math.max(0, Math.min(1, n))) as Detection["box"],
      zone: { h, v },
      pose: x.pose === "tendido" || x.pose === "de_pie" ? x.pose : null,
    });
  }
  const counts: Record<string, number> = {};
  for (const d of detections) counts[d.label] = (counts[d.label] ?? 0) + 1;
  return {
    width: r.width,
    height: r.height,
    ms: typeof r.ms === "number" ? r.ms : 0,
    detections,
    counts,
    annotated_jpeg_b64: typeof r.annotated_jpeg_b64 === "string" ? r.annotated_jpeg_b64 : undefined,
  };
}

/** Puntaje de un cuadro para elegir el que se anota: personas y peligros pesan más. */
export function frameInterest(result: DetectResult): number {
  let score = 0;
  for (const d of result.detections) {
    const w = d.label === "persona" ? 5 : CRITICAL_LABELS.has(d.label) ? 3 : 1;
    score += w * d.conf;
  }
  return score;
}

function pct(conf: number): string {
  return `${Math.round(conf * 100)} %`;
}

/** Una línea por cuadro: "t=4.0 s · persona 87 % (arriba, derecha, de pie) · humo 62 % (alto, centro)". */
export function describeFrameDetections(result: DetectResult, maxItems = 12): string {
  if (result.detections.length === 0) return "sin detecciones";
  return result.detections
    .slice(0, maxItems)
    .map((d) => {
      const parts = [`${d.zone.v}`, `${d.zone.h}`];
      if (d.label === "persona" && d.pose) parts.push(d.pose === "tendido" ? "tendida" : "de pie");
      return `${detectionText(d.label)} ${pct(d.conf)} (${parts.join(", ")})`;
    })
    .join(" · ");
}

/** Máximos por etiqueta en un medio: cuántas veces se ve como mucho en un mismo cuadro y con qué confianza. */
export function aggregateDetections(results: DetectResult[]): { label: string; max_count: number; max_conf: number; frames: number }[] {
  const acc = new Map<string, { max_count: number; max_conf: number; frames: number }>();
  for (const r of results) {
    const seen = new Set<string>();
    for (const [label, count] of Object.entries(r.counts)) {
      const cur = acc.get(label) ?? { max_count: 0, max_conf: 0, frames: 0 };
      cur.max_count = Math.max(cur.max_count, count);
      if (!seen.has(label)) {
        cur.frames += 1;
        seen.add(label);
      }
      acc.set(label, cur);
    }
    for (const d of r.detections) {
      const cur = acc.get(d.label);
      if (cur) cur.max_conf = Math.max(cur.max_conf, d.conf);
    }
  }
  return [...acc.entries()]
    .map(([label, v]) => ({ label, ...v }))
    .sort((a, b) => b.max_conf - a.max_conf);
}
