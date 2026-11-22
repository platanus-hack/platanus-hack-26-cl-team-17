/**
 * GET /api/incidents/[id]/diagnostico   (personal) → IncidentDiagnostics
 *
 * Diagnóstico de una emergencia: qué está fallando ahora. Puente Zello, últimas llamadas
 * a Claude, detector, salida de Vigía, errores recientes y motor en uso. La mesa la sondea cada
 * ~3 s. Exige la misma sesión que el resto del mando (requireStaff; en modo local abierto, la
 * sesión de demostración) y nunca devuelve secretos, tokens, share_key ni datos del personal.
 * Lo que está en memoria (llamadas, errores, video en vivo) es de esta instancia del servidor.
 */
import { requireStaff } from "@/lib/auth";
import type { IncidentDiagnostics } from "@/lib/contract";
import { errors, ok, route } from "@/lib/http";
import { buildIncidentDiagnostics } from "@/lib/server/diagnostics-report";
import { INCIDENT_NOT_FOUND } from "@/lib/server/snapshot";

export const runtime = "nodejs";

export const GET = route<{ id: string }>(async (_req, ctx) => {
  const { id } = await ctx.params;
  await requireStaff();
  const report = await buildIncidentDiagnostics(id);
  if (!report) throw errors.notFound(INCIDENT_NOT_FOUND);
  return ok<IncidentDiagnostics>(report);
});
