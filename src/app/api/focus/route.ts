/**
 * PUT /api/focus  SetFocusInput → { focus: IncidentFocus }
 *
 * Fija la emergencia que atienden Vigía, el puente Zello y el puente del dron (una a la vez).
 * `incident_id: null` vuelve al modo automático: la abierta más nueva. El foco vigente lo
 * devuelve GET /api/incidents en `focus`.
 */
import { requireStaff } from "@/lib/auth";
import type { IncidentFocus } from "@/lib/contract";
import { errors, ok, readJson, route } from "@/lib/http";
import { loadFocusPin, resolveFocus, saveFocusPin, SetFocusInputSchema } from "@/lib/server/focus";
import { getStore } from "@/lib/store";
import { refreshVigiaWatch } from "@/lib/vigia/supervisor";

export const runtime = "nodejs";

export const PUT = route(async (req) => {
  const staff = await requireStaff();
  const { incident_id } = await readJson(req, SetFocusInputSchema);
  const store = getStore();
  if (incident_id !== null) {
    const incident = await store.getIncident(incident_id);
    if (!incident) throw errors.notFound("La emergencia no existe.");
    if (incident.status === "closed") throw errors.conflict("La emergencia está cerrada: Vigía no puede atenderla.");
  }
  await saveFocusPin(incident_id, staff);
  refreshVigiaWatch();
  const open = await store.listIncidents({ status: ["active", "controlled"] });
  return ok<{ focus: IncidentFocus }>({ focus: resolveFocus(open, await loadFocusPin()) });
});
