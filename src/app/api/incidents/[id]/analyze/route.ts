/**
 * POST /api/incidents/[id]/analyze   AnalyzeRequest → { ok: true }   (202)
 *
 *   { media_id }   → reanaliza ese medio (forzado) y luego refusiona
 *   { comms: true } → reanaliza las comunicaciones
 *   {} o sin cuerpo → fuerza la fusión completa (informe de situación + escena)
 *
 * Responde de inmediato; el trabajo corre en after() y el avance se ve en el
 * snapshot (estado del medio e `incident.pipeline`).
 */
import { after } from "next/server";
import { z } from "zod";
import { processMedia, requestCommsAnalysis, requestFusion } from "@/lib/ai/pipeline";
import { requireStaff } from "@/lib/auth";
import type { AnalyzeRequest } from "@/lib/contract";
import { errors, ok, route } from "@/lib/http";
import { INCIDENT_NOT_FOUND } from "@/lib/server/snapshot";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";
// La IA corre en after(); Cloud Run mantiene la CPU (--no-cpu-throttling).
export const maxDuration = 900;

const AnalyzeSchema = z.object({
  media_id: z.string().trim().min(1).max(64).optional(),
  comms: z.boolean().optional(),
}) satisfies z.ZodType<AnalyzeRequest>;

/** El cuerpo es opcional: vacío equivale a `{}` (fusión completa). */
async function readBody(req: Request): Promise<AnalyzeRequest> {
  const text = await req.text();
  let raw: unknown = {};
  if (text.trim()) {
    try {
      raw = JSON.parse(text);
    } catch {
      throw errors.invalid("El cuerpo debe ser JSON válido.");
    }
  }
  const parsed = AnalyzeSchema.safeParse(raw);
  if (!parsed.success) throw errors.invalid("Datos inválidos.", parsed.error.issues);
  return parsed.data;
}

export const POST = route<{ id: string }>(async (req, ctx) => {
  const { id } = await ctx.params;
  await requireStaff();
  const body = await readBody(req);
  const store = getStore();
  if ((await store.getIncidentRev(id)) === null) throw errors.notFound(INCIDENT_NOT_FOUND);

  if (body.media_id) {
    const media = await store.getMedia(body.media_id);
    if (!media || media.incident_id !== id) throw errors.notFound("Ese medio no pertenece a este incidente.");
    // Sus cuadros son ilustraciones: reanalizarlos borraría el análisis de demostración.
    if (media.source === "demo") {
      throw errors.conflict("Los medios de demostración no se reanalizan: su análisis simulado es fijo.");
    }
    const mediaId = media.id;
    after(() => processMedia(mediaId, { force: true }));
  }
  if (body.comms) after(() => requestCommsAnalysis(id));
  if (!body.media_id && !body.comms) after(() => requestFusion(id, { force: true }));

  return ok<{ ok: true }>({ ok: true }, { status: 202 });
});
