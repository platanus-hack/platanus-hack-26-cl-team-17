/**
 * PATCH /api/missions/[id]  MissionCommandRequest → { mission }
 * Órdenes del mando: retornar, abortar o reanudar.
 */
import { z } from "zod";
import { requireStaff } from "@/lib/auth";
import { droneDeps } from "@/lib/drone/server";
import { commandMission } from "@/lib/drone/service";
import { ok, readJson, route } from "@/lib/http";

export const runtime = "nodejs";

const MissionCommandRequestSchema = z.object({ action: z.enum(["recall", "abort", "resume"]) });

export const PATCH = route<{ id: string }>(async (req, ctx) => {
  const { id } = await ctx.params;
  await requireStaff();
  const { action } = await readJson(req, MissionCommandRequestSchema);
  return ok({ mission: await commandMission(droneDeps(), id, action) });
});
