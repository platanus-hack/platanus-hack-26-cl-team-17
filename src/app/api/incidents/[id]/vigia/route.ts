/**
 * GET  /api/incidents/[id]/vigia?rev=N      → VigiaView | VigiaUnchanged
 * POST /api/incidents/[id]/vigia            { texto, responde_a? } → { id }   (201)
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
import { getVigiaRev, getVigiaState } from "@/lib/vigia/state-store";
import { ensureVigiaSupervisor, wakeVigia } from "@/lib/vigia/supervisor";
import type { VigiaUnchanged, VigiaView } from "@/lib/vigia/types";
import { toVigiaView } from "@/lib/vigia/view";

export const runtime = "nodejs";

const MessageSchema = z.object({
  texto: z.string().trim().min(1, "Escribe un mensaje.").max(500),
  responde_a: z.string().trim().max(64).nullish(),
});

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
  return ok<VigiaView>(toVigiaView(await getVigiaState(id), agentEngine(), now));
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
