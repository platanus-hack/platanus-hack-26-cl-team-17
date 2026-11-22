/**
 * POST /api/drone/[missionId]/live/scene3d/reset (personal) → { ok: true }
 * Borra la reconstrucción 3D en vivo de la misión en el servicio; vuelve a empezar con los
 * próximos cuadros. 404 sin servicio; 503 si el servicio no respondió.
 */
import { requireStaff } from "@/lib/auth";
import { isLive3dConfigured, resetLive3dSession } from "@/lib/drone/live3d";
import { errors, HttpError, ok, route } from "@/lib/http";

export const runtime = "nodejs";

export const POST = route<{ missionId: string }>(async (_req, ctx) => {
  const { missionId } = await ctx.params;
  await requireStaff();
  if (!isLive3dConfigured()) throw errors.notFound("La reconstrucción 3D en vivo no está configurada.");
  if (!(await resetLive3dSession(missionId))) throw new HttpError(503, "internal", "El servicio de reconstrucción 3D no respondió.");
  return ok({ ok: true });
});
