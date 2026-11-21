/**
 * POST /api/demo/scenario  ScenarioStepRequest → ScenarioStepResponse
 * Ejecuta un paso del simulacro en vivo; `incident_id: null` con `step: 0` lo inicia.
 * El análisis de lo que inyecta cada paso corre después de responder (after()).
 */
import { z } from "zod";
import type { ScenarioStepResponse } from "@/lib/contract";
import { requireStaff } from "@/lib/auth";
import { runScenarioStep } from "@/lib/demo";
import { ok, readJson, route } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 900;

const ScenarioStepRequestSchema = z.object({
  incident_id: z.string().trim().min(1).max(64).nullable(),
  step: z.number().int().min(0).max(100),
});

export const POST = route(async (req) => {
  await requireStaff();
  const body = await readJson(req, ScenarioStepRequestSchema);
  const res: ScenarioStepResponse = await runScenarioStep(body.incident_id, body.step);
  return ok(res);
});
