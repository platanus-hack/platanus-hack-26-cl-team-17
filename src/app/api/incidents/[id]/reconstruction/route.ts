/**
 * POST /api/incidents/[id]/reconstruction  StartReconstructionInput → { reconstruction }
 *
 * Con GPU (SPLAT_JOB + Cloud Storage): escribe el manifiesto y lanza el job de
 * Cloud Run; el progreso llega después en incident.reconstruction del snapshot.
 * Sin GPU: genera al tiro la vista sintética desde el esquema de la IA (backend "demo").
 * 409 si ya hay una en curso que no venció, o si no hay con qué reconstruir.
 */
import { requireStaff } from "@/lib/auth";
import { StartReconstructionInputSchema, type StartReconstructionInput } from "@/lib/domain";
import { errors, ok, route } from "@/lib/http";
import { callbackOrigin, startReconstruction } from "@/lib/splat/service";

export const runtime = "nodejs";
export const maxDuration = 60;

/** El cuerpo es opcional: vacío equivale a `{}`. */
async function readInput(req: Request): Promise<StartReconstructionInput> {
  const text = (await req.text()).trim();
  let raw: unknown = {};
  if (text) {
    try {
      raw = JSON.parse(text);
    } catch {
      throw errors.invalid("El cuerpo debe ser JSON válido.");
    }
  }
  const parsed = StartReconstructionInputSchema.safeParse(raw);
  if (!parsed.success) throw errors.invalid("Datos inválidos.", parsed.error.issues);
  return parsed.data;
}

export const POST = route<{ id: string }>(async (req, ctx) => {
  const { id } = await ctx.params;
  await requireStaff();
  const input = await readInput(req);
  const reconstruction = await startReconstruction(id, input, callbackOrigin(req));
  return ok({ reconstruction });
});
