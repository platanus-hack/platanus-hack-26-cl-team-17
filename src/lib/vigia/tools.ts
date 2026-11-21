/**
 * Las 8 herramientas de Vigía. Cada una lee lo que ya existe (videos analizados, radio,
 * drones, informe) o anota una operación en la memoria; las reglas duras se aplican aquí,
 * en el código, antes de que nada se diga o se publique.
 */
import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import type { Confidence } from "@/lib/domain";
import { formatClock } from "@/lib/format";
import { newId } from "@/lib/ids";
import { personStatusLabel, trappedStatusLabel } from "@/lib/labels";
import { detectionText } from "@/lib/vision/types";
import { countPublicViewers } from "./audience";
import { sideInText, sidesText } from "./coverage";
import { recentlySaid, type VigiaOp } from "./memory";
import { sanitizeForObac, sanitizeVideoRequest, speechAllowed, VIGIA_PRIORITIES, type VigiaPriority } from "./rules";
import type { VigiaKind, VigiaPending, VigiaState } from "./types";
import { activeRadios, analyzedMedia, personSightings, type World } from "./world";

/** Todo lo que una herramienta puede leer y anotar durante una vuelta. */
export interface TurnContext {
  world: World;
  /** Copia de trabajo de la memoria (se actualiza en la vuelta para que las herramientas se vean entre sí). */
  state: VigiaState;
  ops: VigiaOp[];
  nowMs: number;
  engine: "claude" | "plantilla";
  /** Pregunta del OBAC que se está respondiendo en esta vuelta, si hay. */
  answering: string | null;
}

export interface ToolOutcome {
  content: string;
  isError?: boolean;
}

const VIDEO_REQUEST_MS = 3 * 60_000;

/* ───────────────────────────── utilidades ───────────────────────────── */

const CONF_ES: Record<string, Confidence> = { baja: "low", media: "medium", alta: "high" };
const CONF_TEXT: Record<string, string> = { low: "baja", medium: "media", high: "alta" };

function evidenceRefs(list: readonly string[] | undefined): string[] {
  return [...new Set((list ?? []).map((s) => s.trim().toUpperCase()).filter((s) => /^[MCD]\d{1,4}$/.test(s)))].slice(0, 12);
}

function clock(iso: string): string {
  return formatClock(iso);
}

function push(ctx: TurnContext, op: VigiaOp): void {
  ctx.ops.push(op);
  // La copia de trabajo refleja lo que importa para las siguientes herramientas de la vuelta.
  switch (op.op) {
    case "utter": {
      // Mismo cálculo que applyOps, para que la vuelta sepa si ya habló (límite de 20 s).
      const lastSpoken = ctx.state.last_spoken_at ? Date.parse(ctx.state.last_spoken_at) : null;
      const speak =
        op.u.speak !== false &&
        op.u.kind !== "propuesta" &&
        speechAllowed({ priority: op.u.priority, lastSpokenAt: lastSpoken, now: ctx.nowMs, silenced: ctx.state.silenced });
      ctx.state.seq += 1;
      ctx.state.utterances.push({ ...op.u, seq: ctx.state.seq, speak });
      if (speak) ctx.state.last_spoken_at = new Date(ctx.nowMs).toISOString();
      break;
    }
    case "pending_add":
      ctx.state.pending.push(op.p);
      break;
    case "pending_resolve":
      ctx.state.pending = ctx.state.pending.map((p) => (p.id === op.id ? { ...p, status: "resuelto", resolved_by: op.by, resolved_at: op.at } : p));
      break;
    case "video_request":
      ctx.state.video_requests.push(op.r);
      break;
    case "log":
      ctx.state.log.push(op.l);
      break;
    default:
      break;
  }
}

