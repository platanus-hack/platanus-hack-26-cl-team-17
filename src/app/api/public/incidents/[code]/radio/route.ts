/**
 * POST /api/public/incidents/[code]/radio   multipart → { seq }   (201)
 *
 * Radio de demostración sin sesión: una transmisión hablada por el micrófono en
 * /radio/<código>. Campos: audio (archivo, opcional), text (transcripción del
 * navegador, puede venir vacía si hay audio), speaker, channel. Queda en la
 * bitácora como "dictado" y dispara el análisis de radio.
 *
 * Solo existe con config.demoRadio (VIGIA_DEMO_RADIO); limitada por IP e incidente.
 */
import { after } from "next/server";
import { z } from "zod";
import { requestCommsAnalysis } from "@/lib/ai/pipeline";
import { config } from "@/lib/config";
import { LIMITS } from "@/lib/domain";
import { clientIp, errors, ok, rateLimit, route } from "@/lib/http";
import { recordComm, saveCommAudio, UNTRANSCRIBED_COMM_TEXT } from "@/lib/server/comms";
import { findOpenIncidentByCode } from "@/lib/server/reports";
import { getFiles, getStore } from "@/lib/store";

export const runtime = "nodejs";
// El análisis de comunicaciones corre en after().
export const maxDuration = 900;

const FieldsSchema = z.object({
  text: z.string().trim().max(2000).default(""),
  speaker: z.string().trim().max(60).default(""),
  channel: z.string().trim().max(40).default(""),
});

/** Margen para los campos de texto y los separadores del multipart. */
const MAX_BODY_BYTES = LIMITS.MAX_COMM_AUDIO_BYTES + 64 * 1024;

function field(form: FormData, name: string): string | undefined {
  const v = form.get(name);
  return typeof v === "string" ? v : undefined;
}

export const POST = route<{ code: string }>(async (req, ctx) => {
  if (!config.demoRadio) throw errors.notFound();
  const { code } = await ctx.params;
  rateLimit(`demo-radio:${clientIp(req)}`, 30, 60_000);

  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw errors.tooLarge("La grabación supera los 4 MB.");
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw errors.invalid("La transmisión no llegó completa. Vuelve a intentarlo.");
  }
  const parsed = FieldsSchema.safeParse({
    text: field(form, "text"),
    speaker: field(form, "speaker"),
    channel: field(form, "channel"),
  });
  if (!parsed.success) throw errors.invalid("Revisa el emisor, el canal o el texto.", parsed.error.issues);
  const audio = form.get("audio");
  const audioFile = audio instanceof Blob && audio.size > 0 ? audio : null;
  if (audioFile && audioFile.size > LIMITS.MAX_COMM_AUDIO_BYTES) throw errors.tooLarge("La grabación supera los 4 MB.");
  if (!audioFile && !parsed.data.text) throw errors.invalid("La transmisión llegó vacía.");

  const store = getStore();
  const files = getFiles();
  const incident = await findOpenIncidentByCode(decodeURIComponent(code), { store, files });
  rateLimit(`demo-radio-inc:${incident.id}`, 60, 60_000);

  const audioPath = audioFile
    ? await saveCommAudio(files, incident.id, new Uint8Array(await audioFile.arrayBuffer()), audioFile.type)
    : null;
  const entry = await recordComm(store, {
    incident_id: incident.id,
    text: parsed.data.text || UNTRANSCRIBED_COMM_TEXT,
    speaker: parsed.data.speaker || "Radio",
    channel: parsed.data.channel,
    source: "dictation",
    audio_path: audioPath,
  });
  after(() => requestCommsAnalysis(incident.id));
  return ok<{ seq: number }>({ seq: entry.seq }, { status: 201 });
});
