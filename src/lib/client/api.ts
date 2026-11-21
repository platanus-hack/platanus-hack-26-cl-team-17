/**
 * Cliente tipado de todas las rutas /api del contrato (`src/lib/contract.ts`).
 * Solo navegador (o cualquier entorno con `fetch`); no toca globals al importarse.
 * Same-origin, sin caché. Los errores llegan como `ApiClientError`.
 */
import type { z } from "zod";
import type {
  AddCommInputSchema,
  CommEntry,
  CreateIncidentInputSchema,
  CreateMissionInputSchema,
  CreateReportInputSchema,
  DroneMission,
  Incident,
  Reconstruction,
  StartReconstructionInput,
  TelemetryInput,
  UpdateIncidentInput,
} from "@/lib/domain";
import type {
  AnalyzeRequest,
  ApiError,
  BriefingSnapshot,
  BriefingVigiaResponse,
  CompleteReportRequest,
  CreateMissionResponse,
  CreateReportResponse,
  CreateStaffRequest,
  DroneFrameResponse,
  LiveFrameAck,
  LiveInsightsResponse,
  IncidentDiagnostics,
  IncidentListResponse,
  IncidentSnapshot,
  LoginRequest,
  MissionCommandRequest,
  PublicIncident,
  PublicIncidentListResponse,
  RuntimeMode,
  ScenarioStepRequest,
  ScenarioStepResponse,
  StaffFramesRequest,
  ZelloStatusResponse,
  StaffFramesResponse,
  StaffPublic,
  TelemetryResponse,
  UnchangedResponse,
} from "@/lib/contract";

/* Entradas tal como las acepta el servidor (los campos con default son opcionales). */
export type CreateIncidentBody = z.input<typeof CreateIncidentInputSchema>;
export type AddCommBody = z.input<typeof AddCommInputSchema>;
export type CreateMissionBody = z.input<typeof CreateMissionInputSchema>;
export type CreateReportBody = z.input<typeof CreateReportInputSchema>;

/** Código estable de error; además de los de `ApiError`: "network" (sin conexión) y "aborted". */
export type ApiErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "invalid"
  | "too_large"
  | "rate_limited"
  | "conflict"
  | "internal"
  | "network"
  | "aborted"
  | (string & {});

export class ApiClientError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly details: unknown;

  constructor(status: number, code: ApiErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static fromApiError(status: number, body: ApiError): ApiClientError {
    return new ApiClientError(status, body.code, body.error, body.details);
  }
}

export function isApiClientError(err: unknown): err is ApiClientError {
  return err instanceof ApiClientError;
}

/** true si el sondeo respondió que no hubo cambios desde `rev`. */
export function isUnchanged<T extends { unchanged?: false }>(
  res: T | UnchangedResponse,
): res is UnchangedResponse {
  return (res as UnchangedResponse).unchanged === true;
}

export type QueryValue = string | number | boolean | null | undefined;

/** Arma una ruta relativa con query; omite valores null/undefined. */
export function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  if (!query) return path;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "number" && !Number.isFinite(v)) continue;
    qs.set(k, typeof v === "boolean" ? (v ? "1" : "0") : String(v));
  }
  const s = qs.toString();
  return s ? `${path}${path.includes("?") ? "&" : "?"}${s}` : path;
}

/** Segmento de ruta seguro. */
export const seg = (v: string) => encodeURIComponent(v);

const STATUS_CODE: Record<number, ApiErrorCode> = {
  400: "invalid",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  413: "too_large",
  429: "rate_limited",
};

const STATUS_MESSAGE: Record<string, string> = {
  invalid: "Solicitud inválida.",
  unauthorized: "Debes iniciar sesión.",
  forbidden: "No tienes permiso para esta acción.",
  not_found: "No encontrado.",
  conflict: "Conflicto con el estado actual.",
  too_large: "El archivo supera el tamaño permitido.",
  rate_limited: "Demasiadas solicitudes. Intenta en un momento.",
  internal: "Error del servidor. Intenta de nuevo en un momento.",
};

function isApiErrorBody(v: unknown): v is ApiError {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as ApiError).error === "string" &&
    typeof (v as ApiError).code === "string"
  );
}

/** Convierte una respuesta HTTP no exitosa en `ApiClientError` (con o sin cuerpo JSON). */
export async function errorFromResponse(res: Response): Promise<ApiClientError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* cuerpo vacío o no JSON (p. ej. 502 del balanceador) */
  }
  if (isApiErrorBody(body)) return ApiClientError.fromApiError(res.status, body);
  const code = STATUS_CODE[res.status] ?? "internal";
  return new ApiClientError(res.status, code, STATUS_MESSAGE[code] ?? STATUS_MESSAGE.internal);
}

function isAbort(err: unknown): boolean {
  return (
    (typeof DOMException !== "undefined" && err instanceof DOMException && err.name === "AbortError") ||
    (err instanceof Error && err.name === "AbortError")
  );
}

