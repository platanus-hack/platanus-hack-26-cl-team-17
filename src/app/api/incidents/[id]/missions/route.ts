/**
 * POST /api/incidents/[id]/missions  CreateMissionInput → CreateMissionResponse
 * Despliega un dron (teléfono como sensor o dron real por API).
 * El token de ingesta se entrega solo en esta respuesta.
 */
import { requireStaff } from "@/lib/auth";
import { CreateMissionInputSchema } from "@/lib/domain";
import { droneDeps } from "@/lib/drone/server";
import { createMission } from "@/lib/drone/service";
import { ok, readJson, route } from "@/lib/http";

export const runtime = "nodejs";

export const POST = route<{ id: string }>(async (req, ctx) => {
  const { id } = await ctx.params;
  await requireStaff();
  const input = await readJson(req, CreateMissionInputSchema);
  return ok(await createMission(droneDeps(), id, input), { status: 201 });
});
