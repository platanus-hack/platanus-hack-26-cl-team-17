/**
 * Respaldo sin LLM: plantillas fijas con las claves. Se usa sin llave de Anthropic (rotulado
 * "plantilla" en la mesa de mando), con «Vigía sin IA» o si Claude falla en una vuelta.
 * Mismas herramientas y mismas reglas duras que el agente.
 */
import { formatClock } from "@/lib/format";
import { trappedStatusLabel } from "@/lib/labels";
import { contradictionText } from "./contradictions";
import { sideInText, sideName, sidesText } from "./coverage";
import type { VigiaEvent } from "./observe";
import { addAction, addLog, addUtterance, buildParte, pendientesText, runTool, statusLine, type TurnContext } from "./tools";
import type { VigiaQuestion } from "./types";
import { analyzedMedia, personSightings, type World } from "./world";
import { fold } from "./rules";
import { detectionText } from "@/lib/vision/types";

function clip(text: string, max = 90): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

function personWhere(p: { location: string; side: string | null }): string {
  const loc = p.location ? ` en ${p.location}` : "";
  return `${loc}${p.side ? `, ${sideName(p.side)}` : ""}`;
}

/** "Vista en 4 de 7 videos" (videos analizados que la ven sobre los que cubren su lado). */
function seenIn(world: World, side: string | null, mediaWithPerson: Set<string>): string {
  const analyzed = analyzedMedia(world);
  const covering = side ? analyzed.filter((m) => m.side === side).length : analyzed.length;
  return `Vista en ${mediaWithPerson.size} de ${Math.max(covering, mediaWithPerson.size)} videos`;
}

function presentation(ctx: TurnContext): string {
  const s = statusLine(ctx.world);
  const videos = s.videos === 0 ? "todavía no llegan videos" : `estoy mirando ${s.videos} ${s.videos === 1 ? "video" : "videos"}`;
  const radios = s.radios === 0 ? "todavía no escucho radio" : `escucho ${s.radios} ${s.radios === 1 ? "radio" : "radios"}`;
  const blind = ctx.world.blind.length > 0 ? ` Todavía no veo ${sidesText(ctx.world.blind)}.` : "";
  return `OBAC, Vigía: ${videos} y ${radios}.${blind}`;
}

/** Pide video del primer lado sin cobertura, si no hay ya un pedido activo. */
function requestBlindSide(ctx: TurnContext): void {
  const side = ctx.world.blind[0];
  if (!side || analyzedMedia(ctx.world).length === 0) return;
  runTool(ctx, "pedir_video", { zona: `del ${sideName(side).replace(/^el /, "")}`, motivo: `Ningún video cubre ${sideName(side)}.` });
}

