/**
 * Video en vivo del dron.
 *   POST (Authorization: Bearer <ingest_token>) cuerpo image/jpeg chico → LiveFrameAck.
 *        No se guarda como evidencia ni se analiza cuadro a cuadro.
 *   GET  ?after=<seq> (personal) → último cuadro image/jpeg · 204 si no hay uno más nuevo · 404 sin video.
 */
import { requireStaff } from "@/lib/auth";
import { LIMITS } from "@/lib/domain";
import { getLiveFrame, pushLiveFrame } from "@/lib/drone/live";
import { droneDeps } from "@/lib/drone/server";
import { authorizeDrone } from "@/lib/drone/service";
import { bearerToken, errors, ok, rateLimit, readLimitedBody, route } from "@/lib/http";

export const runtime = "nodejs";

export const POST = route<{ missionId: string }>(async (req, ctx) => {
  const { missionId } = await ctx.params;
  const deps = droneDeps();
  const mission = await authorizeDrone(deps.store, missionId, bearerToken(req));
  rateLimit(`drone-live:${missionId}`, 600, 60_000);
  const bytes = await readLimitedBody(req, LIMITS.MAX_LIVE_FRAME_BYTES, "El cuadro en vivo es demasiado grande.");
  return ok(await pushLiveFrame(deps, mission, bytes));
});

export const GET = route<{ missionId: string }>(async (req, ctx) => {
  const { missionId } = await ctx.params;
  await requireStaff();
  const raw = new URL(req.url).searchParams.get("after");
  const after = raw !== null && /^\d+$/.test(raw) ? Number(raw) : null;
  const frame = await getLiveFrame(droneDeps(), missionId, after);
  if (frame === "unchanged") return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  if (!frame) throw errors.notFound("Todavía no llega video de este dron.");
  return new Response(new Uint8Array(frame.bytes), {
    headers: {
      "Content-Type": "image/jpeg",
      "Cache-Control": "no-store",
      "X-Live-Seq": String(frame.seq),
      "X-Live-At": frame.at,
    },
  });
});
