/**
 * POST /api/incidents/[id]/media/[mediaId]/frames   StaffFramesRequest → StaffFramesResponse (201)
 *
 * Para un medio que llegó sin fotogramas (p. ej. video recibido por WhatsApp sin
 * extracción en el servidor): el navegador del mando extrae los cuadros, aquí se
 * registran y se devuelve un destino de subida por cuadro, en el mismo orden.
 * Después el cliente llama a /analyze con `media_id`.
 */
import { z } from "zod";
import { requireStaff } from "@/lib/auth";
import type { StaffFramesRequest, StaffFramesResponse } from "@/lib/contract";
import { FrameMetaSchema, LIMITS } from "@/lib/domain";
import { errors, ok, readJson, route } from "@/lib/http";
import { getFiles, getStore, storagePaths } from "@/lib/store";

export const runtime = "nodejs";

const FramesSchema = z.object({
  frames: z.array(FrameMetaSchema).min(1).max(LIMITS.MAX_FRAMES_PER_MEDIA),
}) satisfies z.ZodType<StaffFramesRequest>;

export const POST = route<{ id: string; mediaId: string }>(async (req, ctx) => {
  const { id, mediaId } = await ctx.params;
  await requireStaff();
  const body = await readJson(req, FramesSchema);
  if (new Set(body.frames.map((f) => f.idx)).size !== body.frames.length) {
    throw errors.invalid("Hay fotogramas repetidos.");
  }

  const store = getStore();
  const media = await store.getMedia(mediaId);
  if (!media || media.incident_id !== id) throw errors.notFound("Ese medio no pertenece a este incidente.");
  if (media.frames.length > 0) throw errors.conflict("Este medio ya tiene fotogramas.");

  const path = (idx: number) => storagePaths.frame(id, media.id, idx);
  await store.addFrames(
    media.id,
    [...body.frames]
      .sort((a, b) => a.idx - b.idx)
      .map((f) => ({
        idx: f.idx,
        t_s: f.t_s,
        width: f.width,
        height: f.height,
        storage_path: path(f.idx),
        lat: null,
        lng: null,
        alt_m: null,
        heading_deg: null,
      })),
  );
  const files = getFiles();
  const frame_uploads = await Promise.all(body.frames.map((f) => files.createUploadTarget(path(f.idx), "image/jpeg")));
  return ok<StaffFramesResponse>({ frame_uploads }, { status: 201 });
});