export function answerQuestion(ctx: TurnContext, q: VigiaQuestion): void {
  const w = ctx.world;
  const t = fold(q.text);
  const people = personSightings(w);
  const reply = (text: string, priority: "persona" | "riesgo" | "recursos" | "resto" = "resto", evidence: string[] = []) =>
    addUtterance(ctx, { text, kind: "respuesta", priority, evidence, replyTo: q.id });

  const side = sideInText(q.text, w.scheme);
  if (side) {
    const covering = analyzedMedia(w).filter((m) => m.side === side);
    const here = people.filter((p) => p.side === side);
    if (here.length > 0) {
      const media = new Set(here.map((p) => p.media));
      reply(
        `OBAC, Vigía: en ${sideName(side)} veo posible persona${personWhere({ location: here[0].location, side: null })}. Vista en ${media.size} de ${covering.length} videos que lo cubren.`,
        "persona",
        [...media],
      );
    } else if (covering.length > 0) {
      reply(
        `OBAC, Vigía: no lo veo en ${sideName(side)}; esa zona la cubren ${covering.length} de ${analyzedMedia(w).length} videos. Eso no descarta personas.`,
        "resto",
        covering.map((m) => m.label),
      );
    } else {
      reply(`OBAC, Vigía: no tengo videos de ${sideName(side)}. Voy a pedir uno al público.`);
      runTool(ctx, "pedir_video", { zona: `del ${sideName(side).replace(/^el /, "")}`, motivo: "El OBAC preguntó por ese lado y no hay video." });
    }
    return;
  }
  if (/\b(persona|personas|alguien|gente|victima|victimas|atrapad|herid)/.test(t)) {
    if (people.length > 0) {
      const p = people[0];
      const media = new Set(people.filter((x) => x.side === p.side).map((x) => x.media));
      reply(`OBAC, Vigía: posible persona${personWhere(p)}. ${seenIn(w, p.side, media)}.`, "persona", [...media]);
    } else {
      reply(
        `OBAC, Vigía: no veo personas en los ${analyzedMedia(w).length} videos analizados.${w.blind.length > 0 ? ` No tengo video de ${sidesText(w.blind)}.` : ""} Eso no descarta que haya.`,
      );
    }
    return;
  }
  if (/\b(gas|riesgo|riesgos|peligro|cable|derrumbe|matpel|explos)/.test(t)) {
    const hazards = w.situation?.hazards ?? [];
    if (hazards.length > 0) {
      reply(`OBAC, Vigía: riesgo: ${clip(hazards[0].description, 120)}.`, "riesgo", hazards[0].evidence.map((e) => e.ref));
    } else {
      reply("OBAC, Vigía: no veo riesgos en los videos analizados. No veo dentro del edificio ni detrás del humo.");
    }
    return;
  }
  if (/\bpendiente/.test(t)) {
    reply(`OBAC, Vigía: ${clip(pendientesText(ctx.state, ctx.nowMs).replace(/\n/g, ". "), 200)}`);
    return;
  }
  if (/\bparte\b/.test(t)) {
    runTool(ctx, "armar_parte", { resumen: w.situation?.headline ?? "Emergencia atendida." });
    reply("OBAC, Vigía: armé el parte; está en la mesa de mando para exportar.");
    return;
  }
  const sit = w.situation;
  reply(`${presentation(ctx)}${sit ? ` ${clip(sit.headline, 140)}.` : ""}`);
}

