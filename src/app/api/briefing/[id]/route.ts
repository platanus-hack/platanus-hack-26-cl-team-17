/**
 * GET /api/briefing/[id]?k=<share_key>&rev=N   → BriefingSnapshot | UnchangedResponse
 *
 * Sin sesión: el enlace de briefing en ruta lleva la clave de solo lectura del
 * incidente. Si la clave no calza (o falta y no hay sesión de personal) responde
 * 404, igual que si el incidente no existiera.
 */
import { getStaff } from "@/lib/auth";
import type { BriefingSnapshot, UnchangedResponse } from "@/lib/contract";
import { runtimeMode } from "@/lib/config";
import { ok, route } from "@/lib/http";
import { loadBriefing } from "@/lib/server/briefing";
import { parseRev } from "@/lib/server/snapshot";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";

export const GET = route<{ id: string }>(async (req, ctx) => {
  const { id } = await ctx.params;
  const sp = new URL(req.url).searchParams;
  const key = sp.get("k")?.trim() || null;
  const snapshot = await loadBriefing(getStore(), id, {
    key,
    rev: parseRev(sp.get("rev")),
    hasStaffSession: async () => Boolean(await getStaff()),
    mode: runtimeMode(),
  });
  return ok<BriefingSnapshot | UnchangedResponse>(snapshot);
});
