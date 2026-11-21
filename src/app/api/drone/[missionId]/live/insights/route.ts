/**
 * GET /api/drone/[missionId]/live/insights → LiveInsightsResponse
 * Observaciones del video en vivo (una cada ~15 s), las más nuevas primero.
 */
import { requireStaff } from "@/lib/auth";
import type { LiveInsightsResponse } from "@/lib/contract";
import { LIVE_INSIGHT_EVERY_MS, listLiveInsights } from "@/lib/drone/live";
import { ok, route } from "@/lib/http";

export const runtime = "nodejs";

export const GET = route<{ missionId: string }>(async (_req, ctx) => {
  const { missionId } = await ctx.params;
  await requireStaff();
  const body: LiveInsightsResponse = { ...listLiveInsights(missionId), every_s: LIVE_INSIGHT_EVERY_MS / 1000 };
  return ok(body);
});
