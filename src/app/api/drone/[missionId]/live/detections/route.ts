/**
 * GET /api/drone/[missionId]/live/detections[?after=<seq>] (personal) → LiveDetectionsResponse
 * Detecciones YOLO del video en vivo: la última y, con `after`, las nuevas desde ese seq (para
 * dibujar las cajas sobre el cuadro que se está mostrando). Sin detector: enabled=false y vacío.
 */
import { requireStaff } from "@/lib/auth";
import { getLiveDetections, listLiveDetectionHistory } from "@/lib/drone/live";
import { ok, route } from "@/lib/http";
import { isDetectorConfigured } from "@/lib/vision/detector";
import type { LiveDetectionsResponse } from "@/lib/vision/live-detections";

export const runtime = "nodejs";

export const GET = route<{ missionId: string }>(async (req, ctx) => {
  const { missionId } = await ctx.params;
  await requireStaff();
  const raw = new URL(req.url).searchParams.get("after");
  const after = raw !== null && /^\d+$/.test(raw) ? Number(raw) : null;
  const body: LiveDetectionsResponse = {
    enabled: isDetectorConfigured(),
    latest: getLiveDetections(missionId),
    recent: after === null ? [] : listLiveDetectionHistory(missionId).filter((d) => d.seq > after),
  };
  return ok(body);
});
