/**
 * POST /api/incidents/[id]/comms   AddCommInput → { entry }   (201)
 *
 * Registra una entrada de la bitácora radial (escrita, dictada, importada o
 * hablada por el micrófono), deja el evento en la línea de tiempo y pide el
 * análisis de comunicaciones en after() (el pipeline agrupa ráfagas con su candado).
 * `audio_path` (opcional) es la grabación ya subida con POST …/comms/audio.
 */
import { after } from "next/server";
import { requestCommsAnalysis } from "@/lib/ai/pipeline";
import { requireStaff } from "@/lib/auth";
import { AddCommInputSchema, type CommEntry } from "@/lib/domain";
import { errors, ok, readJson, route } from "@/lib/http";
import { isCommAudioPathOf, recordComm } from "@/lib/server/comms";
import { INCIDENT_NOT_FOUND } from "@/lib/server/snapshot";
import { getFiles, getStore } from "@/lib/store";

export const runtime = "nodejs";
// El análisis de comunicaciones corre en after().
export const maxDuration = 900;

export const POST = route<{ id: string }>(async (req, ctx) => {
  const { id } = await ctx.params;
  await requireStaff();
  const input = await readJson(req, AddCommInputSchema);
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
  after(() => requestCommsAnalysis(id));
  return ok<{ entry: CommEntry }>({ entry }, { status: 201 });
});
