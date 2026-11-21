/**
 * GET /api/briefing/[id]/vigia?k=<share_key>   → BriefingVigiaResponse
 *
 * Lo último que dijo Vigía (personas o riesgo) para la tablet del carro. Misma clave de
 * solo lectura que el briefing y mismo 404 si no calza. Respuesta chica: se sondea sin rev.
 */
import { getStaff } from "@/lib/auth";
import type { BriefingVigiaResponse } from "@/lib/contract";
import { ok, route } from "@/lib/http";
import { loadBriefingVigia } from "@/lib/server/briefing";
import { getStore } from "@/lib/store";
import { getVigiaState } from "@/lib/vigia/state-store";

export const runtime = "nodejs";

export const GET = route<{ id: string }>(async (req, ctx) => {
  const { id } = await ctx.params;
  const key = new URL(req.url).searchParams.get("k")?.trim() || null;
  const res = await loadBriefingVigia(
    getStore(),
    id,
    { key, hasStaffSession: async () => Boolean(await getStaff()) },
    async (incidentId) => (await getVigiaState(incidentId)).utterances,
  );
  return ok<BriefingVigiaResponse>(res);
});
