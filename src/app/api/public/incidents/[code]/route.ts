import type { PublicIncident } from "@/lib/contract";
import { ok, route } from "@/lib/http";
import { findOpenIncidentByCode, toPublicIncident } from "@/lib/server/reports";
import { getFiles, getStore } from "@/lib/store";

export const runtime = "nodejs";

/** GET /api/public/incidents/[code] — 404 si no existe; 409 si ya se cerró. */
export const GET = route<{ code: string }>(async (_req, ctx) => {
  const { code } = await ctx.params;
  const incident = await findOpenIncidentByCode(decodeURIComponent(code), {
    store: getStore(),
    files: getFiles(),
  });
  return ok<{ incident: PublicIncident }>({ incident: toPublicIncident(incident) });
});
