/**
 * GET /api/drone/[missionId]/live/scene3d/splat?after=<versión> (personal)
 * Última instantánea de los Gaussian splats en vivo (binario "VGS1", gpu/splat/LIVE3D.md), tal
 * cual, con su versión en `x-splat-version`; 204 si `after` ya es esa versión. Pedirla
 * mantiene encendido el entrenamiento en el servicio: solo lo hace la vista de splats abierta.
 * 404 sin servicio o sin sesión; 503 si el servicio falla.
 */
import { requireStaff } from "@/lib/auth";
import { fetchLive3dSplat, isLive3dConfigured } from "@/lib/drone/live3d";
import { errors, HttpError, route } from "@/lib/http";

export const runtime = "nodejs";

export const GET = route<{ missionId: string }>(async (req, ctx) => {
  const { missionId } = await ctx.params;
  await requireStaff();
  if (!isLive3dConfigured()) throw errors.notFound("La reconstrucción 3D en vivo no está configurada.");
  const raw = new URL(req.url).searchParams.get("after") ?? "0";
  if (!/^\d{1,9}$/.test(raw)) throw errors.invalid("after debe ser un entero.");
  const res = await fetchLive3dSplat(missionId, Number(raw));
  if (res.status === 204) return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  if (res.status === 404) throw errors.notFound("Todavía no hay reconstrucción 3D para este dron.");
  if (!res.body) throw new HttpError(503, "internal", "El servicio de reconstrucción 3D no respondió.");
  return new Response(res.body, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "no-store",
      "x-splat-version": String(res.version ?? 0),
    },
  });
});