/** Respuesta por plantillas a los eventos de una vuelta. */
export function fallbackTurn(ctx: TurnContext, events: VigiaEvent[]): void {
  const w = ctx.world;
  for (const e of events) {
    switch (e.type) {
      case "inicio":
        addUtterance(ctx, { text: presentation(ctx), kind: "presentacion", priority: "resto" });
        requestBlindSide(ctx);
        break;
      case "pregunta":
        answerQuestion(ctx, e.question);
        break;
      case "radio":
        for (const line of e.lines.slice(-3)) addAction(ctx, "escucha", `Escuché a ${line.speaker || "una unidad"}: ${clip(line.text, 70)}`);
        break;
      case "video_nuevo":
        addAction(ctx, "escucha", `Llegaron ${e.media.length} ${e.media.length === 1 ? "video" : "videos"}: ${e.media.map((m) => m.label).join(", ")}`);
        break;
      case "video_analizado": {
        const people = personSightings(w).filter((p) => e.media.some((m) => m.label === p.media));
        if (people.length > 0) {
          const p = people[0];
          const media = new Set(personSightings(w).filter((x) => x.side === p.side).map((x) => x.media));
          addUtterance(ctx, {
            text: `OBAC, Vigía: posible persona${personWhere(p)}. ${seenIn(w, p.side, media)}.`,
            kind: "alerta",
            priority: "persona",
            evidence: [...media],
            confidence: p.confidence === "high" ? "high" : p.confidence === "medium" ? "medium" : "low",
          });
          addLog(ctx, `Posible persona${personWhere(p)}`, "Vista en los videos analizados", [...media]);
        }
        for (const m of e.media) {
          const hazard = m.analysis?.hazards.find((h) => h.severity === "high");
          if (hazard) {
            addUtterance(ctx, { text: `OBAC, Vigía: riesgo: ${clip(hazard.description, 110)}. Lo vi en ${m.label}.`, kind: "alerta", priority: "riesgo", evidence: [m.label] });
          }
          addAction(ctx, "escucha", `Miré ${m.label}: ${clip(m.analysis?.summary ?? "sin resumen", 70)}`);
        }
        break;
      }
      case "situacion": {
        if (e.trapped && ["possible", "probable", "confirmed"].includes(e.trapped.to)) {
          const sit = w.situation;
          addUtterance(ctx, {
            text: `OBAC, Vigía: personas atrapadas: ${trappedStatusLabel[e.trapped.to as keyof typeof trappedStatusLabel].toLowerCase()}. ${clip(sit?.trapped.locations.join(", ") || sit?.trapped.basis || "", 110)}`,
            kind: "alerta",
            priority: "persona",
            evidence: sit?.trapped.evidence.map((x) => x.ref) ?? [],
          });
        }
        for (const c of e.contradictions.slice(0, 1)) {
          // Las del informe de situación quedan en la mesa; por radio van las de las reglas con personas.
          addUtterance(ctx, { text: contradictionText(c), radio: null, kind: "contradiccion", priority: "riesgo", evidence: c.sources });
        }
        break;
      }
      case "contradiccion":
        // Hasta dos por vuelta (las de personas primero); el resto queda en la bitácora.
        e.contradictions.forEach((c, i) => {
          if (i < 2) {
            const text = contradictionText(c);
            addUtterance(ctx, {
              text,
              radio: c.people ? text : null,
              kind: "contradiccion",
              priority: c.people ? "persona" : "riesgo",
              evidence: c.sources,
            });
          }
          addLog(ctx, `No calza: ${clip(c.description, 160)}`, "La radio dice una cosa y la imagen otra", c.sources);
        });
        break;
      case "dron":
        for (const i of e.insights.slice(0, 1)) {
          const text = `OBAC, Vigía: el dron ${e.label} ve ${clip(i.summary, 120)}`;
          addUtterance(ctx, {
            text,
            // Por radio solo lo grave; lo demás del dron queda en la mesa.
            radio: i.severity === "critical" || i.severity === "warning" ? text : null,
            kind: "alerta",
            priority: i.severity === "critical" ? "persona" : "riesgo",
            evidence: [e.label],
          });
        }
        break;
      case "dron_yolo": {
        const top = e.found.slice().sort((a, b) => (a.label === "persona" ? -1 : b.label === "persona" ? 1 : b.conf - a.conf))[0];
        if (!top) break;
        const what =
          top.label === "persona"
            ? `posible persona${top.pose === "tendido" ? " tendida" : ""}${top.count > 1 ? ` (${top.count})` : ""}`
            : `posible ${detectionText(top.label)}`;
        addUtterance(ctx, {
          text: `OBAC, Vigía: el dron ${e.label} ve ${what}, detección automática ${Math.round(top.conf * 100)} %.`,
          // Una posible persona va siempre por radio (lo asegura radioLine); otros objetos, en la mesa.
          radio: top.label === "persona" ? undefined : null,
          kind: "alerta",
          priority: top.label === "persona" ? "persona" : "riesgo",
          evidence: [e.label],
          confidence: top.conf >= 0.75 ? "high" : top.conf >= 0.5 ? "medium" : "low",
        });
        break;
      }
      case "pendiente_vencido":
        for (const p of e.pending.slice(0, 2)) {
          const minutes = Math.max(1, Math.round((ctx.nowMs - Date.parse(p.at)) / 60_000));
          const what = p.text.replace(/^.*?pidió\s+/, "");
          addUtterance(ctx, {
            text: `OBAC, Vigía: ${p.who} pidió ${clip(what, 60)} hace ${minutes} minutos y nadie confirmó.`,
            radio: null,
            kind: "pendiente",
            priority: "recursos",
            evidence: [p.source],
          });
          ctx.ops.push({ op: "pending_reminded", id: p.id, at: new Date(ctx.nowMs).toISOString() });
        }
        break;
      case "reloj": {
        const latest = new Map<string, string>();
        for (const r of e.radio) latest.set(r.speaker || "Sin identificar", r.text);
        const parts = [...latest.entries()].slice(-3).map(([who, text]) => `${who}: ${clip(text, 70)}`);
        if (parts.length > 0) addUtterance(ctx, { text: `Resumen: ${parts.join(". ")}.`, kind: "resumen", priority: "resto", evidence: e.radio.slice(-3).map((r) => `C${r.seq}`) });
        break;
      }
    }
  }
}

/** Parte armado sin LLM (cuando el OBAC lo pide en modo plantilla). */
export function fallbackParte(ctx: TurnContext): void {
  const sit = ctx.world.situation;
  const parte = buildParte(ctx, `${sit?.headline ?? ctx.world.incident.title}. Vigía registró ${ctx.state.log.length} entradas en la bitácora hasta las ${formatClock(new Date(ctx.nowMs))}.`);
  ctx.ops.push({ op: "parte", parte });
}
