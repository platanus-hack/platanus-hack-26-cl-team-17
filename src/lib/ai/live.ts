/**
 * Observador en vivo del dron (solo servidor): una mirada barata cada ~15 s.
 *
 * El video en vivo no pasa por la IA cuadro a cuadro. Cada ventana de 15 s se
 * mandan como mucho 3 cuadros chicos (≈640 px) junto con la observación
 * anterior, y el modelo responde una frase con lo que importa o lo que cambió. Con detector
 * YOLO va el texto de las detecciones de la ventana y UN cuadro anotado en vez de 3 cuadros.
 * Con Claude usa config.aiLiveModel (Opus con effort bajo y modo rápido por defecto); sin
 * credencial no hay observador.
 */
import { z } from "zod";
import { aiEngineKind, config } from "@/lib/config";
import type { TimelineSeverity } from "@/lib/domain";
import { aggregateDetections, describeFrameDetections, detectionText, type DetectResult } from "@/lib/vision/types";
import { callStructured, type ModelSettings } from "./client";
import type { UserContent } from "./types";

export const LiveInsightAISchema = z.object({
  /** Una frase corta para el puesto de mando (lo más importante o lo que cambió). */
  summary: z.string(),
  severity: z.enum(["info", "notice", "warning", "critical"]),
  /** true si la escena cambió respecto de la observación anterior. */
  changed: z.boolean(),
  /** Hasta 4 observaciones breves y concretas. */
  observations: z.array(z.string()),
});
export type LiveInsightAI = z.infer<typeof LiveInsightAISchema>;

export interface LiveInsightInput {
  incident: { title: string; type: string; address: string };
  mission: { label: string; altitude_m: number | null; heading_deg: number | null };
  /** Cuadros JPEG en orden cronológico; `ago_s` = segundos antes del último. */
  frames: { base64: string; ago_s: number }[];
  previous: string | null;
  windowS: number;
  /**
   * Con detector YOLO: lo que vio en cada cuadro de la ventana. Entonces `frames` trae un solo
   * cuadro (el de más interés, anotado si se pudo) en vez de 3.
   */
  detections?: LiveDetectionWindow;
}

export interface LiveDetectionWindow {
  /** Resultado del detector por cuadro de la ventana, en orden cronológico. */
  results: { ago_s: number; result: DetectResult }[];
  /** El cuadro adjunto viene con las cajas del detector dibujadas. */
  annotated: boolean;
}

export interface LiveInsightResult extends LiveInsightAI {
  engine: "claude";
}

export const LIVE_SYSTEM_PROMPT = `Eres el observador en vivo de un dron de Bomberos sobre una emergencia activa.
Cada pocos segundos recibes de 1 a 3 cuadros de la cámara del dron (los más recientes al final) y tu observación anterior.

Tu respuesta la lee un oficial a cargo mientras dirige el incidente: debe servir para decidir.
- Prioriza, en este orden: personas visibles (en ventanas, techos, calle), fuego (dónde, cuánto, si avanza), humo (color, densidad, hacia dónde va), riesgo de colapso, propagación a estructuras vecinas, vehículos o accesos bloqueados.
- Si la escena no cambió respecto de la observación anterior, dilo en pocas palabras y marca changed=false.
- Describe solo lo que se ve. Si la imagen está borrosa, oscura o no muestra la escena, dilo; no adivines.
- Nunca afirmes que no hay víctimas: a lo más "no se ven personas en esta toma".
- summary: una sola frase en español, máximo 160 caracteres.
- observations: de 0 a 4 frases breves y concretas.
- severity: critical = personas en peligro o colapso inminente; warning = el fuego avanza o una exposición está amenazada; notice = cambio relevante; info = sin novedad.`;

export const LIVE_DETECTOR_SYSTEM_PROMPT = `${LIVE_SYSTEM_PROMPT}

Modo con detector automático: en vez de varios cuadros recibes, en texto, lo que un detector automático de objetos (YOLO) encontró en los cuadros de la ventana (etiqueta, confianza y ubicación en el cuadro) y UNA sola imagen, el cuadro de más interés, normalmente con las cajas del detector dibujadas.
- Las detecciones son indicios de una máquina: confiables para personas y vehículos sobre 50 %; en fuego y humo el detector da confianzas bajas aun cuando están, así que confírmalas con la imagen y trátalas como posibles.
- Usa la secuencia de detecciones para ver cambios en la ventana (personas que aparecen o desaparecen, humo que crece) y la imagen para ubicarlos.
- Las cajas y rótulos de la imagen los dibujó el detector; no son parte de la escena. Que el detector no vea personas no significa que no las haya.`;

const MAX_DETECTION_LINES = 8;

