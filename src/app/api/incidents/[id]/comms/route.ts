/**
 * POST /api/incidents/[id]/comms   AddCommInput → { entry }   (201)
 *
 * Registra una entrada de la bitácora radial (escrita, importada o llegada por
 * Zello), deja el evento en la línea de tiempo y pide el análisis de
 * comunicaciones en after() (el pipeline agrupa ráfagas con su candado).
 * `audio_path` (opcional) es la grabación ya subida con POST …/comms/audio.
 * source "zello" solo lo puede usar el puente Zello (Bearer VIGIA_BRIDGE_TOKEN).
 */
import { after } from "next/server";
import { requestCommsAnalysis } from "@/lib/ai/pipeline";
import { AddCommInputSchema, type CommEntry } from "@/lib/domain";
import { errors, ok, readJson, route } from "@/lib/http";
import { mayActAsBridge, requireStaffOrBridge } from "@/lib/server/bridge-auth";
import { isCommAudioPathOf, recordComm } from "@/lib/server/comms";
import { isVigiaVoiceComm } from "@/lib/server/zello/channels";
import { INCIDENT_NOT_FOUND } from "@/lib/server/snapshot";
import { getFiles, getStore } from "@/lib/store";

export const runtime = "nodejs";
// El análisis de comunicaciones corre en after().
export const maxDuration = 900;

export const POST = route<{ id: string }>(async (req, ctx) => {
  const { id } = await ctx.params;
  await requireStaffOrBridge(req);
  const input = await readJson(req, AddCommInputSchema);
  // La insignia «Zello» en la bitácora significa que la transmisión llegó de verdad por Zello.
  if (input.source === "zello" && !mayActAsBridge(req)) throw errors.forbidden("Solo el puente Zello registra entradas de Zello.");
  const store = getStore();
  if ((await store.getIncidentRev(id)) === null) throw errors.notFound(INCIDENT_NOT_FOUND);
  const audioPath = input.audio_path?.trim() || null;
  if (audioPath !== null) {
    // Solo grabaciones de este mismo incidente, subidas por la ruta de audio.
    if (!isCommAudioPathOf(id, audioPath)) throw errors.invalid("La grabación no corresponde a este incidente.");
    if (!(await getFiles().exists(audioPath))) throw errors.invalid("La grabación no existe; vuelve a subirla.");
  }

  const entry = await recordComm(store, {
    incident_id: id,
    text: input.text,
    speaker: input.speaker,
    channel: input.channel,
    source: input.source,
    at: input.at,
    audio_path: audioPath,
  });
  // Lo que dijo Vigía por Zello queda anotado, pero no es tráfico de las compañías: no se analiza.
  if (!isVigiaVoiceComm(entry)) after(() => requestCommsAnalysis(id));
  return ok<{ entry: CommEntry }>({ entry }, { status: 201 });
});
