/**
 * POST /api/missions/[id]/tick → { mission }
 * Avanza una misión simulada hasta ahora (lo llama el panel cada ~2 s).
 * Para misiones no simuladas o terminadas no hace nada.
 */
import { requireStaff } from "@/lib/auth";
import { droneDeps } from "@/lib/drone/server";
import { tickMission } from "@/lib/drone/service";
import { ok, rateLimit, route } from "@/lib/http";

export const runtime = "nodejs";

export const POST = route<{ id: string }>(async (_req, ctx) => {
  const { id } = await ctx.params;
  await requireStaff();
  rateLimit(`drone-tick:${id}`, 120, 60_000);
  return ok({ mission: await tickMission(droneDeps(), id) });
});
