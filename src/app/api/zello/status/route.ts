/**
 * POST /api/zello/status   ZelloBridgeStatus → { ok: true }   (solo el puente Zello, cada ~10 s)
 * GET  /api/zello/status   → ZelloStatusResponse              (mesa de mando)
 */
import { requireStaff } from "@/lib/auth";
import type { ZelloStatusResponse } from "@/lib/contract";
import { ok, rateLimit, readJson, route } from "@/lib/http";
import { requireBridge } from "@/lib/server/bridge-auth";
import { loadZelloStatus, saveZelloStatus, ZelloBridgeStatusSchema } from "@/lib/server/zello/status";

export const runtime = "nodejs";

export const POST = route(async (req) => {
  requireBridge(req);
  rateLimit("zello-status", 30, 60_000);
  const status = await readJson(req, ZelloBridgeStatusSchema);
  await saveZelloStatus(status);
  return ok({ ok: true as const });
});

export const GET = route(async () => {
  await requireStaff();
  return ok<ZelloStatusResponse>(await loadZelloStatus());
});
