/**
 * GET /api/incidents/[id]/vigia/salida?after=<seq>   → VigiaSalida { items, last_seq }
 *
 * Salida de Vigía para el puente Zello (proceso aparte, Authorization: Bearer
 * VIGIA_BRIDGE_TOKEN) o el personal. Los mensajes ya pasaron por las reglas duras; solo
 * los que traen speak = true van por voz. Sin `after` devuelve desde el comienzo.
 * Si la emergencia no existe responde 404 en JSON.
 */
import { errors, ok, route } from "@/lib/http";
import { requireStaffOrBridge } from "@/lib/server/bridge-auth";
import { INCIDENT_NOT_FOUND, parseRev } from "@/lib/server/snapshot";
import { getStore } from "@/lib/store";
import { getVigiaState } from "@/lib/vigia/state-store";
import { ensureVigiaSupervisor } from "@/lib/vigia/supervisor";
import type { VigiaSalida } from "@/lib/vigia/types";
import { toSalida } from "@/lib/vigia/view";

export const runtime = "nodejs";

export const GET = route<{ id: string }>(async (req, ctx) => {
  const { id } = await ctx.params;
  await requireStaffOrBridge(req);
  ensureVigiaSupervisor();
  if ((await getStore().getIncidentRev(id)) === null) throw errors.notFound(INCIDENT_NOT_FOUND);
  const after = parseRev(new URL(req.url).searchParams.get("after"));
  return ok<VigiaSalida>(toSalida(await getVigiaState(id), after));
});
