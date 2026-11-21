/**
 * POST /api/drone/[missionId]/telemetry  TelemetryInput → TelemetryResponse
 * Authorization: Bearer <ingest_token>. Responde con la orden pendiente del mando.
 */
import { TelemetryInputSchema } from "@/lib/domain";
import { droneDeps } from "@/lib/drone/server";
import { authorizeDrone, ingestTelemetry } from "@/lib/drone/service";
import { bearerToken, ok, rateLimit, readJson, route } from "@/lib/http";

export const runtime = "nodejs";

export const POST = route<{ missionId: string }>(async (req, ctx) => {
  const { missionId } = await ctx.params;
  const deps = droneDeps();
  const mission = await authorizeDrone(deps.store, missionId, bearerToken(req));
  // Generoso: un dron real puede mandar telemetría a 1–2 Hz.
  rateLimit(`drone-telemetry:${missionId}`, 300, 60_000);
  const input = await readJson(req, TelemetryInputSchema);
  return ok(await ingestTelemetry(deps, mission, input));
});