/** Agrega un mensaje para el OBAC ya pasado por las reglas. Lo usan las herramientas y las plantillas. */
export function addUtterance(
  ctx: TurnContext,
  u: {
    text: string;
    kind: VigiaKind;
    priority: VigiaPriority;
    evidence?: string[];
    confidence?: Confidence | null;
    claves?: string | null;
    speak?: boolean;
    rules?: string[];
    replyTo?: string | null;
  },
): void {
  const at = new Date(ctx.nowMs).toISOString();
  push(ctx, {
    op: "utter",
    u: {
      id: newId(),
      incident_id: ctx.world.incident.id,
      at,
      text: u.text,
      priority: u.priority,
      kind: u.kind,
      evidence: u.evidence ?? [],
      confidence: u.confidence ?? null,
      engine: ctx.engine,
      rules: u.rules ?? [],
      claves: u.claves ?? null,
      reply_to: u.replyTo ?? null,
      speak: u.speak,
    },
  });
}

export function addAction(ctx: TurnContext, kind: Parameters<typeof actionOp>[1], text: string): void {
  push(ctx, actionOp(ctx, kind, text));
}

function actionOp(ctx: TurnContext, kind: "pedido_video" | "bitacora" | "pendiente" | "escucha" | "propuesta" | "parte" | "silencio", text: string): VigiaOp {
  return { op: "action", a: { id: newId(), at: new Date(ctx.nowMs).toISOString(), kind, text } };
}

export function addLog(ctx: TurnContext, what: string, why: string, evidence: string[] = []): void {
  push(ctx, { op: "log", l: { id: newId(), at: new Date(ctx.nowMs).toISOString(), what, why, evidence } });
}

/* ───────────────────────────── lectura ───────────────────────────── */

/** Cobertura en una línea: "lado A: M1, M3 · lado B: — · …". */
export function coverageText(world: World): string {
  if (world.coverage.every((c) => c.media.length === 0)) return "Ningún video tiene ubicación todavía: no sé qué lados cubren.";
  return world.coverage.map((c) => `lado ${c.side}: ${c.media.length > 0 ? c.media.join(", ") : "sin video"}`).join(" · ");
}

