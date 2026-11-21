import { after } from "next/server";
import { processMedia } from "@/lib/ai/pipeline";
import type { CompleteReportRequest } from "@/lib/contract";
import { ok, readJson, route } from "@/lib/http";
import { completeReport } from "@/lib/server/reports";
import { getFiles, getStore } from "@/lib/store";
import { z } from "zod";

export const runtime = "nodejs";
// El análisis corre en after(); Cloud Run mantiene la CPU (--no-cpu-throttling).
export const maxDuration = 900;

const BodySchema = z.object({
  part: z.enum(["frames", "video"]),
  ok: z.boolean(),
  error: z.string().max(500).optional(),
}) satisfies z.ZodType<CompleteReportRequest>;

/** POST /api/public/reports/[mediaId]/complete (header x-upload-token). Idempotente. */
export const POST = route<{ mediaId: string }>(async (req, ctx) => {
  const { mediaId } = await ctx.params;
  const body = await readJson(req, BodySchema);
  const { process } = await completeReport(mediaId, req.headers.get("x-upload-token"), body, {
    store: getStore(),
    files: getFiles(),
  });
  if (process) after(() => processMedia(mediaId));
  return ok<{ ok: true }>({ ok: true });
});
