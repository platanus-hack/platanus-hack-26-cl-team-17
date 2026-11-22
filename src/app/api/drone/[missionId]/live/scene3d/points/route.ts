/**
 * GET /api/drone/[missionId]/live/scene3d/points?from=<k>&max=<m> (personal)
 * Trozos de puntos [from, from+max) de la reconstrucción 3D en vivo, en el binario "VL3D" del
 * servicio (gpu/splat/LIVE3D.md), tal cual. 404 sin servicio o sin sesión; 503 si el servicio falla.
 */
import { requireStaff } from "@/lib/auth";
import { fetchLive3dPoints, isLive3dConfigured } from "@/lib/drone/live3d";
import { errors, HttpError, route } from "@/lib/http";

export const runtime = "nodejs";

const MAX_CHUNKS = 16;

export const GET = route<{ missionId: string }>(async (req, ctx) => {
  const { missionId } = await ctx.params;
  await requireStaff();
  if (!isLive3dConfigured()) throw errors.notFound("La reconstrucción 3D en vivo no está configurada.");
  const q = new URL(req.url).searchParams;
  const rawFrom = q.get("from") ?? "0";
  const rawMax = q.get("max") ?? "8";
  if (!/^\d{1,9}$/.test(rawFrom) || !/^\d{1,2}$/.test(rawMax)) throw errors.invalid("from y max deben ser enteros.");
  const from = Number(rawFrom);
  const max = Math.min(MAX_CHUNKS, Math.max(1, Number(rawMax)));
  const res = await fetchLive3dPoints(missionId, from, max);
  if (res.status === 404) throw errors.notFound("Todavía no hay reconstrucción 3D para este dron.");
  if (res.status === 400) throw errors.invalid("El servicio 3D rechazó el rango pedido.");
  if (!res.body) throw new HttpError(503, "internal", "El servicio de reconstrucción 3D no respondió.");
  return new Response(res.body, {
    headers: { "Content-Type": "application/octet-stream", "Cache-Control": "no-store" },
  });
});
