/**
 * GET   /api/incidents/[id]?rev=N  → IncidentSnapshot | UnchangedResponse
 * PATCH /api/incidents/[id]        UpdateIncidentInput → { incident }
 *
 * El sondeo del puesto de mando manda el último `rev`: si no cambió, la respuesta
 * es mínima y no se cargan los hijos.
 */
import { after } from "next/server";
import { requestFusion } from "@/lib/ai/pipeline";
import { requireStaff } from "@/lib/auth";
import type { IncidentSnapshot, UnchangedResponse } from "@/lib/contract";
import { runtimeMode } from "@/lib/config";
import { UpdateIncidentInputSchema, type Incident } from "@/lib/domain";
import { ok, readJson, route } from "@/lib/http";
import { loadIncidentSnapshot, parseRev, updateCommandIncident } from "@/lib/server/snapshot";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";
// Si cambia la ubicación o el tipo, la fusión de la IA corre en after().
export const maxDuration = 900;

export const GET = route<{ id: string }>(async (req, ctx) => {
  const { id } = await ctx.params;
  await requireStaff();
  const rev = parseRev(new URL(req.url).searchParams.get("rev"));
  const snapshot = await loadIncidentSnapshot(getStore(), id, { rev, mode: runtimeMode() });
  return ok<IncidentSnapshot | UnchangedResponse>(snapshot);
});

export const PATCH = route<{ id: string }>(async (req, ctx) => {
  const { id } = await ctx.params;
  const staff = await requireStaff();
  const input = await readJson(req, UpdateIncidentInputSchema);
  const { incident, refuse } = await updateCommandIncident(getStore(), id, input, staff);
  if (refuse) after(() => requestFusion(id));
  return ok<{ incident: Incident }>({ incident });
});
