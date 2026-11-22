/**
 * GET  /api/incidents  → IncidentListResponse (activos primero, luego por fecha)
 * POST /api/incidents  CreateIncidentInput → { incident }   (origen central, verificado)
 */
import { requireStaff } from "@/lib/auth";
import type { IncidentListResponse } from "@/lib/contract";
import { runtimeMode } from "@/lib/config";
import { CreateIncidentInputSchema, type Incident } from "@/lib/domain";
import { ok, readJson, route } from "@/lib/http";
import { requireStaffOrBridge } from "@/lib/server/bridge-auth";
import { loadFocusPin, resolveFocus } from "@/lib/server/focus";
import { createCommandIncident, listIncidentSummaries } from "@/lib/server/snapshot";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";

// Los puentes Zello (con su token) y del dron también la leen: qué emergencias están abiertas
// y cuál atiende Vigía (`focus`).
export const GET = route(async (req) => {
  await requireStaffOrBridge(req);
  const store = getStore();
  const [incidents, pin] = await Promise.all([listIncidentSummaries(store), loadFocusPin()]);
  return ok<IncidentListResponse>({ incidents, mode: runtimeMode(), focus: resolveFocus(incidents, pin) });
});

export const POST = route(async (req) => {
  const staff = await requireStaff();
  const input = await readJson(req, CreateIncidentInputSchema);
  const incident = await createCommandIncident(getStore(), input, staff);
  return ok<{ incident: Incident }>({ incident }, { status: 201 });
});
