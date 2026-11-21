/**
 * Observador en vivo del dron (solo servidor): una mirada barata cada ~15 s.
 *
 * El video en vivo no pasa por la IA cuadro a cuadro. Cada ventana de 15 s se
 * mandan como mucho 3 cuadros chicos (≈640 px) junto con la observación
 * anterior, y el modelo responde una frase con lo que importa o lo que cambió.
 * Con Claude usa config.aiLiveModel (Opus con effort bajo y modo rápido por defecto); sin
 * credencial responde el motor simulado, rotulado como tal.
 */
import { z } from "zod";
import { aiEngineKind, config } from "@/lib/config";
import type { TimelineSeverity } from "@/lib/domain";
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
}

export interface LiveInsightResult extends LiveInsightAI {
  engine: "claude" | "simulated";
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

function buildLiveUserContent(input: LiveInsightInput): UserContent {
  const m = input.mission;
  const lines = [
    `Incidente: ${input.incident.title} (${input.incident.type}) — ${input.incident.address || "sin dirección"}.`,
    `Dron ${m.label}${m.altitude_m != null ? `, ${Math.round(m.altitude_m)} m de altura` : ""}${m.heading_deg != null ? `, rumbo ${Math.round(m.heading_deg)}°` : ""}.`,
    `Ventana: últimos ${input.windowS} s, ${input.frames.length} ${input.frames.length === 1 ? "cuadro" : "cuadros"}.`,
    `Observación anterior: ${input.previous ?? "ninguna (primera mirada)."}`,
  ];
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

/** Sin IA real: no mira las imágenes, solo confirma que llega video. */
function simulatedInsight(input: LiveInsightInput): LiveInsightAI {
  return {
    summary: `SIMULADO — llegan ${input.frames.length} ${input.frames.length === 1 ? "cuadro" : "cuadros"} del dron ${input.mission.label}; sin IA real no se analiza la imagen.`,
    severity: "info",
    changed: false,
    observations: [],
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
  if (aiEngineKind() !== "claude") return { ...simulatedInsight(input), engine: "simulated" };
  const raw = await callStructured(
    {
      task: "live",
      system: LIVE_SYSTEM_PROMPT,
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
