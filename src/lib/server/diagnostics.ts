/**
 * Registro en memoria para la vista técnica (/mando/[id]/tecnica): las últimas llamadas a
 * Claude, los últimos errores del servidor y la última vuelta del agente por emergencia.
 *
 * Solo servidor, sin Next, store ni SDK (lo importan http.ts y la capa de IA). Acotado y sin
 * persistencia: se pierde al reiniciar y cada instancia tiene el suyo. Vive en globalThis para
 * que en desarrollo todas las copias del módulo (una por ruta) escriban en el mismo registro.
 *
 * Nunca guarda prompts ni respuestas. Los mensajes de error se limpian (URLs sin parámetros,
 * sin tokens, llaves ni credenciales en cadenas de conexión) antes de guardarse, porque se
 * muestran en el navegador. Registrar nunca lanza: se llama desde bloques catch.
 */
import type { DiagnosticsClaudeCall, DiagnosticsErrorSource, DiagnosticsServerError } from "@/lib/contract";

export const MAX_CLAUDE_CALLS = 30;
export const MAX_SERVER_ERRORS = 20;
const MAX_TURNS = 30;
/** El mismo error (origen, texto y emergencia) dentro de esta ventana suma al anterior. */
const DEDUPE_MS = 10 * 60_000;
const MAX_MESSAGE = 300;

export interface AgentTurnRecord {
  at: string;
  ms: number;
  /** true = hubo eventos y pensó (con Claude o plantillas). */
  thought: boolean;
  engine: "claude" | "plantilla" | null;
  events: string[];
}

interface DiagnosticsMemory {
  calls: DiagnosticsClaudeCall[];
  errors: DiagnosticsServerError[];
  /** Por emergencia: la última vuelta y la última en que pensó. */
  turns: Map<string, { last: AgentTurnRecord; thought: AgentTurnRecord | null }>;
}

type GlobalWithDiagnostics = typeof globalThis & { __vigiaDiagnostics?: DiagnosticsMemory };

function memory(): DiagnosticsMemory {
  const g = globalThis as GlobalWithDiagnostics;
  g.__vigiaDiagnostics ??= { calls: [], errors: [], turns: new Map() };
  return g.__vigiaDiagnostics;
}

/** Vacía el registro (para pruebas). */
export function resetDiagnostics(): void {
  const m = memory();
  m.calls = [];
  m.errors = [];
  m.turns.clear();
}

/* ───────────────────────────── Limpieza de textos ───────────────────────────── */

/**
 * Texto apto para mostrarse en el navegador: sin parámetros de URL (firmas, claves de
 * acceso), sin `Bearer …`, llaves `sk-ant-…`, JWT, credenciales en URLs de conexión ni
 * secuencias largas tipo token; una línea, acotado a `max`.
 */
