/**
 * POST /api/internal/reconstruction/[incidentId]   ReconstructionUpdate → { ok: true, cancel: boolean }
 *
 * Callback del job de GPU (Authorization: Bearer <HMAC del servidor para esta
 * reconstrucción>). `cancel: true` le pide al job detenerse: la reconstrucción
 * fue reemplazada por otra o ya se dio por fallida.
 */
import { ReconstructionUpdateSchema } from "@/lib/domain";
import { bearerToken, errors, ok, readJson, route } from "@/lib/http";
import { handleReconstructionCallback } from "@/lib/splat/service";

export const runtime = "nodejs";

export const POST = route<{ incidentId: string }>(async (req, ctx) => {
  const { incidentId } = await ctx.params;
  const token = bearerToken(req);
  if (!token) throw errors.unauthorized("Falta el token de la reconstrucción.");
  const update = await readJson(req, ReconstructionUpdateSchema);
  return ok(await handleReconstructionCallback(incidentId, token, update));
});
