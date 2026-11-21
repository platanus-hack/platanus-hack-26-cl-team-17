/**
 * GET  /api/incidents/[id]/vigia?rev=N      → VigiaView | VigiaUnchanged
 * POST /api/incidents/[id]/vigia            { texto, responde_a? } → { id }   (201)
 * PATCH /api/incidents/[id]/vigia           { sin_ia: boolean } → VigiaView
 *
 * "Vigía sin IA" (plan B si Claude anda lento o caído): Vigía responde con plantillas y la
 * fusión y la radio de esta emergencia van por reglas, sin redeploy, hasta que se apague.
 *
 * La mesa de mando sondea lo que hace Vigía (mensajes, acciones, pendientes) y el OBAC le
 * escribe (una pregunta o una respuesta a una tarjeta). La respuesta llega en el sondeo.
 */
import { z } from "zod";
import { requireStaff } from "@/lib/auth";
import { errors, ok, readJson, route } from "@/lib/http";
import { parseRev, INCIDENT_NOT_FOUND } from "@/lib/server/snapshot";
import { getStore } from "@/lib/store";
import { addObacMessage, agentEngine } from "@/lib/vigia/agent";
import { newId } from "@/lib/ids";
import { getVigiaRev, getVigiaState, updateVigiaState } from "@/lib/vigia/state-store";
import { ensureVigiaSupervisor, wakeVigia } from "@/lib/vigia/supervisor";
import type { VigiaUnchanged, VigiaView } from "@/lib/vigia/types";
import { toVigiaView } from "@/lib/vigia/view";

export const runtime = "nodejs";

const MessageSchema = z.object({
  texto: z.string().trim().min(1, "Escribe un mensaje.").max(500),
  responde_a: z.string().trim().max(64).nullish(),
});

const ModeSchema = z.object({ sin_ia: z.boolean() });

export const GET = route<{ id: string }>(async (req, ctx) => {
  const { id } = await ctx.params;
  await requireStaff();
  ensureVigiaSupervisor();
  if ((await getStore().getIncidentRev(id)) === null) throw errors.notFound(INCIDENT_NOT_FOUND);
  const rev = parseRev(new URL(req.url).searchParams.get("rev"));
  const now = Date.now();
  if (rev !== null && (await getVigiaRev(id)) === rev) {
    return ok<VigiaUnchanged>({ unchanged: true, rev, server_time: new Date(now).toISOString() });
  }
  const state = await getVigiaState(id);
  return ok<VigiaView>(toVigiaView(state, agentEngine(state), now));
});

export const PATCH = route<{ id: string }>(async (req, ctx) => {
  const { id } = await ctx.params;
  const staff = await requireStaff();
  const { sin_ia } = await readJson(req, ModeSchema);
  if ((await getStore().getIncidentRev(id)) === null) throw errors.notFound(INCIDENT_NOT_FOUND);
  const state = await updateVigiaState(id, (s) => {
    if (s.ai_off === sin_ia) return false;
    s.ai_off = sin_ia;
    s.actions = [
      ...s.actions,
      {
        id: newId(),
        at: new Date().toISOString(),
        kind: "bitacora" as const,
        text: sin_ia
          ? `${staff.name} pasó a Vigía sin IA: plantillas, y la fusión y la radio por reglas`
          : `${staff.name} volvió a encender la IA de Vigía`,
      },
    ].slice(-60);
  });
  wakeVigia(id);
  return ok<VigiaView>(toVigiaView(state, agentEngine(state), Date.now()));
});

export const POST = route<{ id: string }>(async (req, ctx) => {
  const { id } = await ctx.params;
  await requireStaff();
  const { texto, responde_a } = await readJson(req, MessageSchema);
  if ((await getStore().getIncidentRev(id)) === null) throw errors.notFound(INCIDENT_NOT_FOUND);
  const messageId = await addObacMessage(id, texto, responde_a ?? null);
  wakeVigia(id);
  return ok<{ id: string }>({ id: messageId }, { status: 201 });
});
