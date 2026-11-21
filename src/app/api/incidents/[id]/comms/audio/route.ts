/**
 * POST /api/incidents/[id]/comms/audio   cuerpo: audio crudo (≤ 4 MB) → { audio_path }   (201)
 *
 * Guarda la grabación de una transmisión de radio en el bucket. El cliente la
 * sube apenas termina la transmisión y luego registra la entrada con
 * POST /api/incidents/[id]/comms { …, audio_path }. Pasa por el servidor (no por
 * URL firmada) porque cada grabación dura segundos y pesa poco.
 */
import { requireStaff } from "@/lib/auth";
import { LIMITS } from "@/lib/domain";
import { errors, ok, rateLimit, readLimitedBody, route } from "@/lib/http";
import { saveCommAudio } from "@/lib/server/comms";
import { INCIDENT_NOT_FOUND } from "@/lib/server/snapshot";
import { getFiles, getStore } from "@/lib/store";

export const runtime = "nodejs";

export const POST = route<{ id: string }>(async (req, ctx) => {
  const { id } = await ctx.params;
  await requireStaff();
  rateLimit(`comm-audio:${id}`, 120, 60_000);
  if ((await getStore().getIncidentRev(id)) === null) throw errors.notFound(INCIDENT_NOT_FOUND);

  const bytes = await readLimitedBody(req, LIMITS.MAX_COMM_AUDIO_BYTES, "La grabación supera los 4 MB.");
  const audioPath = await saveCommAudio(getFiles(), id, bytes, req.headers.get("content-type"));
  return ok<{ audio_path: string }>({ audio_path: audioPath }, { status: 201 });
});