export function scrubText(text: string, max = MAX_MESSAGE): string {
  const s = text
    // Credenciales en URLs de conexión: postgresql://usuario:clave@host
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1…@")
    // URLs: sin query ni fragmento (URLs firmadas, ?k=<share_key>, ?sig=…).
    .replace(/\b(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/gi, "$1?…")
    .replace(/\bBearer\s+\S+/gi, "Bearer …")
    .replace(/\bsk-ant-[\w-]+/g, "sk-ant-…")
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, "…")
    .replace(/\b(api[_-]?key|x-api-key|xi-api-key|token|secret|password|clave|sig|signature)(["']?\s*[=:]\s*["']?)[^\s&"',}]+/gi, "$1$2…")
    // Secuencias largas sin espacios que parecen tokens o firmas.
    .replace(/[A-Za-z0-9+_=-]{40,}/g, "…")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function statusOf(error: unknown): number | null {
  if (error === null || typeof error !== "object") return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" && Number.isFinite(status) ? status : null;
}

/** Descripción breve de un error cualquiera (sin depender de las clases del SDK). */
export function describeError(error: unknown): string {
  if (typeof error === "string") return scrubText(error);
  if (error instanceof Error) {
    // HttpError ya trae un mensaje en palabras para el operador: el nombre de la clase sobra.
    const name = error.name && error.name !== "Error" && error.name !== "HttpError" ? `${error.name}: ` : "";
    return scrubText(`${name}${error.message || "sin mensaje"}`);
  }
  try {
    return scrubText(JSON.stringify(error) ?? String(error));
  } catch {
    return scrubText(String(error));
  }
}

/* ───────────────────────────── Llamadas a Claude ───────────────────────────── */

/** Lo que se lee de la respuesta del SDK (BetaMessage), sin importar sus tipos. */
interface MessageLike {
  model?: string;
  stop_reason?: string | null;
  usage?: {
    input_tokens?: number | null;
    output_tokens?: number | null;
    cache_read_input_tokens?: number | null;
    iterations?: readonly { type?: string }[] | null;
  } | null;
}

export interface ClaudeCallInput {
  task: string;
  /** Modelo pedido (el que respondió sale de la respuesta). */
  model: string;
  fast: boolean;
  startedAt: number;
  endedAt?: number;
  incidentId?: string | null;
  incidentCode?: string | null;
}

function numOrNull(n: number | null | undefined): number | null {
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function pushCall(call: DiagnosticsClaudeCall): void {
  const m = memory();
  m.calls.push(call);
  if (m.calls.length > MAX_CLAUDE_CALLS) m.calls.splice(0, m.calls.length - MAX_CLAUDE_CALLS);
}

/** Registra una llamada a Claude terminada, bien (`message`) o con error (`error`). */
export function recordClaudeCall(input: ClaudeCallInput, outcome: { message: MessageLike } | { error: unknown }): void {
  try {
    const ended = input.endedAt ?? Date.now();
    const base = {
      at: new Date(input.startedAt).toISOString(),
      task: input.task,
      ms: Math.max(0, Math.round(ended - input.startedAt)),
      fast: input.fast,
      incident_id: input.incidentId ?? null,
      incident_code: input.incidentCode ?? null,
    };
    if ("message" in outcome) {
      const msg = outcome.message;
      const u = msg.usage ?? null;
      pushCall({
        ...base,
        model: msg.model || input.model,
        ok: true,
        error: null,
        status: null,
        input_tokens: numOrNull(u?.input_tokens),
        output_tokens: numOrNull(u?.output_tokens),
        cache_read_tokens: numOrNull(u?.cache_read_input_tokens),
        fallback: (u?.iterations ?? []).some((it) => it?.type === "fallback_message"),
        stop_reason: msg.stop_reason ?? null,
      });
    } else {
      pushCall({
        ...base,
        model: input.model,
        ok: false,
        error: describeError(outcome.error),
        status: statusOf(outcome.error),
        input_tokens: null,
        output_tokens: null,
        cache_read_tokens: null,
        fallback: false,
        stop_reason: null,
      });
    }
  } catch {
    /* el registro nunca rompe la llamada */
  }
}

/** Llamadas registradas, más recientes primero. */
export function listClaudeCalls(): DiagnosticsClaudeCall[] {
  return [...memory().calls].reverse();
}

/* ───────────────────────────── Errores del servidor ───────────────────────────── */

export interface ErrorContext {
  incidentId?: string | null;
  incidentCode?: string | null;
  /** Qué se estaba haciendo ("análisis de M3"); va antes del error. */
  context?: string;
  now?: number;
}

/** Registra un error en un punto que ya lo atrapaba. Los repetidos se agrupan. */
export function recordServerError(source: DiagnosticsErrorSource, error: unknown, ctx: ErrorContext = {}): void {
  try {
    const now = ctx.now ?? Date.now();
    const at = new Date(now).toISOString();
    const detail = describeError(error);
    const message = ctx.context ? scrubText(`${ctx.context}: ${detail}`) : detail;
    const incidentId = ctx.incidentId ?? null;
    const m = memory();
    const i = m.errors.findIndex((e) => e.source === source && e.message === message && e.incident_id === incidentId);
    if (i !== -1 && now - Date.parse(m.errors[i].at) <= DEDUPE_MS) {
      const [prev] = m.errors.splice(i, 1);
      m.errors.push({ ...prev, at, count: prev.count + 1, incident_code: prev.incident_code ?? ctx.incidentCode ?? null });
      return;
    }
    m.errors.push({ at, first_at: at, count: 1, source, message, incident_id: incidentId, incident_code: ctx.incidentCode ?? null });
    if (m.errors.length > MAX_SERVER_ERRORS) m.errors.splice(0, m.errors.length - MAX_SERVER_ERRORS);
  } catch {
    /* el registro nunca rompe a quien lo llama */
  }
}

/** Errores registrados, más recientes primero. */
export function listServerErrors(): DiagnosticsServerError[] {
  return [...memory().errors].reverse();
}

/**
 * Errores que informa otro proceso (el puente Zello, en su latido). Llegan repetidos en cada
 * latido con su propio conteo: se reemplazan, no se suman. El texto se vuelve a limpiar.
 */
export function mergeRemoteErrors(list: readonly Pick<DiagnosticsServerError, "at" | "first_at" | "count" | "source" | "message">[]): void {
  try {
    const m = memory();
    for (const r of list) {
      const message = scrubText(r.message);
      const i = m.errors.findIndex((e) => e.source === r.source && e.message === message && e.incident_id === null);
      const prev = i === -1 ? null : m.errors.splice(i, 1)[0];
      if (prev && Date.parse(prev.at) > Date.parse(r.at)) {
        m.errors.splice(i, 0, prev); // lo que ya hay es más nuevo: queda igual
        continue;
      }
      const entry: DiagnosticsServerError = {
        at: r.at,
        first_at: prev && Date.parse(prev.first_at) < Date.parse(r.first_at) ? prev.first_at : r.first_at,
        count: Math.max(r.count, prev?.count ?? 0),
        source: r.source,
        message,
        incident_id: null,
        incident_code: null,
      };
      // Orden por hora: los del puente pueden llegar con horas anteriores a errores ya registrados.
      let at = m.errors.length;
      while (at > 0 && Date.parse(m.errors[at - 1].at) > Date.parse(entry.at)) at--;
      m.errors.splice(at, 0, entry);
    }
    if (m.errors.length > MAX_SERVER_ERRORS) m.errors.splice(0, m.errors.length - MAX_SERVER_ERRORS);
  } catch {
    /* nunca rompe el latido */
  }
}

/* ───────────────────────────── Errores de las rutas /api ───────────────────────────── */

const INCIDENT_IN_PATH = /^\/api\/incidents\/([0-9a-zA-Z-]{1,64})(?:\/|$)/;

/** Origen de una ruta /api para el registro de errores. `bearer` = la petición traía Authorization: Bearer. */
export function routeErrorSource(path: string, bearer: boolean): DiagnosticsErrorSource {
  if (path.startsWith("/api/zello/")) return "puente";
  if (path.startsWith("/api/drone/")) return "dron";
  if (path.startsWith("/api/public/reports") || path.startsWith("/api/local-upload/") || /\/comms\/audio$/.test(path) || /\/media\/[^/]+\/frames$/.test(path)) {
    return bearer ? "puente" : "subida";
  }
  // El puente Zello usa con su token las mismas rutas que el mando (radio, salida, preguntas).
  if (bearer && path.startsWith("/api/incidents")) return "puente";
  if (/\/vigia(?:\/|$)/.test(path)) return "agente";
  if (/\/analyze$/.test(path)) return "analisis";
  return "api";
}

/**
 * ¿Vale la pena registrar esta respuesta de error? Siempre los 5xx. Además, lo que explica
 * por qué no entra algo en una demo: subidas rechazadas (tamaño, tipo, enlace vencido), el
 * puente o el dron con el token equivocado o frenados por el límite de tasa. No se registran
 * la sesión vencida del navegador (401 sin token en una lectura) ni los 404.
 */
export function shouldRecordRouteFailure(
  source: DiagnosticsErrorSource,
  status: number,
  req: { bearer: boolean; method: string },
): boolean {
  if (status >= 500) return true;
  if (status === 404) return false;
  // GET /api/zello/status lo lee el mando: un 401 ahí es la sesión del navegador, no el puente.
  if (source === "puente") return req.bearer || status !== 401 || req.method !== "GET";
  if (source === "dron") return req.bearer && status !== 409; // 409 = la misión ya terminó (esperable)
  if (source === "subida") return status !== 401;
  return false;
}

/** Lo llama `route()` de http.ts después de convertir la excepción en respuesta. */
export function noteRouteFailure(req: Request, status: number, error: unknown): void {
  try {
    const url = new URL(req.url);
    const path = url.pathname;
    const bearer = /^\s*bearer\s/i.test(req.headers.get("authorization") ?? "");
    const source = routeErrorSource(path, bearer);
    if (!shouldRecordRouteFailure(source, status, { bearer, method: req.method })) return;
    const incidentId = INCIDENT_IN_PATH.exec(path)?.[1] ?? null;
    // Las rutas llevan ids largos: se acortan para que el mensaje quede legible.
    const shortPath = path.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, (id) => `${id.slice(0, 8)}…`);
    recordServerError(source, error, { incidentId, context: `${req.method} ${shortPath} → ${status}` });
  } catch {
    /* nunca rompe la respuesta */
  }
}

/* ───────────────────────────── Vueltas del agente ───────────────────────────── */

/** Anota una vuelta del agente Vigía (sirve para ver si la escucha continua sigue viva). */
export function noteAgentTurn(incidentId: string, turn: AgentTurnRecord): void {
  try {
    const m = memory();
    const prev = m.turns.get(incidentId);
    m.turns.delete(incidentId);
    m.turns.set(incidentId, { last: turn, thought: turn.thought ? turn : (prev?.thought ?? null) });
    while (m.turns.size > MAX_TURNS) {
      const oldest = m.turns.keys().next().value;
      if (oldest === undefined) break;
      m.turns.delete(oldest);
    }
  } catch {
    /* nunca rompe la vuelta */
  }
}

export function getAgentTurns(incidentId: string): { last: AgentTurnRecord | null; thought: AgentTurnRecord | null } {
  const t = memory().turns.get(incidentId);
  return { last: t?.last ?? null, thought: t?.thought ?? null };
}
