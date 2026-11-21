/**
 * POST /api/drone/[missionId]/frame?lat=&lng=&alt=&heading=&t=&flush=0|1
 * Cuerpo: image/jpeg crudo (≤ 3 MB). Authorization: Bearer <ingest_token>.
 * Junta los cuadros en lotes de LIMITS.DRONE_BATCH_FRAMES; al cerrar un lote lo manda a análisis.
 */
import { LIMITS } from "@/lib/domain";
import { droneDeps } from "@/lib/drone/server";
import { authorizeDrone, ingestFrame, parseFrameParams, readLimitedBody } from "@/lib/drone/service";
import { bearerToken, ok, rateLimit, route } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 900;

export const POST = route<{ missionId: string }>(async (req, ctx) => {
  const { missionId } = await ctx.params;
  const deps = droneDeps();
  const mission = await authorizeDrone(deps.store, missionId, bearerToken(req));
  rateLimit(`drone-frame:${missionId}`, 60, 60_000);
  const bytes = await readLimitedBody(req, LIMITS.MAX_FRAME_BYTES);
  return ok(await ingestFrame(deps, mission, bytes, parseFrameParams(new URL(req.url))));
});