export function verHallazgos(world: World, lado?: string | null): string {
  const lines: string[] = [];
  const analyzed = analyzedMedia(world);
  const pendingMedia = world.media.filter((m) => m.status !== "analyzed" && m.status !== "failed");
  lines.push(`Videos: ${analyzed.length} analizados${pendingMedia.length > 0 ? `, ${pendingMedia.length} en análisis` : ""} (total ${world.media.length}).`);
  lines.push(`Cobertura por lado (${world.scheme === "abcd" ? "A = frente" : "por punto cardinal"}): ${coverageText(world)}`);
  if (world.blind.length > 0) lines.push(`Sin video: ${sidesText(world.blind)}.`);

  const side = lado ? sideInText(`lado ${lado}`, world.scheme) ?? lado : null;
  const media = side ? analyzed.filter((m) => m.side === side) : analyzed;
  if (side) lines.push(`Filtrado al lado ${side}: ${media.length} de ${analyzed.length} videos lo cubren.`);

  for (const m of media.slice(-12)) {
    const a = m.analysis;
    if (!a) continue;
    const people = a.people
      .filter((p) => p.status !== "bystander" && p.status !== "responder")
      .map((p) => `${personStatusLabel[p.status]} (${p.count}) en ${p.location || "ubicación no clara"}, confianza ${CONF_TEXT[p.confidence]}`);
    const hazards = a.hazards.map((h) => `${h.description} (${h.severity})`);
    const yolo = (m.detections ?? [])
      .slice(0, 6)
      .map((d) => `${detectionText(d.label)}${d.max_count > 1 ? ` ×${d.max_count}` : ""} ${Math.round(d.max_conf * 100)} % (en ${d.frames} cuadros)`);
    lines.push(
      [
        `${m.label} · ${m.source === "drone" ? "dron" : "video"} · lado ${m.side ?? "sin ubicación"} · confianza ${CONF_TEXT[a.confidence]}: ${a.summary}`,
        people.length > 0 ? `  Personas: ${people.join("; ")}` : "  Personas: no se ven",
        hazards.length > 0 ? `  Riesgos: ${hazards.join("; ")}` : "",
        yolo.length > 0 ? `  YOLO (detección automática): ${yolo.join(", ")}` : "",
        a.uncertainties.length > 0 ? `  No se puede saber: ${a.uncertainties.slice(0, 3).join("; ")}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  const sit = world.situation;
  if (sit) {
    lines.push(
      `Informe de situación (${world.situation_at ? clock(world.situation_at) : "sin hora"}): ${sit.headline}. Personas atrapadas: ${trappedStatusLabel[sit.trapped.status]} — ${sit.trapped.basis}`,
    );
    for (const h of sit.hazards.slice(0, 5)) lines.push(`  Riesgo: ${h.description} (${h.severity})`);
    for (const c of sit.contradictions.slice(0, 3)) lines.push(`  Contradicción: ${c.description} [${c.sources.join(", ")}]`);
    if (sit.unknowns.length > 0) lines.push(`  No se sabe: ${sit.unknowns.slice(0, 4).join("; ")}`);
  }

  for (const d of world.drones.filter((x) => x.active || x.insights.length > 0)) {
    const last = d.insights[0];
    lines.push(`Dron ${d.label}${d.active ? " (en vuelo)" : ""}: ${last ? `${clock(last.at)} ${last.summary}` : "sin observaciones todavía"}`);
    if (d.live && d.live.result.detections.length > 0) {
      const counts = Object.entries(d.live.result.counts)
        .map(([label, n]) => `${detectionText(label)}${n > 1 ? ` ×${n}` : ""}`)
        .join(", ");
      lines.push(`  YOLO en vivo (${clock(d.live.at)}): ${counts}`);
    }
  }
  return lines.join("\n");
}

export function escucharRadio(world: World, ultimas = 15): string {
  const radio = world.radio.slice(-Math.max(1, Math.min(40, ultimas)));
  if (radio.length === 0) return "No hay transmisiones de radio todavía.";
  const lines = radio.map(
    (r) => `C${r.seq} ${clock(r.at)} ${r.obac ? "OBAC→Vigía" : r.speaker || "Sin identificar"}${r.channel ? ` [${r.channel}]` : ""}: ${r.expanded}`,
  );
  if (world.comms_summary) lines.push(`Resumen del análisis de radio: ${world.comms_summary}`);
  return lines.join("\n");
}

export function pendientesText(state: VigiaState, nowMs: number): string {
  const open = state.pending.filter((p) => p.status === "abierto");
  if (open.length === 0) return "No hay pendientes abiertos.";
  return open
    .map((p) => `${p.id} · ${p.text} (${p.source}, hace ${Math.max(0, Math.round((nowMs - Date.parse(p.at)) / 60_000))} min)`)
    .join("\n");
}

/** Línea de estado: "Escuchando 3 radios · mirando 5 videos · sin ver el lado C". */
export function statusLine(world: World): { line: string; radios: number; videos: number; drones: number } {
  const radios = activeRadios(world);
  const videos = world.media.filter((m) => m.status !== "failed").length;
  const drones = world.drones.filter((d) => d.active).length;
  const parts = [`Escuchando ${radios} ${radios === 1 ? "radio" : "radios"}`, `mirando ${videos} ${videos === 1 ? "video" : "videos"}`];
  if (drones > 0) parts.push(`${drones} ${drones === 1 ? "dron" : "drones"} en vuelo`);
  if (world.blind.length > 0) parts.push(`sin ver ${sidesText(world.blind)}`);
  return { line: parts.join(" · "), radios, videos, drones };
}

/* ───────────────────────────── definiciones ───────────────────────────── */

const KINDS_TO_OBAC = ["presentacion", "alerta", "resumen", "respuesta", "pendiente", "contradiccion"] as const;

const VerHallazgosInput = z.object({ lado: z.string().max(20).nullish() });
const EscucharRadioInput = z.object({ ultimas: z.number().int().min(1).max(40).nullish() });
const HablarInput = z.object({
  texto: z.string().trim().min(1).max(400),
  tipo: z.enum(KINDS_TO_OBAC),
  prioridad: z.enum(VIGIA_PRIORITIES as unknown as [VigiaPriority, ...VigiaPriority[]]),
  evidencia: z.array(z.string()).max(12).nullish(),
  confianza: z.enum(["baja", "media", "alta"]).nullish(),
});
const ProponerInput = z.object({
  mensaje_claves: z.string().trim().min(1).max(300),
  explicacion: z.string().trim().min(1).max(300),
  evidencia: z.array(z.string()).max(12).nullish(),
});
const PedirVideoInput = z.object({
  zona: z.string().trim().min(2).max(80),
  desde: z.string().trim().max(80).nullish(),
  motivo: z.string().trim().min(2).max(200),
});
const BitacoraInput = z.object({
  que: z.string().trim().min(1).max(300),
  por_que: z.string().trim().min(1).max(300),
  evidencia: z.array(z.string()).max(12).nullish(),
});
const PendientesInput = z.object({
  accion: z.enum(["listar", "agregar", "resolver"]),
  texto: z.string().trim().max(200).nullish(),
  quien: z.string().trim().max(40).nullish(),
  id: z.string().trim().max(64).nullish(),
  motivo: z.string().trim().max(200).nullish(),
});
const ParteInput = z.object({ resumen: z.string().trim().min(1).max(1500) });

export const VIGIA_TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "ver_hallazgos",
    description:
      "Hallazgos de los videos del público y del dron: por video, qué se ve, personas y riesgos con su confianza, cobertura por lado, el informe de situación y lo último del dron. Úsalo antes de afirmar algo sobre lo que se ve. Con `lado` filtra a los videos que cubren ese lado.",
    input_schema: {
      type: "object",
      properties: { lado: { type: "string", description: 'Lado a revisar: "A", "B", "C", "D" o "norte", "sur", "este", "oeste". Opcional.' } },
    },
  },
  {
    name: "escuchar_radio",
    description: "Últimas transmisiones de radio (incluido Zello) con las claves traducidas, con su etiqueta C<n>, hora y emisor.",
    input_schema: {
      type: "object",
      properties: { ultimas: { type: "integer", description: "Cuántas líneas (1 a 40, por defecto 15)." } },
    },
  },
  {
    name: "hablarle_al_obac",
    description:
      "Le dice algo al OBAC: queda como tarjeta en la mesa de mando y, si las reglas lo permiten, se transmite por voz en el canal de radio (lo escuchan también las compañías). Corto, con la fuente. El código bloquea órdenes y decisiones tácticas, cambia «no hay nadie» por «no lo veo» y limita la voz a un mensaje cada ~20 s salvo prioridad «persona». Devuelve si se habló o quedó solo en pantalla.",
    input_schema: {
      type: "object",
      properties: {
        texto: { type: "string", description: "Lo que dice Vigía, empezando por «OBAC, Vigía: …». Máximo ~35 palabras." },
        tipo: { type: "string", enum: [...KINDS_TO_OBAC] },
        prioridad: { type: "string", enum: [...VIGIA_PRIORITIES], description: "persona > riesgo > recursos > resto" },
        evidencia: { type: "array", items: { type: "string" }, description: 'Etiquetas: "M3", "C12", "D1".' },
        confianza: { type: "string", enum: ["baja", "media", "alta"] },
      },
      required: ["texto", "tipo", "prioridad"],
    },
  },
  {
    name: "proponer_mensaje",
    description:
      "Propone al OBAC un mensaje con claves para que ÉL lo retransmita a las unidades si quiere. Nunca se transmite solo: queda en la mesa de mando con el botón «Copiar mensaje con claves». Úsalo en vez de dar una orden.",
    input_schema: {
      type: "object",
      properties: {
        mensaje_claves: { type: "string", description: "El mensaje tal como se diría por radio, con claves (p. ej. «B-3, 7-2, informe ubicación y trabajo»)." },
        explicacion: { type: "string", description: "Por qué lo propones, en una frase, con la fuente." },
        evidencia: { type: "array", items: { type: "string" } },
      },
      required: ["mensaje_claves", "explicacion"],
    },
  },
  {
    name: "pedir_video",
    description:
      "Pide a quienes están grabando cerca (página de grabación abierta) un video de una zona que no ves. El código siempre agrega «Sin acercarse.» y rechaza pedir que entren o se acerquen. Avisa solo al OBAC a cuántas personas les llegó.",
    input_schema: {
      type: "object",
      properties: {
        zona: { type: "string", description: "Qué zona: «del lado C», «de la parte trasera», «del segundo piso por el lado B»." },
        desde: { type: "string", description: "Desde dónde grabar sin riesgo, p. ej. «desde la vereda» (por defecto)." },
        motivo: { type: "string", description: "Por qué lo pides (para la bitácora)." },
      },
      required: ["zona", "motivo"],
    },
  },
  {
    name: "anotar_bitacora",
    description: "Anota en la bitácora de la emergencia qué pasó o qué hiciste, por qué y con qué evidencia.",
    input_schema: {
      type: "object",
      properties: {
        que: { type: "string" },
        por_que: { type: "string" },
        evidencia: { type: "array", items: { type: "string" } },
      },
      required: ["que", "por_que"],
    },
  },
  {
    name: "pendientes",
    description:
      "Lista de lo pedido y no confirmado (los pedidos de recursos por radio se anotan solos). «listar», «agregar» (texto y quién) o «resolver» (id y motivo).",
    input_schema: {
      type: "object",
      properties: {
        accion: { type: "string", enum: ["listar", "agregar", "resolver"] },
        texto: { type: "string" },
        quien: { type: "string" },
        id: { type: "string" },
        motivo: { type: "string" },
      },
      required: ["accion"],
    },
  },
  {
    name: "armar_parte",
    description:
      "Arma el parte final de la emergencia para Viper con tu resumen; el código le agrega la línea de tiempo, los hallazgos con evidencia, la radio y los pendientes.",
    input_schema: {
      type: "object",
      properties: { resumen: { type: "string", description: "Qué pasó, en 3 a 6 frases, con horas y fuentes." } },
      required: ["resumen"],
    },
  },
];

/* ───────────────────────────── ejecución ───────────────────────────── */

function invalid(error: z.ZodError): ToolOutcome {
  return {
    isError: true,
    content: `Entrada inválida: ${error.issues.map((i) => `${i.path.join(".") || "entrada"}: ${i.message}`).join("; ")}`,
  };
}

export function runTool(ctx: TurnContext, name: string, input: unknown): ToolOutcome {
  switch (name) {
    case "ver_hallazgos": {
      const p = VerHallazgosInput.safeParse(input ?? {});
      if (!p.success) return invalid(p.error);
      return { content: verHallazgos(ctx.world, p.data.lado ?? null) };
    }
    case "escuchar_radio": {
      const p = EscucharRadioInput.safeParse(input ?? {});
      if (!p.success) return invalid(p.error);
      return { content: escucharRadio(ctx.world, p.data.ultimas ?? 15) };
    }
    case "hablarle_al_obac": {
      const p = HablarInput.safeParse(input);
      if (!p.success) return invalid(p.error);
      const r = sanitizeForObac(p.data.texto);
      if (r.blocked) {
        addLog(ctx, `Mensaje bloqueado por las reglas: «${p.data.texto}»`, `Regla: ${r.reasons.join(", ")}`);
        return {
          isError: true,
          content: `Bloqueado por las reglas (${r.reasons.join(", ")}): no das órdenes ni decisiones tácticas. Reformúlalo como información para el OBAC, o usa proponer_mensaje.`,
        };
      }
      const dup = recentlySaid(ctx.state, r.text, ctx.nowMs);
      if (dup) return { isError: true, content: `Ya dijiste eso a las ${clock(dup.at)} (seq ${dup.seq}). No lo repitas.` };
      addUtterance(ctx, {
        text: r.text,
        kind: p.data.tipo,
        priority: p.data.prioridad,
        evidence: evidenceRefs(p.data.evidencia ?? []),
        confidence: p.data.confianza ? CONF_ES[p.data.confianza] : null,
        rules: r.reasons,
        replyTo: p.data.tipo === "respuesta" ? ctx.answering : null,
      });
      const spoken = ctx.state.utterances.at(-1)?.speak ?? false;
      return {
        content: `${spoken ? "Dicho por radio y en pantalla" : ctx.state.silenced ? "Solo en pantalla (silencio)" : "Solo en pantalla (límite de 20 s)"}: «${r.text}»${r.reasons.length > 0 ? ` [reglas: ${r.reasons.join(", ")}]` : ""}`,
      };
    }
    case "proponer_mensaje": {
      const p = ProponerInput.safeParse(input);
      if (!p.success) return invalid(p.error);
      const claves = sanitizeForObac(p.data.mensaje_claves).text;
      const expl = sanitizeForObac(p.data.explicacion);
      const text = expl.blocked ? "Propuesta de mensaje para que usted decida si transmitirlo." : expl.text;
      addUtterance(ctx, {
        text,
        kind: "propuesta",
        priority: "resto",
        evidence: evidenceRefs(p.data.evidencia ?? []),
        claves,
        speak: false,
        rules: expl.reasons,
      });
      addAction(ctx, "propuesta", `Propuse un mensaje con claves: «${claves}»`);
      return { content: `Propuesta en la mesa de mando (no se transmite): «${claves}»` };
    }
    case "pedir_video": {
      const p = PedirVideoInput.safeParse(input);
      if (!p.success) return invalid(p.error);
      const zone = p.data.zona.replace(/[.]+$/, "");
      const from = p.data.desde?.trim() || "desde la vereda";
      const req = sanitizeVideoRequest(`Bomberos necesita un video ${zone}, ${from}.`);
      if (req.blocked) {
        return { isError: true, content: "Rechazado: al público solo se le pide un ángulo, sin acercarse ni entrar. Reformula la zona." };
      }
      const active = ctx.state.video_requests.find(
        (r) => Date.parse(r.expires_at) > ctx.nowMs && r.zone.toLowerCase() === zone.toLowerCase(),
      );
      if (active) return { isError: true, content: `Ya hay un pedido activo de video ${zone} (desde las ${clock(active.at)}).` };
      const delivered = countPublicViewers(ctx.world.incident.id, ctx.nowMs);
      const at = new Date(ctx.nowMs).toISOString();
      push(ctx, {
        op: "video_request",
        r: { id: newId(), at, zone, text: req.text, expires_at: new Date(ctx.nowMs + VIDEO_REQUEST_MS).toISOString(), delivered },
      });
      const who = delivered === 0 ? "a quienes abran la página de grabación" : `a ${delivered} ${delivered === 1 ? "persona" : "personas"}`;
      addAction(ctx, "pedido_video", `Pedí video ${zone} ${who}`);
      addLog(ctx, `Pedido de video ${zone}: «${req.text}»`, p.data.motivo);
      addUtterance(ctx, {
        text: `OBAC, Vigía: pedí video ${zone} ${who}.`,
        kind: "pedido_video",
        priority: "resto",
      });
      return { content: `Pedido publicado ${who}: «${req.text}». Ya le avisé al OBAC; no lo repitas.` };
    }
    case "anotar_bitacora": {
      const p = BitacoraInput.safeParse(input);
      if (!p.success) return invalid(p.error);
      addLog(ctx, p.data.que, p.data.por_que, evidenceRefs(p.data.evidencia ?? []));
      addAction(ctx, "bitacora", `Anoté: ${p.data.que}`);
      return { content: "Anotado en la bitácora." };
    }
    case "pendientes": {
      const p = PendientesInput.safeParse(input);
      if (!p.success) return invalid(p.error);
      if (p.data.accion === "listar") return { content: pendientesText(ctx.state, ctx.nowMs) };
      if (p.data.accion === "agregar") {
        if (!p.data.texto) return { isError: true, content: "Falta el texto del pendiente." };
        const item: VigiaPending = {
          id: newId(),
          at: new Date(ctx.nowMs).toISOString(),
          text: p.data.texto,
          who: p.data.quien || "OBAC",
          clave: null,
          source: "Vigía",
          status: "abierto",
          resolved_at: null,
          resolved_by: null,
          reminded_at: null,
        };
        push(ctx, { op: "pending_add", p: item });
        addAction(ctx, "pendiente", `Anoté pendiente: ${item.text}`);
        return { content: `Pendiente agregado (${item.id}).` };
      }
      const target = ctx.state.pending.find((x) => x.id === p.data.id && x.status === "abierto");
      if (!target) return { isError: true, content: "No hay un pendiente abierto con ese id. Usa «listar»." };
      push(ctx, { op: "pending_resolve", id: target.id, by: p.data.motivo || "Vigía", at: new Date(ctx.nowMs).toISOString() });
      addAction(ctx, "pendiente", `Cerré pendiente: ${target.text}`);
      return { content: "Pendiente resuelto." };
    }
    case "armar_parte": {
      const p = ParteInput.safeParse(input);
      if (!p.success) return invalid(p.error);
      const parte = buildParte(ctx, sanitizeForObac(p.data.resumen).text);
      push(ctx, { op: "parte", parte });
      addAction(ctx, "parte", "Armé el parte para Viper");
      return { content: "Parte armado; queda en la mesa de mando para exportar." };
    }
    default:
      return { isError: true, content: `Herramienta desconocida: ${name}` };
  }
}

/** Parte de servicio exportable: el resumen del agente más los datos que el código ya tiene. */
export function buildParte(ctx: TurnContext, resumen: string): { at: string; text: string; fields: Record<string, string> } {
  const w = ctx.world;
  const sit = w.situation;
  const people = personSightings(w);
  const open = ctx.state.pending.filter((p) => p.status === "abierto");
  const fields: Record<string, string> = {
    codigo: w.incident.code,
    tipo: w.incident.type,
    direccion: w.incident.address,
    inicio: ctx.state.created_at,
    cierre: new Date(ctx.nowMs).toISOString(),
    personas: sit ? trappedStatusLabel[sit.trapped.status] : people.length > 0 ? "posibles personas vistas" : "no se ven en los videos",
    videos: String(w.media.length),
    transmisiones_radio: String(w.radio.length),
    pendientes_abiertos: String(open.length),
  };
  const log = ctx.state.log.slice(-25).map((l) => `${clock(l.at)} ${l.what}${l.evidence.length > 0 ? ` [${l.evidence.join(", ")}]` : ""}`);
  const text = [
    `PARTE — ${w.incident.title} (${w.incident.code})`,
    `Dirección: ${w.incident.address || "sin dirección"}`,
    "",
    resumen,
    "",
    sit ? `Situación: ${sit.headline}. Personas atrapadas: ${trappedStatusLabel[sit.trapped.status]}.` : "",
    `Cobertura de video: ${coverageText(w)}`,
    open.length > 0 ? `Pendientes sin confirmar: ${open.map((p) => p.text).join("; ")}` : "Sin pendientes abiertos.",
    "",
    "Bitácora de Vigía:",
    ...log,
  ]
    .filter((s, i, arr) => !(s === "" && arr[i - 1] === ""))
    .join("\n");
  return { at: new Date(ctx.nowMs).toISOString(), text, fields };
}
