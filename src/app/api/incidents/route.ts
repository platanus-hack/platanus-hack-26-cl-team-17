/**
 * GET  /api/incidents  → IncidentListResponse (activos primero, luego por fecha)
 * POST /api/incidents  CreateIncidentInput → { incident }   (origen central, verificado)
 */
import { requireStaff } from "@/lib/auth";
import type { IncidentListResponse } from "@/lib/contract";
import { runtimeMode } from "@/lib/config";
import { ensureLocalSeed } from "@/lib/demo";
import { CreateIncidentInputSchema, type Incident } from "@/lib/domain";
import { ok, readJson, route } from "@/lib/http";
import { createCommandIncident, listIncidentSummaries } from "@/lib/server/snapshot";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";
// La siembra local de la demo deja análisis en after().
export const maxDuration = 900;

export const GET = route(async () => {
  await requireStaff();
  const store = getStore();
  if (store.kind === "local") await ensureLocalSeed();
  const incidents = await listIncidentSummaries(store);
  return ok<IncidentListResponse>({ incidents, mode: runtimeMode() });
});

export const POST = route(async (req) => {
  const staff = await requireStaff();
  const input = await readJson(req, CreateIncidentInputSchema);
  const incident = await createCommandIncident(getStore(), input, staff);
  return ok<{ incident: Incident }>({ incident }, { status: 201 });
});
