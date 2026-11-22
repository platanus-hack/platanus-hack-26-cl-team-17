/**
 * "Hablar con Vigía": el OBAC pregunta por voz y Vigía responde con lo que ya se sabe del
 * incidente (informe, escena, radio). Responde Claude; sin credencial de Anthropic la ruta
 * contesta 503 (no hay respuestas inventadas).
 *
 * Vigía informa, no decide: no dice por dónde entrar, atacar, ventilar o evacuar (lo mismo que
 * el agente de Vigía y el filtro del puente Zello). Nunca dice "no hay": dice "no se ve" o "no se sabe".
 */
import { z } from "zod";
import type { CommEntry, Incident } from "@/lib/domain";
import { runtimeMode } from "@/lib/config";
import { HttpError } from "@/lib/http";

export const AskInputSchema = z.object({
  question: z.string().trim().min(1, "Falta la pregunta.").max(500),
});

export interface AskAnswer {
  answer: string;
  /** Marcador del mapa al que se refiere la respuesta (P1, H1, V1, post, U:B-4…); null si ninguno. */
  focus: string | null;
  engine: "claude";
}

const AnswerSchema = z.object({
  answer: z.string().describe("Respuesta hablada, en español de Chile, de 1 a 3 frases cortas (máx. 45 palabras)."),
  focus: z
    .string()
    .describe('Id del marcador del mapa al que se refiere la respuesta (p. ej. "P1", "H1", "post", "U:B-4", "M1"); "" si ninguno.'),
});

const SYSTEM = `Eres Vigía, el asistente del oficial a cargo (OBAC) de Bomberos de Chile en una emergencia.
El OBAC te habla por voz camino al lugar o desde el puesto de mando. Respondes en voz alta.

Reglas:
- Responde solo con los datos del contexto. Si algo no está, di que no se sabe o que no se ve en los videos. Nunca digas "no hay".
- Informas, no decides: describes lo que se ve y se sabe; no dices por dónde entrar, atacar, ventilar o evacuar, ni si es seguro. La decisión es del OBAC. No uses "sugiero", "conviene" ni "hay que" con una acción táctica.
- Di de dónde lo sabes cuando puedas: "en 4 de 7 videos", "lo dijo B-3".
- Di la confianza cuando hables de personas o peligros ("confianza alta").
- Máximo 45 palabras, frases cortas, sin listas ni abreviaturas difíciles de pronunciar. Puedes usar claves radiales chilenas (6-3, 6-7).
- "focus" es el id del marcador del mapa del que hablas, tomado de la lista de marcadores; "" si ninguno.`;

/* ───────────────────────────── Contexto ───────────────────────────── */

function markerList(incident: Incident): string[] {
  const s = incident.scene;
  const out: string[] = [];
  for (const p of s?.people ?? []) out.push(`${p.id}: persona(s) ${p.status}, ${p.count}, confianza ${p.confidence}`);
  for (const h of s?.hazards ?? []) out.push(`${h.id}: peligro ${h.kind}, severidad ${h.severity}`);
  (s?.fire_zones ?? []).forEach((f, i) => out.push(`F${i}: foco de fuego, piso ${f.floor}, lado ${f.side}`));
  for (const v of s?.vehicles ?? []) out.push(`${v.id}: vehículo ${v.kind} ${v.state}`);
  for (const c of s?.cameras ?? []) out.push(`${c.media_ref}: cámara de vecino`);
  if (s?.access_points?.some((a) => a.kind === "command_post")) out.push("post: puesto de mando");
  for (const u of incident.comms_analysis?.units ?? []) out.push(`U:${u.name}: unidad ${u.status}`);
  return out;
}

function contextText(incident: Incident, comms: readonly CommEntry[]): string {
  const sit = incident.situation;
  const ctx = {
    incidente: { tipo: incident.type, direccion: incident.address, estado: incident.status },
    informe: sit
      ? {
          titular: sit.headline,
          atrapados: sit.trapped,
          lesionados: sit.injured,
          fuego: sit.fire,
          vehiculos: sit.vehicles,
          peligros: sit.hazards.map((h) => ({ tipo: h.kind, descripcion: h.description, severidad: h.severity })),
          acceso: sit.access,
          hallazgos: sit.insights.map((i) => ({ titulo: i.title, confianza: i.confidence, prioridad: i.priority })),
          no_se_sabe: sit.unknowns,
          sugerencias: sit.recommended_actions,
          confianza_global: sit.overall_confidence,
        }
      : "Aún no hay informe: no se han analizado videos.",
    radio: incident.comms_analysis
      ? { resumen: incident.comms_analysis.summary, unidades: incident.comms_analysis.units, mando: incident.comms_analysis.command }
      : null,
    ultimas_transmisiones: comms.slice(-8).map((c) => `C${c.seq} ${c.speaker}: ${c.text}`),
    marcadores: markerList(incident),
  };
  return JSON.stringify(ctx);
}

/* ───────────────────────────── Entrada ───────────────────────────── */

export async function answerQuestion(incident: Incident, comms: readonly CommEntry[], question: string): Promise<AskAnswer> {
  if (runtimeMode().ai !== "claude") {
    throw new HttpError(503, "internal", "No hay IA configurada en el servidor: Vigía no puede responder preguntas.");
  }
  const { callStructured } = await import("@/lib/ai/client");
  const out = await callStructured({
    task: "ask",
    system: SYSTEM,
    schema: AnswerSchema,
    maxTokens: 600,
    content: [{ type: "text", text: `Contexto del incidente (JSON):\n${contextText(incident, comms)}\n\nPregunta del OBAC: ${question}` }],
  });
  const valid = new Set(markerList(incident).map((m) => m.split(":").slice(0, m.startsWith("U:") ? 2 : 1).join(":")));
  const focus = out.focus && valid.has(out.focus) ? out.focus : null;
  return { answer: out.answer.trim(), focus, engine: "claude" };
}