/** Una línea sin caracteres de control ni < > (las etiquetas vienen de la red). */
function safeLine(text: string): string {
  let out = "";
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    out += c < 32 || c === 127 || "<>＜＞".includes(ch) ? " " : ch;
  }
  return out.replace(/\s+/g, " ").trim().slice(0, 600);
}

/** Texto de las detecciones de la ventana: hasta 8 cuadros repartidos (siempre el último) y el resumen. */
export function buildLiveDetectionText(window: LiveDetectionWindow): string {
  const all = window.results;
  const picked =
    all.length <= MAX_DETECTION_LINES
      ? all
      : Array.from({ length: MAX_DETECTION_LINES }, (_, i) => all[Math.round(((all.length - 1) * i) / (MAX_DETECTION_LINES - 1))]);
  const lines = picked.map((r) =>
    safeLine(`${r.ago_s > 0 ? `hace ${r.ago_s} s` : "último cuadro"}: ${describeFrameDetections(r.result, 10)}`),
  );
  const summary = aggregateDetections(all.map((r) => r.result))
    .slice(0, 10)
    .map((a) =>
      safeLine(
        `- ${detectionText(a.label)}: hasta ${a.max_count} a la vez · confianza máx. ${Math.round(a.max_conf * 100)} % · en ${a.frames} de ${all.length} cuadros`,
      ),
    );
  return [
    `Detecciones automáticas (YOLO) en ${all.length} ${all.length === 1 ? "cuadro" : "cuadros"} de la ventana (entre paréntesis: ubicación vertical y horizontal en el cuadro):`,
    ...lines,
    summary.length > 0 ? `Resumen de la ventana:\n${summary.join("\n")}` : "Resumen de la ventana: sin detecciones.",
  ].join("\n");
}

function buildLiveUserContent(input: LiveInsightInput): UserContent {
  const m = input.mission;
  const lines = [
    `Incidente: ${input.incident.title} (${input.incident.type}) — ${input.incident.address || "sin dirección"}.`,
    `Dron ${m.label}${m.altitude_m != null ? `, ${Math.round(m.altitude_m)} m de altura` : ""}${m.heading_deg != null ? `, rumbo ${Math.round(m.heading_deg)}°` : ""}.`,
    `Ventana: últimos ${input.windowS} s, ${input.frames.length} ${input.frames.length === 1 ? "cuadro" : "cuadros"}.`,
    `Observación anterior: ${input.previous ?? "ninguna (primera mirada)."}`,
  ];
  const det = input.detections;
  if (det) {
    lines.push(buildLiveDetectionText(det));
    const f = input.frames[0];
    const content: UserContent = [{ type: "text", text: lines.join("\n") }];
    if (f) {
      const when = f.ago_s > 0 ? `hace ${f.ago_s} s` : "el más reciente";
      content.push({
        type: "text",
        text: `Cuadro de más interés (${when})${det.annotated ? ", con las cajas del detector dibujadas" : ""}:`,
      });
      content.push({ type: "image", media_type: "image/jpeg", base64: f.base64 });
    }
    return content;
  }
  const content: UserContent = [{ type: "text", text: lines.join("\n") }];
  for (const f of input.frames) {
    content.push({ type: "text", text: f.ago_s > 0 ? `Cuadro de hace ${f.ago_s} s:` : "Cuadro más reciente:" });
    content.push({ type: "image", media_type: "image/jpeg", base64: f.base64 });
  }
  return content;
}

function trimInsight(r: LiveInsightAI): LiveInsightAI {
  return {
    ...r,
    summary: r.summary.trim().slice(0, 240),
    observations: r.observations.map((o) => o.trim()).filter(Boolean).slice(0, 4),
  };
}

/** El modo rápido solo existe en Opus y Haiku no tiene respaldo del servidor ante un rechazo. */
export function liveModelSettings(): ModelSettings {
  const model = config.aiLiveModel;
  return {
    model,
    effort: config.aiLiveEffort,
    fast: config.aiLiveFast && model.startsWith("claude-opus"),
    fallback: !model.startsWith("claude-haiku"),
  };
}

export async function analyzeLiveFrames(input: LiveInsightInput): Promise<LiveInsightResult> {
  if (aiEngineKind() !== "claude") throw new Error("No hay IA configurada (falta la credencial de Anthropic).");
  const raw = await callStructured(
    {
      task: "live",
      system: input.detections ? LIVE_DETECTOR_SYSTEM_PROMPT : LIVE_SYSTEM_PROMPT,
      content: buildLiveUserContent(input),
      schema: LiveInsightAISchema,
      // El razonamiento cuenta dentro de max_tokens: margen para effort medio.
      maxTokens: 4000,
    },
    liveModelSettings(),
  );
  return { ...trimInsight(raw), engine: "claude" };
}

export const LIVE_SEVERITY_RANK: Record<TimelineSeverity, number> = { info: 0, notice: 1, warning: 2, critical: 3 };
