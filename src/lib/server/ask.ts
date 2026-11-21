/**
 * "Hablar con Vigía": el OBAC pregunta por voz y Vigía responde con lo que ya se sabe del
 * incidente (informe, escena, radio). Con Claude configurado responde el modelo; si no
 * (o si falla), un motor de reglas simulado que se rotula como tal en la interfaz.
 *
 * Vigía informa, no decide: no dice por dónde entrar, atacar, ventilar o evacuar (lo mismo que
 * el agente de Vigía y el filtro del puente Zello). Nunca dice "no hay": dice "no se ve" o "no se sabe".
 */
import { z } from "zod";
import type { CommEntry, Incident } from "@/lib/domain";
import { runtimeMode } from "@/lib/config";

export const AskInputSchema = z.object({
  question: z.string().trim().min(1, "Falta la pregunta.").max(500),
});

export interface AskAnswer {
  answer: string;
  /** Marcador del mapa al que se refiere la respuesta (P1, H1, V1, post, U:B-4…); null si ninguno. */
  focus: string | null;
  engine: "claude" | "simulated";
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

/* ───────────────────────────── Motor simulado ───────────────────────────── */

const CONF = { high: "alta", medium: "media", low: "baja" } as const;

function firstSentences(text: string, maxWords = 40): string {
  const parts = text.split(/(?<=[.!?])\s+/);
  let out = "";
  for (const p of parts) {
    const next = out ? `${out} ${p}` : p;
    if (next.split(/\s+/).length > maxWords && out) break;
    out = next;
  }
  return out.trim();
}

export function simulatedAnswer(incident: Incident, question: string): Omit<AskAnswer, "engine"> {
  const q = question.toLowerCase();
  const sit = incident.situation;
  const scene = incident.scene;
  const ca = incident.comms_analysis;
  if (!sit) {
    return {
      answer: "Todavía no hay videos analizados de este incidente. Apenas llegue el primero te aviso qué se ve.",
      focus: null,
    };
  }
  const trappedPin = scene?.people?.find((p) => p.status === "trapped")?.id ?? null;

  if (/atrapad|persona|v[ií]ctima|gente|ocupante|herid|lesionad/.test(q)) {
    const t = sit.trapped;
    if (t.status === "no_evidence") {
      return { answer: "No se ven personas atrapadas en los videos analizados. Eso no lo descarta: falta confirmarlo en el lugar.", focus: null };
    }
    if (t.status === "cleared_by_unit") return { answer: "Una unidad en el lugar informó que no quedan atrapados.", focus: null };
    const n = t.count_max > t.count_min ? `entre ${Math.max(1, t.count_min)} y ${t.count_max}` : String(Math.max(1, t.count_min));
    const where = t.locations[0] ? t.locations[0].split(/[:;]/)[0] : "lugar sin precisar";
    const conf = t.status === "confirmed" ? "alta" : t.status === "probable" ? "media" : "baja";
    const injured = sit.injured.count_estimate > 0 ? ` Además, ${sit.injured.count_estimate} lesionado.` : "";
    return { answer: `${n} atrapado en ${where}, confianza ${conf}.${injured}`, focus: trappedPin };
  }
  if (/riesgo|peligro|gas|combustible|derrame|el[eé]ctric|cable|bater/.test(q)) {
    const hs = [...sit.hazards].sort((a, b) => (b.severity === "high" ? 1 : 0) - (a.severity === "high" ? 1 : 0)).slice(0, 2);
    if (!hs.length) return { answer: "No se ven peligros especiales en los videos. Falta confirmarlo en el lugar.", focus: null };
    const first = scene?.hazards?.find((h) => h.kind === hs[0].kind)?.id ?? null;
    return { answer: `Riesgos principales: ${hs.map((h) => firstSentences(h.description, 14)).join(" Y ")}`, focus: first };
  }
  if (/agua|grifo|hidrante|abastec/.test(q)) {
    return { answer: firstSentences(sit.access.water_supply || "No se sabe dónde hay agua. La ubicación de grifos se pide con 6-5."), focus: null };
  }
  if (/llegar|acceso|entrar|ruta|estacion|posicion|carro/.test(q)) {
    const stage = sit.access.staging_suggestion ? ` ${firstSentences(sit.access.staging_suggestion, 16)}` : "";
    return { answer: `${firstSentences(sit.access.best_approach, 22)}${stage}`, focus: "post" };
  }
  if (/samu|ambulancia|carabineros|unidad|qui[eé]n|radio|lleg[oó]/.test(q) && ca) {
    const fire = ca.units.slice(0, 3).map((u) => `${u.name} ${u.status === "on_scene" || u.status === "operating" ? "6-3, en el lugar" : u.status === "en_route" ? "en camino" : "sin informe"}`);
    return { answer: `${fire.join(". ")}.`, focus: ca.units[0] ? `U:${ca.units[0].name}` : null };
  }
  if (/fuego|foco|humo|llama/.test(q)) {
    if (!sit.fire.present) return { answer: "No se ve fuego en los videos analizados. Eso no lo descarta.", focus: null };
    return { answer: firstSentences(`${sit.fire.location}. ${sit.fire.spread}`, 30), focus: scene?.fire_zones?.length ? "F0" : null };
  }
  if (/qu[eé] hago|sugier|recomiend|prioridad|qu[eé] har/.test(q)) {
    return { answer: `Eso lo decides tú. Lo que se sabe: ${firstSentences(sit.headline, 28)}`, focus: trappedPin };
  }
  return { answer: `${firstSentences(sit.headline, 30)} Confianza ${CONF[sit.overall_confidence]}.`, focus: trappedPin };
}

/* ───────────────────────────── Entrada ───────────────────────────── */

export async function answerQuestion(incident: Incident, comms: readonly CommEntry[], question: string): Promise<AskAnswer> {
  if (runtimeMode().ai === "claude") {
    try {
      const { callStructured } = await import("@/lib/ai/client");
      const out = await callStructured({
        task: "live",
        system: SYSTEM,
        schema: AnswerSchema,
        maxTokens: 600,
        content: [{ type: "text", text: `Contexto del incidente (JSON):\n${contextText(incident, comms)}\n\nPregunta del OBAC: ${question}` }],
      });
      const valid = new Set(markerList(incident).map((m) => m.split(":").slice(0, m.startsWith("U:") ? 2 : 1).join(":")));
      const focus = out.focus && valid.has(out.focus) ? out.focus : null;
      return { answer: out.answer.trim(), focus, engine: "claude" };
    } catch (err) {
      console.warn("[vigia-ask] Claude no respondió, se usa el motor simulado:", err);
    }
  }
  return { ...simulatedAnswer(incident, question), engine: "simulated" };
}
