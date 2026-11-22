/**
 * Cliente HTTP del puente Zello hacia Vigía (la app web, local o en Cloud Run).
 * Se identifica con Authorization: Bearer <VIGIA_BRIDGE_TOKEN>.
 */
import { z } from "zod";
import type { ZelloBridgeStatus } from "@/lib/contract";
import type { CommEntry } from "@/lib/domain";

const TIMEOUT_MS = 15_000;
const ASK_TIMEOUT_MS = 60_000;

export interface OpenIncident {
  id: string;
  code: string;
}

/** Lo que el puente necesita de un mensaje de la salida del agente (tolera campos extra). */
const SalidaItemSchema = z.object({
  seq: z.number(),
  at: z.string(),
  text: z.string(),
  priority: z.enum(["persona", "riesgo", "recursos", "resto"]).catch("resto"),
  speak: z.boolean(),
  kind: z.string().optional(),
});
export type SalidaItem = z.infer<typeof SalidaItemSchema>;

const SalidaSchema = z.object({ items: z.array(SalidaItemSchema), last_seq: z.number() });

export interface NewZelloComm {
  text: string;
  speaker: string;
  channel: string;
  at: string;
  audio_path?: string;
}

export interface VigiaApi {
  /** Emergencias abiertas (activas o controladas): primero la que atiende Vigía, luego la más reciente. */
  openIncidents(): Promise<OpenIncident[]>;
  uploadAudio(incidentId: string, ogg: Uint8Array): Promise<string>;
  addComm(incidentId: string, comm: NewZelloComm): Promise<CommEntry>;
  /** Salida del agente; "missing" si la ruta todavía no existe en el servidor. */
  salida(incidentId: string, after: number | null): Promise<{ items: SalidaItem[]; last_seq: number } | "missing">;
  ask(incidentId: string, question: string): Promise<{ answer: string }>;
  postStatus(status: ZelloBridgeStatus): Promise<void>;
}

export class VigiaHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "VigiaHttpError";
  }
}

export function createVigiaApi(baseUrl: string, token: string): VigiaApi {
  const base = baseUrl.replace(/\/+$/, "");
  const auth: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};

  async function call(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: { "user-agent": "vigia-zello-bridge/1", ...auth, ...(init.headers as Record<string, string> | undefined) },
      signal: AbortSignal.timeout(init.timeoutMs ?? TIMEOUT_MS),
    });
    return res;
  }

  async function json<T>(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
    const res = await call(path, init);
    const text = await res.text();
    if (!res.ok) {
      let msg = text.slice(0, 200);
      try {
        msg = (JSON.parse(text) as { error?: string }).error ?? msg;
      } catch {
        // cuerpo no JSON: queda el texto
      }
      throw new VigiaHttpError(res.status, `${init.method ?? "GET"} ${path} → ${res.status}: ${msg}`);
    }
    return JSON.parse(text) as T;
  }

  const seg = encodeURIComponent;

  return {
    async openIncidents() {
      const body = await json<{
        incidents: { id: string; code: string; status: string; created_at: string }[];
        /** La que atiende Vigía (fijada en el tablero o la más nueva); falta en servidores viejos. */
        focus?: { incident_id: string | null };
      }>("/api/incidents");
      const focusId = body.focus?.incident_id ?? null;
      const first = (i: { id: string }) => (i.id === focusId ? 1 : 0);
      return body.incidents
        .filter((i) => i.status === "active" || i.status === "controlled")
        .sort((a, b) => first(b) - first(a) || b.created_at.localeCompare(a.created_at))
        .map((i) => ({ id: i.id, code: i.code }));
    },
    async uploadAudio(incidentId, ogg) {
      const body = await json<{ audio_path: string }>(`/api/incidents/${seg(incidentId)}/comms/audio`, {
        method: "POST",
        headers: { "content-type": "audio/ogg" },
        body: new Blob([ogg as BlobPart], { type: "audio/ogg" }),
      });
      return body.audio_path;
    },
    async addComm(incidentId, comm) {
      const body = await json<{ entry: CommEntry }>(`/api/incidents/${seg(incidentId)}/comms`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...comm, source: "zello" }),
      });
      return body.entry;
    },
    async salida(incidentId, after) {
      const q = after === null ? "" : `?after=${after}`;
      const res = await call(`/api/incidents/${seg(incidentId)}/vigia/salida${q}`);
      const text = await res.text();
      if (res.status === 404) {
        // 404 en JSON = la emergencia ya no existe; 404 en HTML = la ruta aún no existe.
        if ((res.headers.get("content-type") ?? "").includes("application/json")) return { items: [], last_seq: after ?? -1 };
        return "missing";
      }
      if (!res.ok) throw new VigiaHttpError(res.status, `salida de ${incidentId} → ${res.status}: ${text.slice(0, 200)}`);
      return SalidaSchema.parse(JSON.parse(text));
    },
    async ask(incidentId, question) {
      return json<{ answer: string }>(`/api/incidents/${seg(incidentId)}/ask`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: question.slice(0, 500) }),
        timeoutMs: ASK_TIMEOUT_MS,
      });
    },
    async postStatus(status) {
      await json<{ ok: true }>("/api/zello/status", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(status),
      });
    },
  };
}
