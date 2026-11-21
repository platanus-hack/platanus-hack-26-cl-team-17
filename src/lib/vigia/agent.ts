/**
 * Una vuelta del agente Vigía sobre una emergencia (solo servidor).
 *
 * 1. Mira lo que tiene a la vista (world) y lo compara con su memoria (observe).
 * 2. Lo que no necesita modelo se resuelve en código: pendientes de radio, silencio,
 *    preguntas que llegan por Zello, cursores, estado.
 * 3. Si algo amerita, piensa con Claude y sus herramientas (modelo rápido); si no hay
 *    llave o Claude falla, responde con plantillas.
 * 4. Guarda todo de una vez y avisa los mensajes nuevos a la salida.
 */
import Anthropic, { RateLimitError } from "@anthropic-ai/sdk";
import type {
  BetaContentBlock,
  BetaMessage,
  BetaMessageParam,
  BetaToolResultBlockParam,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { aiEngineKind, config } from "@/lib/config";
import { formatClock } from "@/lib/format";
import { newId } from "@/lib/ids";
import { FALLBACK_BETA } from "@/lib/ai/client";
import { noteAgentTurn, recordClaudeCall, recordServerError } from "@/lib/server/diagnostics";
import { detectionText } from "@/lib/vision/types";
import { answerQuestion, fallbackTurn } from "./fallback";
import { applyOps, type VigiaOp } from "./memory";
import { DEFAULT_OBSERVE, needsTurn, observe, type VigiaEvent } from "./observe";
import { emitUtterances } from "./outbox";
import { VIGIA_SYSTEM_PROMPT } from "./prompt";
import { detectSilenceCommand } from "./rules";
import { getVigiaState, updateVigiaState } from "./state-store";
import {
  addAction,
  addUtterance,
  escucharRadio,
  pendientesText,
  runTool,
  statusLine,
  verHallazgos,
  VIGIA_TOOLS,
  type TurnContext,
} from "./tools";
import type { VigiaState, VigiaStatus, VigiaUtterance } from "./types";
import { loadWorld, type World } from "./world";

const MAX_STEPS = 6;
/**
 * Tope por solicitud y un solo reintento: el agente responde en ~5 a 8 s; si Claude se cuelga,
 * cae a plantillas en ~30 s en vez de ~2 min de radio en silencio.
 */
export const REQUEST_TIMEOUT_MS = 15_000;
export const REQUEST_MAX_RETRIES = 1;
/** Tras una vuelta fallida con Claude, plantillas directo por este tiempo (sin volver a esperar). */
export const CLAUDE_COOLDOWN_MS = 120_000;

type GlobalWithAgentClient = typeof globalThis & { __vigiaAgentAnthropic?: Anthropic; __vigiaClaudeDownUntil?: number };

function client(): Anthropic {
  const g = globalThis as GlobalWithAgentClient;
  g.__vigiaAgentAnthropic ??= new Anthropic({ timeout: REQUEST_TIMEOUT_MS, maxRetries: REQUEST_MAX_RETRIES });
  return g.__vigiaAgentAnthropic;
}

/** Hasta cuándo el agente no prueba Claude en este proceso (0 = lo prueba). */
export function claudeDownUntil(): number {
  return (globalThis as GlobalWithAgentClient).__vigiaClaudeDownUntil ?? 0;
}

/** Claude falló: plantillas directo durante CLAUDE_COOLDOWN_MS. `null` lo rehabilita. */
export function markClaudeDown(nowMs: number | null): void {
  (globalThis as GlobalWithAgentClient).__vigiaClaudeDownUntil = nowMs === null ? 0 : nowMs + CLAUDE_COOLDOWN_MS;
}

/** Motor del agente para la mesa: plantillas sin llave o si la mesa pidió "Vigía sin IA". */
export function agentEngine(state?: Pick<VigiaState, "ai_off">): "claude" | "plantilla" {
  if (aiEngineKind() !== "claude" || state?.ai_off) return "plantilla";
  return "claude";
}

/** Motor de esta vuelta: además, plantillas mientras dure la pausa tras un fallo de Claude. */
export function turnEngine(state: Pick<VigiaState, "ai_off">, nowMs: number): "claude" | "plantilla" {
  return agentEngine(state) === "claude" && claudeDownUntil() <= nowMs ? "claude" : "plantilla";
}

/** Modelo, esfuerzo y modo rápido efectivos del agente (el modo rápido solo existe en Opus 5.5). */
export function agentModelSettings(): { model: string; effort: typeof config.vigiaAgentEffort; fast: boolean } {
  const model = config.vigiaAgentModel;
  return { model, effort: config.vigiaAgentEffort, fast: config.vigiaAgentFast && model.startsWith("claude-opus-5-5") };
}

function observeOptions() {
  const remind = Number(process.env.VIGIA_PENDING_REMIND_S);
  return {
    ...DEFAULT_OBSERVE,
    remindMs: Number.isFinite(remind) && remind >= 30 ? remind * 1000 : DEFAULT_OBSERVE.remindMs,
  };
}

/* ───────────────────────────── mensaje de la vuelta ───────────────────────────── */

function clip(text: string, max: number): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function describeEvent(e: VigiaEvent): string {
  switch (e.type) {
    case "inicio":
      return "- INICIO: es tu primera vuelta en esta emergencia. Preséntate al OBAC: qué estás mirando, qué radios escuchas y qué lados no ves. Si falta un lado y hay videos, pide video de ese lado.";
    case "pregunta":
      return `- PREGUNTA DEL OBAC (${e.question.from === "zello" ? `por radio, C${e.question.comm_seq}` : "en la mesa de mando"}, ${formatClock(e.question.at)}): «${e.question.text}» → respóndela con hablarle_al_obac tipo "respuesta".`;
    case "radio":
      return `- RADIO NUEVA:\n${e.lines.map((l) => `  C${l.seq} ${formatClock(l.at)} ${l.speaker || "Sin identificar"}${l.channel ? ` [${l.channel}]` : ""}: ${l.expanded}`).join("\n")}`;
    case "video_nuevo":
      return `- VIDEOS RECIÉN LLEGADOS (aún sin analizar): ${e.media.map((m) => `${m.label}${m.side ? ` (lado ${m.side})` : ""}`).join(", ")}.`;
    case "video_analizado":
      return `- VIDEOS ANALIZADOS:\n${e.media
        .map((m) => {
          const a = m.analysis;
          if (!a) return `  ${m.label}: sin análisis`;
          const people = a.people
            .filter((p) => p.status !== "bystander" && p.status !== "responder")
            .map((p) => `${p.status} ×${p.count} en ${p.location || "?"} (piso ${p.floor || "?"}, confianza ${p.confidence})`);
          const hazards = a.hazards.map((h) => `${h.kind}: ${h.description} (${h.severity})`);
          return `  ${m.label} · lado ${m.side ?? "sin ubicación"} · confianza ${a.confidence}: ${clip(a.summary, 220)}${people.length > 0 ? ` | personas: ${people.join("; ")}` : " | personas: no se ven"}${hazards.length > 0 ? ` | riesgos: ${hazards.join("; ")}` : ""}`;
        })
        .join("\n")}`;
    case "situacion": {
      const parts: string[] = [];
      if (e.trapped) parts.push(`personas atrapadas pasó de ${e.trapped.from ?? "sin dato"} a ${e.trapped.to}`);
      for (const i of e.insights) parts.push(`hallazgo ${i.priority}: ${i.title} — ${clip(i.detail, 160)} [${i.evidence.map((x) => x.ref).join(", ")}] (confianza ${i.confidence})`);
      for (const c of e.contradictions) parts.push(`contradicción: ${c.description} [${c.sources.join(", ")}]`);
      return `- INFORME DE SITUACIÓN ACTUALIZADO: ${parts.join(" · ")}`;
    }
    case "contradiccion":
      return `- NO CALZA RADIO ↔ IMAGEN (detectado por reglas): ${e.contradictions.map((c) => `${c.description} [${c.sources.join(", ")}]`).join(" · ")} → avísalo al OBAC con hablarle_al_obac tipo "contradiccion", nombrando las dos fuentes (la imagen y la transmisión)${e.contradictions.some((c) => c.people) ? "; si hay una posible persona, prioridad persona" : ""}. No decidas cuál tiene razón: la confirmación la pide el OBAC.`;
    case "dron":
      return `- DRON ${e.label}: ${e.insights.map((i) => `${formatClock(i.at)} (${i.severity}) ${i.summary}${i.observations.length > 0 ? ` — ${i.observations.slice(0, 3).join("; ")}` : ""}`).join(" | ")}`;
    case "dron_yolo":
      return `- DRON ${e.label}, DETECCIÓN AUTOMÁTICA (YOLO, puede fallar) en el video en vivo a las ${formatClock(e.at, { seconds: true })}: ${e.found
        .map((f) => `${detectionText(f.label)}${f.count > 1 ? ` ×${f.count}` : ""} ${Math.round(f.conf * 100)} %${f.pose === "tendido" ? " (tendida)" : ""}`)
        .join(", ")}. Avisa al OBAC si importa (evidencia ${e.label}), con la confianza; una detección sola es «posible».`;
    case "pendiente_vencido":
      return `- PENDIENTES SIN CONFIRMAR: ${e.pending.map((p) => `${p.id}: ${p.text} a las ${formatClock(p.at)} (${p.source})`).join("; ")}. Recuérdaselo al OBAC (tipo "pendiente").`;
    case "reloj":
      return `- RELOJ: resume la radio de los últimos minutos si aporta algo (tipo "resumen"):\n${e.radio.map((l) => `  C${l.seq} ${l.speaker}: ${l.expanded}`).join("\n")}`;
  }
}

/**
 * Con una pregunta del OBAC, lo que hace falta para responder va en el mismo mensaje: así
 * contesta en la primera llamada, sin ir a buscar con otras herramientas (cada vuelta extra
 * son segundos de radio en silencio).
 */
function answerContext(world: World, state: VigiaState, nowMs: number): string {
  const clipTo = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
  return [
    "CONTEXTO PARA RESPONDER (ya lo tienes; no necesitas otras herramientas antes de responder):",
    clipTo(verHallazgos(world), 2200),
    "Radio reciente:",
    clipTo(escucharRadio(world, 8), 1200),
    `Pendientes: ${clipTo(pendientesText(state, nowMs), 400)}`,
  ].join("\n");
}

function turnMessage(world: World, state: VigiaState, events: VigiaEvent[], nowMs: number): string {
  const s = statusLine(world);
  const lastSpoken = state.last_spoken_at ? Math.round((nowMs - Date.parse(state.last_spoken_at)) / 1000) : null;
  const recent = state.utterances.slice(-6).map((u) => `  ${formatClock(u.at)} [${u.kind}${u.speak ? ", hablado" : ", pantalla"}] ${u.text}`);
  const open = state.pending.filter((p) => p.status === "abierto");
  const requests = state.video_requests.filter((r) => Date.parse(r.expires_at) > nowMs);
  return [
    `Hora: ${formatClock(new Date(nowMs), { seconds: true })}. Emergencia ${world.incident.code}: ${world.incident.title} (${world.incident.type}) en ${world.incident.address || "dirección sin confirmar"}; estado ${world.incident.status}.`,
    `Tu estado: ${s.line}. Silencio: ${state.silenced ? "SÍ (solo pantalla salvo posible persona)" : "no"}. Último mensaje hablado: ${lastSpoken === null ? "nunca" : `hace ${lastSpoken} s`}.`,
    recent.length > 0 ? `Lo último que dijiste:\n${recent.join("\n")}` : "Todavía no has dicho nada.",
    open.length > 0 ? `Pendientes abiertos: ${open.map((p) => `${p.id} ${p.text} (${p.source})`).join("; ")}` : "Sin pendientes abiertos.",
    requests.length > 0 ? `Pedidos de video activos: ${requests.map((r) => r.zone).join(", ")}` : "",
    "",
    "EVENTOS DE ESTA VUELTA:",
    ...events.map(describeEvent),
    ...(events.some((e) => e.type === "pregunta")
      ? [
          "",
          "PRIMERO responde la pregunta del OBAC con hablarle_al_obac (tipo \"respuesta\") en esta misma llamada: directo, con lo que sabes y lo que no. Lo demás, después.",
          answerContext(world, state, nowMs),
        ]
      : []),
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/* ───────────────────────────── Claude con herramientas ───────────────────────────── */

type AgentIncident = { id: string; code: string };

/** Una solicitud HTTP a la API; duración, modelo y tokens quedan en el registro de la vista técnica. */
async function timedCreate(params: MessageCreateParamsNonStreaming, incident: AgentIncident): Promise<BetaMessage> {
  const call = {
    task: "agente",
    model: params.model,
    fast: params.speed === "fast",
    startedAt: Date.now(),
    incidentId: incident.id,
    incidentCode: incident.code,
  };
  try {
    // Opciones por solicitud: valen aunque el cliente compartido se haya creado con otras.
    const message = await client().beta.messages.create(params, { timeout: REQUEST_TIMEOUT_MS, maxRetries: REQUEST_MAX_RETRIES });
    recordClaudeCall(call, { message });
    return message;
  } catch (error) {
    recordClaudeCall(call, { error });
    throw error;
  }
}

async function send(params: MessageCreateParamsNonStreaming, incident: AgentIncident): Promise<BetaMessage> {
  try {
    return await timedCreate(params, incident);
  } catch (error) {
    if (params.speed === "fast" && error instanceof RateLimitError) {
      const standard = { ...params };
      delete standard.speed;
      return timedCreate(standard, incident);
    }
    throw error;
  }
}

async function claudeTurn(ctx: TurnContext, events: VigiaEvent[]): Promise<void> {
  const settings = agentModelSettings();
  const messages: BetaMessageParam[] = [{ role: "user", content: turnMessage(ctx.world, ctx.state, events, ctx.nowMs) }];
  const started = Date.now();
  let calls = 0;
  for (let step = 0; step < MAX_STEPS; step++) {
    const params: MessageCreateParamsNonStreaming = {
      model: settings.model,
      max_tokens: 4000,
      system: [{ type: "text", text: VIGIA_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools: VIGIA_TOOLS,
      messages,
      output_config: { effort: settings.effort },
      betas: [FALLBACK_BETA],
      fallbacks: "default",
      ...(settings.fast ? { speed: "fast" as const } : {}),
    };
    const res = await send(params, ctx.world.incident);
    calls += 1;
    if (res.stop_reason === "refusal") throw new Error("El modelo declinó la vuelta.");
    const toolUses = res.content.filter((b): b is Extract<BetaContentBlock, { type: "tool_use" }> => b.type === "tool_use");
    // El contenido completo (con los bloques de pensamiento) vuelve tal cual.
    messages.push({ role: "assistant", content: res.content });
    if (toolUses.length === 0 || res.stop_reason !== "tool_use") break;
    const results: BetaToolResultBlockParam[] = toolUses.map((t) => {
      const out = runTool(ctx, t.name, t.input);
      return { type: "tool_result", tool_use_id: t.id, content: out.content, is_error: out.isError || undefined };
    });
    messages.push({ role: "user", content: results });
  }
  console.info("[vigia] vuelta del agente", {
    incident: ctx.world.incident.code,
    events: events.map((e) => e.type),
    calls,
    ms: Date.now() - started,
    ops: ctx.ops.filter((o) => o.op === "utter").length,
  });
}

/* ───────────────────────────── la vuelta ───────────────────────────── */

export interface TurnResult {
  ran: boolean;
  events: string[];
  added: VigiaUtterance[];
}

function statusOf(world: World, thinking: boolean): VigiaStatus {
  const s = statusLine(world);
  return { ...s, blind: world.blind, coverage: world.coverage, thinking };
}

/** Marca "pensando" para la mesa de mando mientras el modelo trabaja. */
async function setThinking(incidentId: string, world: World, thinking: boolean): Promise<void> {
  await updateVigiaState(incidentId, (s) => {
    s.status = statusOf(world, thinking);
  });
}

/**
 * Una vuelta del agente. `force` lo hace pensar aunque no haya eventos (p. ej. el OBAC
 * escribió). Nunca lanza: los errores quedan en la bitácora y en last_error.
 */
export async function runVigiaTurn(incidentId: string): Promise<TurnResult> {
  try {
    const world = await loadWorld(incidentId);
    if (!world || world.incident.status === "closed") return { ran: false, events: [], added: [] };
    const state = await getVigiaState(incidentId);
    const nowMs = Date.now();
    const obs = observe(world, state, nowMs, observeOptions());
    const engine = turnEngine(state, nowMs);

    const ctx: TurnContext = { world, state: structuredClone(state), ops: [], nowMs, engine, answering: null };

    // Lo que se resuelve en código.
    for (const q of obs.newQuestions) ctx.ops.push({ op: "question_add", q });
    if (obs.silence === "silence" && !state.silenced) {
      ctx.ops.push({ op: "silence", on: true });
      ctx.state.silenced = true;
      addAction(ctx, "silencio", "El OBAC pidió silencio: solo pantalla, salvo posible persona");
      addUtterance(ctx, { text: "Vigía: entendido, solo pantalla.", kind: "respuesta", priority: "resto", speak: false });
    } else if (obs.silence === "resume" && state.silenced) {
      ctx.ops.push({ op: "silence", on: false });
      ctx.state.silenced = false;
      addAction(ctx, "silencio", "El OBAC levantó el silencio");
      addUtterance(ctx, { text: "OBAC, Vigía: vuelvo a hablar por radio.", kind: "respuesta", priority: "resto" });
    }
    for (const p of obs.newPending) {
      if (ctx.state.pending.some((x) => x.status === "abierto" && x.clave !== null && x.clave === p.clave)) continue;
      ctx.ops.push({ op: "pending_add", p });
      ctx.state.pending.push(p);
      addAction(ctx, "pendiente", `Anoté pendiente: ${p.text}`);
    }
    for (const r of obs.resolved) {
      const p = ctx.state.pending.find((x) => x.id === r.id);
      ctx.ops.push({ op: "pending_resolve", id: r.id, by: r.by, at: new Date(nowMs).toISOString() });
      ctx.state.pending = ctx.state.pending.map((x) => (x.id === r.id ? { ...x, status: "resuelto" as const } : x));
      if (p) addAction(ctx, "pendiente", `Se confirmó: ${p.text} (${r.by})`);
    }

    const events = obs.events;
    const think = needsTurn(events);
    const firstQuestion = events.find((e) => e.type === "pregunta");
    ctx.answering = firstQuestion?.type === "pregunta" ? firstQuestion.question.id : null;
    if (think && engine === "claude") await setThinking(incidentId, world, true);

    if (think) {
      if (engine === "claude") {
        const fallbackFrom = ctx.ops.length;
        try {
          await claudeTurn(ctx, events);
          markClaudeDown(null);
        } catch (error) {
          // Las vueltas siguientes no vuelven a esperar a Claude por un rato.
          markClaudeDown(Date.now());
          const message = error instanceof Error ? error.message : String(error);
          console.warn("[vigia] la vuelta con Claude falló; respondo con plantillas", { incident: world.incident.code, error: message });
          recordServerError("agente", error, {
            incidentId: world.incident.id,
            incidentCode: world.incident.code,
            context: "Claude falló en la vuelta; respondí con plantillas",
          });
          // Se descarta lo que dejó a medias el modelo y se responde con plantillas.
          ctx.ops.length = fallbackFrom;
          ctx.engine = "plantilla";
          fallbackTurn(ctx, events);
          ctx.ops.push({
            op: "error",
            message: `Claude falló (${message}); respondo con plantillas por ${Math.round(CLAUDE_COOLDOWN_MS / 60_000)} min y después vuelvo a probar.`,
          });
        }
      } else {
        fallbackTurn(ctx, events);
      }
    } else {
      fallbackTurn(ctx, events.filter((e) => e.type === "video_nuevo"));
    }

    // Toda pregunta queda respondida: si el modelo no la contestó, responde la plantilla.
    for (const e of events) {
      if (e.type !== "pregunta") continue;
      const replied = ctx.ops.some((o) => o.op === "utter" && o.u.kind === "respuesta");
      if (!replied) {
        ctx.answering = e.question.id;
        const prevEngine = ctx.engine;
        ctx.engine = "plantilla";
        answerQuestion(ctx, e.question);
        ctx.engine = prevEngine;
      }
      ctx.ops.push({ op: "answered", id: e.question.id });
    }
    for (const e of events) {
      if (e.type === "pendiente_vencido") {
        for (const p of e.pending) {
          if (!ctx.ops.some((o) => o.op === "pending_reminded" && o.id === p.id)) {
            ctx.ops.push({ op: "pending_reminded", id: p.id, at: new Date(nowMs).toISOString() });
          }
        }
      }
    }
    if (events.some((e) => e.type === "inicio")) ctx.ops.push({ op: "introduced" });
    ctx.ops.push({ op: "cursors", cursors: obs.cursors });
    ctx.ops.push({ op: "status", status: statusOf(world, false) });
    if (think && ctx.engine === "claude") ctx.ops.push({ op: "error", message: null });

    let added: VigiaUtterance[] = [];
    const meaningful = ctx.ops.some((o) => o.op !== "cursors" && o.op !== "status") || think;
    const cursorsChanged = JSON.stringify(obs.cursors) !== JSON.stringify(state.cursors);
    const statusChanged = JSON.stringify(statusOf(world, false)) !== JSON.stringify({ ...state.status, thinking: false });
    if (meaningful || cursorsChanged || statusChanged || state.status.thinking) {
      await updateVigiaState(incidentId, (fresh) => {
        added = applyOps(fresh, ctx.ops as VigiaOp[], Date.now());
      });
      emitUtterances(added);
    }
    noteAgentTurn(incidentId, {
      at: new Date(nowMs).toISOString(),
      ms: Date.now() - nowMs,
      thought: think,
      engine: think ? ctx.engine : null,
      events: events.map((e) => e.type),
    });
    return { ran: think, events: events.map((e) => e.type), added };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[vigia] vuelta fallida", { incidentId, error: message });
    recordServerError("agente", error, { incidentId, context: "Vuelta del agente fallida" });
    await updateVigiaState(incidentId, (s) => {
      s.last_error = message;
      s.status = { ...s.status, thinking: false };
    }).catch(() => undefined);
    return { ran: false, events: [], added: [] };
  }
}

/**
 * Pregunta o respuesta del OBAC escrita en la mesa de mando. La próxima vuelta la contesta.
 * "Vigía, silencio" / "ya puedes hablar" se aplican aquí mismo, en código.
 */
export async function addObacMessage(incidentId: string, text: string, replyTo: string | null): Promise<string> {
  const id = newId();
  const cmd = detectSilenceCommand(text);
  const now = new Date().toISOString();
  await updateVigiaState(incidentId, (s) => {
    s.questions = [
      ...s.questions,
      { id, at: now, text, from: "mesa" as const, comm_seq: null, reply_to: replyTo, answered: cmd !== null },
    ].slice(-60);
    if (cmd) {
      s.silenced = cmd === "silence";
      s.actions = [
        ...s.actions,
        {
          id: newId(),
          at: now,
          kind: "silencio" as const,
          text: cmd === "silence" ? "El OBAC pidió silencio: solo pantalla, salvo posible persona" : "El OBAC levantó el silencio",
        },
      ].slice(-60);
    }
  });
  return id;
}
