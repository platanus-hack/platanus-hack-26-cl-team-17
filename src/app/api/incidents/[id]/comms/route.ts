/**
 * POST /api/incidents/[id]/comms   AddCommInput → { entry }   (201)
 *
 * Registra una entrada de la bitácora radial (escrita, dictada, importada o del
 * simulacro), deja el evento en la línea de tiempo y pide el análisis de
 * comunicaciones en after() (el pipeline agrupa ráfagas con su candado).
 */
import { after } from "next/server";
import { requestCommsAnalysis } from "@/lib/ai/pipeline";
import { requireStaff } from "@/lib/auth";
import { AddCommInputSchema, type CommEntry } from "@/lib/domain";
import { errors, ok, readJson, route } from "@/lib/http";
import { commSourceLabel } from "@/lib/labels";
import { INCIDENT_NOT_FOUND } from "@/lib/server/snapshot";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";
// El análisis de comunicaciones corre en after().
export const maxDuration = 900;

function clip(text: string, max: number): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

export const POST = route<{ id: string }>(async (req, ctx) => {
  const { id } = await ctx.params;
  await requireStaff();
  const input = await readJson(req, AddCommInputSchema);
  const store = getStore();
  if ((await store.getIncidentRev(id)) === null) throw errors.notFound(INCIDENT_NOT_FOUND);

  const entry = await store.addComm({
    incident_id: id,
    text: input.text,
    speaker: input.speaker,
    channel: input.channel,
    source: input.source,
    at: input.at,
  });
  await store.addEvent({
    incident_id: id,
    kind: "comms",
    severity: "info",
    title: `${entry.speaker || "Sin identificar"}: ${clip(entry.text, 90)}`,
    detail: [`C${entry.seq}`, entry.channel ? `Canal ${entry.channel}` : "", commSourceLabel[entry.source]]
      .filter(Boolean)
      .join(" · "),
    comm_id: entry.id,
  });
  after(() => requestCommsAnalysis(id));
  return ok<{ entry: CommEntry }>({ entry }, { status: 201 });
});
