/**
 * POST /api/incidents/[id]/ask   { question } → { answer, focus, engine }
 *
 * "Hablar con Vigía": responde la pregunta del OBAC con lo que ya se sabe del incidente.
 * engine = "simulated" cuando no hay Claude configurado (la interfaz lo rotula).
 * Acceso: sesión del personal o el puente Zello con su token.
 */
import { errors, ok, readJson, route } from "@/lib/http";
import { answerQuestion, AskInputSchema, type AskAnswer } from "@/lib/server/ask";
import { requireStaffOrBridge } from "@/lib/server/bridge-auth";
import { INCIDENT_NOT_FOUND } from "@/lib/server/snapshot";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";
export const maxDuration = 60;

export const POST = route<{ id: string }>(async (req, ctx) => {
  const { id } = await ctx.params;
  // Personal con sesión, o el puente Zello con su token (Bearer VIGIA_BRIDGE_TOKEN).
  await requireStaffOrBridge(req);
  const { question } = await readJson(req, AskInputSchema);
  const store = getStore();
  const incident = await store.getIncident(id);
  if (!incident) throw errors.notFound(INCIDENT_NOT_FOUND);
  const comms = await store.listComms(id);
  return ok<AskAnswer>(await answerQuestion(incident, comms, question));
});