export interface RequestOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

interface InternalRequest extends RequestOptions {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  query?: Record<string, QueryValue>;
  /** Se serializa a JSON salvo que sea Blob/ArrayBuffer (se envía crudo). */
  body?: unknown;
}

/** Fetch base: same-origin, sin caché, JSON por defecto. Exportado para casos fuera del contrato. */
export async function request<T>(req: InternalRequest): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json", ...(req.headers ?? {}) };
  let body: BodyInit | undefined;
  if (req.body !== undefined) {
    if (
      (typeof Blob !== "undefined" && req.body instanceof Blob) ||
      req.body instanceof ArrayBuffer
    ) {
      body = req.body as BodyInit;
    } else {
      body = JSON.stringify(req.body);
      headers["Content-Type"] ??= "application/json";
    }
  }
  let res: Response;
  try {
    res = await fetch(buildUrl(req.path, req.query), {
      method: req.method,
      headers,
      body,
      cache: "no-store",
      credentials: "same-origin",
      signal: req.signal,
    });
  } catch (err) {
    if (isAbort(err)) throw new ApiClientError(0, "aborted", "Operación cancelada.");
    throw new ApiClientError(0, "network", "Sin conexión. Revisa tu señal e intenta de nuevo.");
  }
  if (!res.ok) throw await errorFromResponse(res);
  if (res.status === 204) return undefined as T;
  try {
    return (await res.json()) as T;
  } catch {
    throw new ApiClientError(res.status, "internal", "Respuesta inesperada del servidor.");
  }
}

const get = <T>(path: string, query?: Record<string, QueryValue>, o?: RequestOptions) =>
  request<T>({ method: "GET", path, query, ...o });
const post = <T>(path: string, body?: unknown, o?: RequestOptions) =>
  request<T>({ method: "POST", path, body: body ?? {}, ...o });
const patch = <T>(path: string, body: unknown, o?: RequestOptions) =>
  request<T>({ method: "PATCH", path, body, ...o });

export interface DroneFrameParams {
  lat: number;
  lng: number;
  alt?: number | null;
  heading?: number | null;
  /** Instante de captura (ISO 8601). */
  t?: string | null;
  /** true fuerza el cierre del lote y su envío a análisis. */
  flush?: boolean;
}

