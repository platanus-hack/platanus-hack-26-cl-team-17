/**
 * Registro de entradas de la bitácora radial. Solo servidor.
 *
 * Lo usan las rutas del mando (POST /api/incidents/[id]/comms y …/comms/audio), por
 * donde también registra el puente Zello.
 */
import type { CommEntry } from "@/lib/domain";
import { errors } from "@/lib/http";
import { newId } from "@/lib/ids";
import { commSourceLabel } from "@/lib/labels";
import { storagePaths, type FileStorage, type NewComm, type Store } from "@/lib/store/types";

export { UNTRANSCRIBED_COMM_TEXT } from "@/lib/labels";

/** Tipo de contenido (sin parámetros de códec) → extensión servida por /api/files. */
const AUDIO_EXT: Record<string, string> = {
  "audio/webm": "weba",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
};

export function audioMediaType(contentType: string | null | undefined): string {
  return (contentType ?? "").split(";")[0].trim().toLowerCase();
}

/** Guarda la grabación de una transmisión y devuelve su ruta en el bucket. */
export async function saveCommAudio(
  files: FileStorage,
  incidentId: string,
  bytes: Uint8Array,
  contentType: string | null | undefined,
): Promise<string> {
  const mediaType = audioMediaType(contentType);
  const ext = AUDIO_EXT[mediaType];
  if (!ext) throw errors.invalid("Formato de audio no admitido (webm, ogg, mp4 o mp3).");
  if (bytes.byteLength === 0) throw errors.invalid("La grabación llegó vacía.");
  const audioPath = storagePaths.commAudio(incidentId, newId(), ext);
  await files.upload(audioPath, bytes, mediaType);
  return audioPath;
}

/** true si la ruta es una grabación de radio de este incidente (no otra carpeta ni otro incidente). */
export function isCommAudioPathOf(incidentId: string, audioPath: string): boolean {
  const prefix = `${storagePaths.incidentPrefix(incidentId)}comms/`;
  return audioPath.startsWith(prefix) && !audioPath.slice(prefix.length).includes("/") && !audioPath.includes("..");
}

function clip(text: string, max: number): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/** Agrega la entrada a la bitácora y su evento a la línea de tiempo. El análisis lo pide quien llama. */
export async function recordComm(store: Store, input: NewComm): Promise<CommEntry> {
  const entry = await store.addComm(input);
  await store.addEvent({
    incident_id: entry.incident_id,
    kind: "comms",
    severity: "info",
    title: `${entry.speaker || "Sin identificar"}: ${clip(entry.text, 90)}`,
    detail: [
      `C${entry.seq}`,
      entry.channel ? `Canal ${entry.channel}` : "",
      commSourceLabel[entry.source],
      entry.audio_path ? "con grabación" : "",
    ]
      .filter(Boolean)
      .join(" · "),
    comm_id: entry.id,
  });
  return entry;
}
