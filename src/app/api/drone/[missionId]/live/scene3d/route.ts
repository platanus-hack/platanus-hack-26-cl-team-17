/**
 * GET /api/drone/[missionId]/live/scene3d (personal) → Live3DSceneResponse
 * Estado de la reconstrucción 3D en vivo (servicio vigia-live3d). Sin servicio: enabled=false;
 * sin sesión todavía (no ha llegado video) o servicio caído: status=null.
 */
import { requireStaff } from "@/lib/auth";
import { fetchLive3dStatus, isLive3dConfigured } from "@/lib/drone/live3d";
import type { Live3DSceneResponse } from "@/lib/drone/live3d-types";
import { ok, route } from "@/lib/http";

export const runtime = "nodejs";

export const GET = route<{ missionId: string }>(async (_req, ctx) => {
  const { missionId } = await ctx.params;
  await requireStaff();
  const enabled = isLive3dConfigured();
  const body: Live3DSceneResponse = { enabled, status: enabled ? await fetchLive3dStatus(missionId) : null };
  return ok(body);
});