export const api = {
  status: (o?: RequestOptions) => get<{ mode: RuntimeMode }>("/api/status", undefined, o),

  /** Estado del puente Zello (latido cada ~10 s). */
  zello: {
    status: (o?: RequestOptions) => get<ZelloStatusResponse>("/api/zello/status", undefined, o),
  },

  auth: {
    login: (body: LoginRequest, o?: RequestOptions) =>
      post<{ staff: StaffPublic }>("/api/auth/login", body, o),
    logout: (o?: RequestOptions) => post<{ ok: true }>("/api/auth/logout", {}, o),
    me: (o?: RequestOptions) =>
      get<{ staff: StaffPublic | null; mode: RuntimeMode }>("/api/auth/me", undefined, o),
  },

  staff: {
    list: (o?: RequestOptions) => get<{ staff: StaffPublic[] }>("/api/staff", undefined, o),
    create: (body: CreateStaffRequest, o?: RequestOptions) =>
      post<{ staff: StaffPublic }>("/api/staff", body, o),
  },

  incidents: {
    list: (o?: RequestOptions) => get<IncidentListResponse>("/api/incidents", undefined, o),
    get: (id: string, rev?: number | null, o?: RequestOptions) =>
      get<IncidentSnapshot | UnchangedResponse>(`/api/incidents/${seg(id)}`, { rev }, o),
    create: (body: CreateIncidentBody, o?: RequestOptions) =>
      post<{ incident: Incident }>("/api/incidents", body, o),
    patch: (id: string, body: UpdateIncidentInput, o?: RequestOptions) =>
      patch<{ incident: Incident }>(`/api/incidents/${seg(id)}`, body, o),
    analyze: (id: string, body: AnalyzeRequest = {}, o?: RequestOptions) =>
      post<{ ok: true }>(`/api/incidents/${seg(id)}/analyze`, body, o),
    staffFrames: (id: string, mediaId: string, body: StaffFramesRequest, o?: RequestOptions) =>
      post<StaffFramesResponse>(`/api/incidents/${seg(id)}/media/${seg(mediaId)}/frames`, body, o),
    /** Reconstrucción 3D (Gaussian Splatting); sin GPU genera la vista sintética. */
    reconstruct: (id: string, body: StartReconstructionInput = {}, o?: RequestOptions) =>
      post<{ reconstruction: Reconstruction }>(`/api/incidents/${seg(id)}/reconstruction`, body, o),
    /** Diagnóstico para la vista técnica: qué subsistema está fallando. */
    diagnostics: (id: string, o?: RequestOptions) =>
      get<IncidentDiagnostics>(`/api/incidents/${seg(id)}/diagnostico`, undefined, o),
  },

  comms: {
    add: (incidentId: string, input: AddCommBody, o?: RequestOptions) =>
      post<{ entry: CommEntry }>(`/api/incidents/${seg(incidentId)}/comms`, input, o),
    /** Sube la grabación de una transmisión; devuelve la ruta para `add({ audio_path })`. */
    uploadAudio: (incidentId: string, audio: Blob, o?: RequestOptions) =>
      request<{ audio_path: string }>({
        method: "POST",
        path: `/api/incidents/${seg(incidentId)}/comms/audio`,
        body: audio,
        ...o,
        headers: { "Content-Type": audio.type.split(";")[0] || "audio/webm", ...(o?.headers ?? {}) },
      }),
  },

  missions: {
    create: (incidentId: string, input: CreateMissionBody, o?: RequestOptions) =>
      post<CreateMissionResponse>(`/api/incidents/${seg(incidentId)}/missions`, input, o),
    command: (missionId: string, action: MissionCommandRequest["action"], o?: RequestOptions) =>
      patch<{ mission: DroneMission }>(
        `/api/missions/${seg(missionId)}`,
        { action } satisfies MissionCommandRequest,
        o,
      ),
    tick: (missionId: string, o?: RequestOptions) =>
      post<{ mission: DroneMission }>(`/api/missions/${seg(missionId)}/tick`, {}, o),
  },

  public: {
    /** Incidentes activos cercanos; sin posición válida devuelve lista vacía sin llamar al servidor. */
    nearby: async (lat: number | null, lng: number | null, o?: RequestOptions) => {
      if (lat === null || lng === null || !Number.isFinite(lat) || !Number.isFinite(lng)) {
        return { incidents: [] } satisfies PublicIncidentListResponse;
      }
      return get<PublicIncidentListResponse>("/api/public/incidents", { lat, lng }, o);
    },
    byCode: (code: string, o?: RequestOptions) =>
      get<{ incident: PublicIncident }>(`/api/public/incidents/${seg(code.trim())}`, undefined, o),
    createReport: (input: CreateReportBody, o?: RequestOptions) =>
      post<CreateReportResponse>("/api/public/reports", input, o),
    completeReport: (
      mediaId: string,
      token: string,
      body: CompleteReportRequest,
      o?: RequestOptions,
    ) =>
      post<{ ok: true }>(`/api/public/reports/${seg(mediaId)}/complete`, body, {
        ...o,
        headers: { ...(o?.headers ?? {}), "x-upload-token": token },
      }),
  },

  briefing: {
    get: (id: string, key: string, rev?: number | null, o?: RequestOptions) =>
      get<BriefingSnapshot | UnchangedResponse>(`/api/briefing/${seg(id)}`, { k: key, rev }, o),
    vigia: (id: string, key: string, o?: RequestOptions) =>
      get<BriefingVigiaResponse>(`/api/briefing/${seg(id)}/vigia`, { k: key }, o),
  },

  drone: {
    telemetry: (missionId: string, token: string, input: TelemetryInput, o?: RequestOptions) =>
      post<TelemetryResponse>(`/api/drone/${seg(missionId)}/telemetry`, input, {
        ...o,
        headers: { ...(o?.headers ?? {}), Authorization: `Bearer ${token}` },
      }),
    frame: (
      missionId: string,
      token: string,
      blob: Blob,
      params: DroneFrameParams,
      o?: RequestOptions,
    ) =>
      request<DroneFrameResponse>({
        method: "POST",
        path: `/api/drone/${seg(missionId)}/frame`,
        query: {
          lat: params.lat,
          lng: params.lng,
          alt: params.alt,
          heading: params.heading,
          t: params.t,
          flush: params.flush === undefined ? undefined : params.flush,
        },
        body: blob,
        ...o,
        headers: {
          ...(o?.headers ?? {}),
          Authorization: `Bearer ${token}`,
          "Content-Type": "image/jpeg",
        },
      }),
    live: (missionId: string, token: string, blob: Blob, o?: RequestOptions) =>
      request<LiveFrameAck>({
        method: "POST",
        path: `/api/drone/${seg(missionId)}/live`,
        body: blob,
        ...o,
        headers: { ...(o?.headers ?? {}), Authorization: `Bearer ${token}`, "Content-Type": "image/jpeg" },
      }),
    liveInsights: (missionId: string, o?: RequestOptions) =>
      get<LiveInsightsResponse>(`/api/drone/${seg(missionId)}/live/insights`, undefined, o),
  },

  demo: {
    seed: (o?: RequestOptions) => post<{ incident_id: string }>("/api/demo/seed", {}, o),
    scenario: (body: ScenarioStepRequest, o?: RequestOptions) =>
      post<ScenarioStepResponse>("/api/demo/scenario", body, o),
  },
} as const;

export type Api = typeof api;

/** Mensaje en español apto para mostrar a cualquier persona. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiClientError) return err.message;
  if (err instanceof Error && err.message) return err.message;
  return "Ocurrió un error inesperado.";
}
