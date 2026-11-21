import type { PublicIncidentListResponse } from "@/lib/contract";
import { ok, route } from "@/lib/http";
import { listNearbyPublic } from "@/lib/server/reports";
import { getFiles, getStore } from "@/lib/store";

export const runtime = "nodejs";

/** GET /api/public/incidents?lat=&lng= — emergencias activas cercanas (máx. 5). */
export const GET = route(async (req) => {
  const q = new URL(req.url).searchParams;
  const num = (v: string | null) => (v === null || v.trim() === "" ? null : Number(v));
  const incidents = await listNearbyPublic(num(q.get("lat")), num(q.get("lng")), {
    store: getStore(),
    files: getFiles(),
  });
  return ok<PublicIncidentListResponse>({ incidents });
});
