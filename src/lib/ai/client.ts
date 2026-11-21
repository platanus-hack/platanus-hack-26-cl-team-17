/**
 * Cliente de Claude (solo servidor) y llamada con salida estructurada.
 *
 * Decisiones (verificadas contra @anthropic-ai/sdk 1.12 instalado):
 *  - Endpoint beta con `betas: ["server-side-fallback-2026-07-01"]` y
 *    `fallbacks: "default"`: si el modelo declina por política, la API reintenta
 *    en el modelo de respaldo dentro de la misma llamada.
 *  - Se usa `beta.messages.create` + validación propia con el esquema Zod, NO
 *    `beta.messages.parse()`. Los tipos de parse() aceptan fallbacks junto con
 *    output_config.format, pero en tiempo de ejecución parse() hace JSON.parse de
 *    cada bloque de texto dentro de la promesa y lanza AnthropicError si falla:
 *    con `max_tokens` (JSON truncado) o `refusal` perderíamos el stop_reason y no
 *    podríamos dar un error claro. Con create revisamos stop_reason primero.
 *    El JSON Schema se genera con el helper oficial `betaZodOutputFormat` y la
 *    solicitud lleva el mismo beta de salida estructurada que agrega parse().
 *  - Sin `thinking` (en Opus 5.5 siempre es adaptativo; disabled da 400) ni
 *    temperature/top_p. La profundidad se controla con output_config.effort.
 *  - Prompt de sistema estable con cache_control; lo variable va en el usuario.
 *  - Los esquemas grandes (medio, informe, escena) superan el límite del
 *    compilador de gramáticas de la API (400 "compiled grammar is too large",
 *    medido con claude-opus-5-5). Ante un 400 con salida estructurada se pasa a
 *    "modo prompt": el JSON Schema va en el prompt de sistema (cacheado), la
 *    respuesta se normaliza contra el esquema (solo rellenos seguros) y se
 *    valida con Zod; si no cumple, se pide UNA corrección. El esquema que falló
 *    queda recordado para no repetir el 400 en cada llamada.
 */
import Anthropic, {
  AnthropicError,
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  ContentTooLargeError,
  GatewayTimeoutError,
  InternalServerError,
  NotFoundError,
  OverloadedError,
  PaymentRequiredError,
  PermissionDeniedError,
  RateLimitError,
  RequestHeaderFieldsTooLargeError,
  RequestTimeoutError,
  ServiceUnavailableError,
  UnprocessableEntityError,
} from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaJSONOutputFormat,
  BetaMessage,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { z } from "zod";
import { config } from "@/lib/config";
import { recordClaudeCall } from "@/lib/server/diagnostics";
import { isImageMediaType, type AITask, type UserContent } from "./types";

/* ═══════════════════════════════ Errores ═══════════════════════════════ */

export type AIErrorCode =
  | "refusal"
  | "max_tokens"
  | "invalid_output"
  | "auth"
  | "permission"
  | "rate_limit"
  | "overloaded"
  | "timeout"
  | "connection"
  | "bad_request"
  | "not_found"
  | "api";

/** Error de la capa de IA con mensaje en español para el operador. */
export class AIError extends Error {
  readonly code: AIErrorCode;
  /** true si tiene sentido volver a intentar más tarde (falla transitoria). */
  readonly retryable: boolean;

  constructor(
    code: AIErrorCode,
    message: string,
    opts?: { cause?: unknown; retryable?: boolean },
  ) {
    super(message, opts?.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "AIError";
    this.code = code;
    this.retryable = opts?.retryable ?? DEFAULT_RETRYABLE[code];
  }
}

const DEFAULT_RETRYABLE: Record<AIErrorCode, boolean> = {
  refusal: false,
  max_tokens: false,
  invalid_output: true,
  auth: false,
  permission: false,
  rate_limit: true,
  overloaded: true,
  timeout: true,
  connection: true,
  bad_request: false,
  not_found: false,
  api: true,
};

export const REFUSAL_MESSAGE = "El modelo declinó analizar este contenido.";

/**
 * Traduce cualquier error del SDK (o ajeno) a AIError, usando las clases
 * tipadas de la más específica a la más general. Nunca compara mensajes.
 */
export function mapSdkError(error: unknown, ctx: { model: string }): AIError {
  if (error instanceof AIError) return error;
  const cause = error;

  // Subclases de APIConnectionError / APIError sin respuesta HTTP: primero las más específicas.
  if (error instanceof APIConnectionTimeoutError) {
    return new AIError(
      "timeout",
      "La IA no respondió a tiempo, incluso después de reintentar. Vuelve a intentarlo en unos minutos.",
      { cause, retryable: true },
    );
  }
  if (error instanceof APIConnectionError) {
    return new AIError(
      "connection",
      "No se pudo conectar con el servicio de IA. Revisa la conexión a internet del servidor.",
      { cause, retryable: true },
    );
  }
  if (error instanceof APIUserAbortError) {
    return new AIError("connection", "La solicitud a la IA se canceló antes de terminar.", {
      cause,
      retryable: true,
    });
  }

  // Errores con estado HTTP.
  if (error instanceof AuthenticationError) {
    return new AIError(
      "auth",
      "La credencial de Anthropic no es válida o falta. Revisa ANTHROPIC_API_KEY en el servidor.",
      { cause, retryable: false },
    );
  }
  if (error instanceof PaymentRequiredError) {
    return new AIError(
      "permission",
      "La cuenta de Anthropic tiene un problema de facturación; el análisis con IA no está disponible.",
      { cause, retryable: false },
    );
  }
  if (error instanceof PermissionDeniedError) {
    return new AIError(
      "permission",
      "La cuenta de Anthropic no tiene permiso para esta operación o este modelo.",
      { cause, retryable: false },
    );
  }
  if (error instanceof NotFoundError) {
    return new AIError(
      "not_found",
      `El modelo configurado (${ctx.model}) no existe o no está disponible para esta cuenta. Revisa VIGIA_AI_MODEL.`,
      { cause, retryable: false },
    );
  }
  if (error instanceof RateLimitError) {
    // El tope de gasto mensual también es 429, pero reintentar no sirve.
    if (error.errorCode === "enforced_spend_limit_reached") {
      return new AIError(
        "rate_limit",
        "Se alcanzó el tope de gasto de la cuenta de Anthropic; el análisis con IA queda detenido hasta que se libere.",
        { cause, retryable: false },
      );
    }
    return new AIError(
      "rate_limit",
      "Se superó el límite de solicitudes a la IA. Vuelve a intentarlo en un momento.",
      { cause, retryable: true },
    );
  }
  if (error instanceof RequestTimeoutError || error instanceof GatewayTimeoutError) {
    return new AIError(
      "timeout",
      "El servicio de IA tardó demasiado en responder. Vuelve a intentarlo.",
      { cause, retryable: true },
    );
  }
  if (error instanceof ContentTooLargeError || error instanceof RequestHeaderFieldsTooLargeError) {
    return new AIError(
      "bad_request",
      "La solicitud a la IA es demasiado grande (imágenes o texto). Reduce la cantidad de fotogramas.",
      { cause, retryable: false },
    );
  }
  if (error instanceof BadRequestError || error instanceof UnprocessableEntityError) {
    return new AIError(
      "bad_request",
      "La IA rechazó la solicitud por inválida. Es un problema de configuración del servidor; revisa los registros.",
      { cause, retryable: false },
    );
  }
  if (error instanceof OverloadedError) {
    return new AIError(
      "overloaded",
      "El servicio de IA está saturado en este momento. Vuelve a intentarlo en unos minutos.",
      { cause, retryable: true },
    );
  }
  if (error instanceof ServiceUnavailableError) {
    return new AIError(
      "api",
      "El servicio de IA no está disponible por ahora. Vuelve a intentarlo en unos minutos.",
      { cause, retryable: true },
    );
  }
  if (error instanceof InternalServerError) {
    return new AIError("api", "El servicio de IA tuvo un error interno. Vuelve a intentarlo.", {
      cause,
      retryable: true,
    });
  }
  if (error instanceof APIError) {
    const status = typeof error.status === "number" ? error.status : null;
    return new AIError(
      "api",
      `El servicio de IA respondió con un error${status ? ` (HTTP ${status})` : ""}.`,
      { cause, retryable: status === null || status === 409 || status >= 500 },
    );
  }
  if (error instanceof AnthropicError) {
    return new AIError(
      "api",
      "No se pudo preparar la solicitud a la IA. Revisa la configuración de credenciales del servidor.",
      { cause, retryable: false },
    );
  }
  return new AIError("api", "Error inesperado al llamar a la IA. Revisa la credencial de Anthropic y los registros del servidor.", {
    cause,
    retryable: false,
  });
}

/* ═══════════════════════════ Contenido y solicitud ═══════════════════════════ */

/** Traduce el contenido neutral a bloques del SDK (imágenes base64 con su media_type real). */
export function toSdkContent(content: UserContent): BetaContentBlockParam[] {
  const blocks: BetaContentBlockParam[] = [];
  for (const block of content) {
    if (block.type === "text") {
      // La API rechaza bloques de texto vacíos.
      if (block.text.trim() === "") continue;
      blocks.push({ type: "text", text: block.text });
    } else {
      if (!isImageMediaType(block.media_type)) {
        throw new AIError("bad_request", `Formato de imagen no soportado por la IA: ${String(block.media_type)}.`);
      }
      if (block.base64 === "") {
        throw new AIError("bad_request", "Un fotograma llegó vacío; no se puede enviar a la IA.");
      }
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: block.media_type, data: block.base64 },
      });
    }
  }
  if (blocks.length === 0) {
    throw new AIError("bad_request", "No hay contenido para enviar a la IA.");
  }
  return blocks;
}

export const FALLBACK_BETA = "server-side-fallback-2026-07-01";
/** El mismo beta que agrega `beta.messages.parse()` del SDK para salida estructurada. */
export const STRUCTURED_OUTPUTS_BETA = "structured-outputs-2025-12-15";
export const DEFAULT_MAX_TOKENS = 16_000;
const REQUEST_TIMEOUT_MS = 180_000;
const MAX_RETRIES = 2;

export interface ModelSettings {
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  fast: boolean;
  /** Respaldo del servidor ante un rechazo por política. Por defecto sí; Haiku no lo ofrece. */
  fallback?: boolean;
}

// El JSON Schema se genera una vez por esquema: bytes idénticos entre llamadas
// (la API cachea el esquema compilado) y sin costo repetido de conversión.
const formatCache = new WeakMap<z.ZodType, BetaJSONOutputFormat>();

export function outputFormatFor(schema: z.ZodType): BetaJSONOutputFormat {
  let format = formatCache.get(schema);
  if (!format) {
    const helper = betaZodOutputFormat(schema);
    // Solo lo que va por la red; la validación la hacemos nosotros (ver arriba).
    format = { type: helper.type, schema: helper.schema };
    formatCache.set(schema, format);
  }
  return format;
}

/**
 * "structured": la API garantiza el JSON con output_config.format.
 * "prompt": el esquema viaja en el prompt de sistema y validamos nosotros.
 */
export type OutputMode = "structured" | "prompt";

const promptSystemCache = new Map<string, string>();

/** Prompt de sistema del modo prompt: el original + el JSON Schema. Estable por esquema (cacheable). */
export function promptModeSystem(system: string, schema: z.ZodType): string {
  const schemaJson = JSON.stringify(outputFormatFor(schema).schema);
  const key = `${system}\u0000${schemaJson}`;
  let out = promptSystemCache.get(key);
  if (!out) {
    out = `${system}

FORMATO DE SALIDA (obligatorio)
Responde SOLO con un objeto JSON válido que cumpla exactamente este JSON Schema: sin texto antes ni después, sin markdown ni bloques de código. Incluye TODAS las propiedades (todas son obligatorias), en el mismo orden; usa solo los valores de enum listados; los números van como números. Las "description" del esquema explican cada campo.
${schemaJson}`;
    promptSystemCache.set(key, out);
  }
  return out;
}

export function buildRequestParams(
  opts: { system: string; content: UserContent; schema: z.ZodType; maxTokens?: number },
  settings: ModelSettings,
  mode: OutputMode = "structured",
): MessageCreateParamsNonStreaming {
  const structured = mode === "structured";
  const params: MessageCreateParamsNonStreaming = {
    model: settings.model,
    max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    system: [
      {
        type: "text",
        text: structured ? opts.system : promptModeSystem(opts.system, opts.schema),
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: toSdkContent(opts.content) }],
    output_config: structured
      ? { effort: settings.effort, format: outputFormatFor(opts.schema) }
      : { effort: settings.effort },
  };
  const fallback = settings.fallback !== false;
  const betas = [...(fallback ? [FALLBACK_BETA] : []), ...(structured ? [STRUCTURED_OUTPUTS_BETA] : [])];
  if (betas.length > 0) params.betas = betas;
  if (fallback) params.fallbacks = "default";
  if (settings.fast) params.speed = "fast";
  return params;
}

/* ═══════════════════ Normalización del modo prompt (pura) ═══════════════════ */

type JsonSchemaNode = {
  $ref?: string;
  type?: string;
  enum?: unknown[];
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode;
  description?: string;
};

/** Extrae el objeto JSON de un texto que puede traer cercos de código o texto alrededor. */
export function extractJsonObject(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return text.trim();
  return text.slice(start, end + 1);
}

/**
 * Ajusta un valor al JSON Schema solo con rellenos que no cambian el sentido:
 * texto faltante → "", lista faltante → [], número escrito como texto → número,
 * enum con otra capitalización → el valor canónico y enum faltante o inválido →
 * "unknown" solo si el enum lo tiene. Nunca inventa booleanos, conteos ni
 * estados de víctimas: si faltan, la validación falla y se pide corrección.
 */
export function normalizeToJsonSchema(value: unknown, root: unknown, filled?: string[]): unknown {
  const rootNode = root as JsonSchemaNode & { $defs?: Record<string, JsonSchemaNode> };
  const defs = rootNode.$defs ?? {};
  const resolve = (node: JsonSchemaNode): JsonSchemaNode => {
    let n = node;
    for (let guard = 0; n.$ref && guard < 8; guard++) {
      const name = n.$ref.replace(/^#\/\$defs\//, "");
      n = defs[name] ?? {};
    }
    return n;
  };
  const walk = (v: unknown, raw: JsonSchemaNode, path: string): unknown => {
    const node = resolve(raw);
    if (node.enum) {
      const options = node.enum.filter((o): o is string => typeof o === "string");
      if (typeof v === "string") {
        if (options.includes(v)) return v;
        const canon = v.trim().toLowerCase().replace(/[\s-]+/g, "_");
        const match = options.find((o) => o.toLowerCase() === canon);
        if (match) return match;
      }
      return options.includes("unknown") ? "unknown" : v;
    }
    switch (node.type) {
      case "object": {
        const src = v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
        const out: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(node.properties ?? {})) {
          const childPath = path ? `${path}.${key}` : key;
          if (src[key] === undefined || src[key] === null) filled?.push(childPath);
          const next = walk(src[key], child, childPath);
          if (next !== undefined) out[key] = next;
        }
        return out;
      }
      case "array":
        if (!Array.isArray(v)) return v === undefined || v === null ? [] : v;
        return node.items ? v.map((item, i) => walk(item, node.items as JsonSchemaNode, `${path}[${i}]`)) : v;
      case "string":
        if (typeof v === "string") return v;
        if (typeof v === "number" || typeof v === "boolean") return String(v);
        return v === undefined || v === null ? "" : v;
      case "number":
      case "integer":
        if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
        return v === null ? undefined : v;
      case "boolean":
        if (v === "true") return true;
        if (v === "false") return false;
        return v === null ? undefined : v;
      default:
        return v;
    }
  };
  return walk(value, rootNode, "");
}

/** Resumen corto de los problemas de validación para pedir la corrección al modelo. */
export function describeIssues(error: z.ZodError, max = 12): string {
  return error.issues
    .slice(0, max)
    .map((issue) => `- ${issue.path.join(".") || "(raíz)"}: ${issue.message}`)
    .join("\n");
}

/* ═══════════════════════════════ Respuesta ═══════════════════════════════ */

/**
 * Texto final de la respuesta. Si hubo respaldo, solo cuenta lo posterior al
 * último bloque `fallback` (lo anterior es del modelo que declinó).
 */
export function extractFinalText(content: readonly BetaContentBlock[]): string {
  let start = 0;
  content.forEach((block, i) => {
    if (block.type === "fallback") start = i + 1;
  });
  return content
    .slice(start)
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
}

/** Revisa stop_reason ANTES de leer el contenido y valida el JSON con el esquema. */
export function readStructuredOutput<S extends z.ZodType>(
  message: BetaMessage,
  schema: S,
  mode: OutputMode = "structured",
): z.infer<S> {
  switch (message.stop_reason) {
    case "end_turn":
      break;
    case "refusal":
      throw new AIError("refusal", REFUSAL_MESSAGE, { retryable: false });
    case "max_tokens":
      throw new AIError(
        "max_tokens",
        "La respuesta de la IA quedó incompleta porque alcanzó el límite de largo. Vuelve a intentarlo; si se repite, reduce la cantidad de fotogramas o de texto.",
        { retryable: false },
      );
    case "model_context_window_exceeded":
      throw new AIError(
        "max_tokens",
        "La entrada es demasiado grande para el modelo (se llenó su ventana de contexto). Reduce la cantidad de fotogramas o de texto.",
        { retryable: false },
      );
    default:
      throw new AIError(
        "invalid_output",
        `La IA terminó de forma inesperada (${message.stop_reason ?? "sin motivo"}); no entregó un resultado.`,
      );
  }

  const text = extractFinalText(message.content).trim();
  if (text === "") {
    throw new AIError("invalid_output", "La IA no entregó un resultado.");
  }
  let json: unknown;
  try {
    json = JSON.parse(mode === "prompt" ? extractJsonObject(text) : text);
  } catch (cause) {
    throw new AIError("invalid_output", "La respuesta de la IA no es JSON válido.", { cause });
  }
  if (mode === "prompt") {
    const filled: string[] = [];
    json = normalizeToJsonSchema(json, outputFormatFor(schema).schema, filled);
    // Solo rutas (nunca contenido): sirve para detectar campos que el modelo omite.
    if (filled.length > 0) console.warn("[vigia-ia] campos ausentes en la salida", { paths: filled.slice(0, 20) });
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new AIError("invalid_output", "La respuesta de la IA no cumple el formato esperado.", {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

/** Datos de uso para el registro. Nunca incluye contenido. */
export function usageLog(
  task: AITask,
  requestedModel: string,
  message: BetaMessage,
  durationMs: number,
  mode: OutputMode = "structured",
) {
  const u = message.usage;
  const fallbackUsed = (u.iterations ?? []).some((entry) => entry.type === "fallback_message");
  return {
    task,
    output_mode: mode,
    model: message.model,
    requested_model: requestedModel,
    fallback_used: fallbackUsed,
    stop_reason: message.stop_reason,
    input_tokens: u.input_tokens,
    output_tokens: u.output_tokens,
    cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
    speed: u.speed,
    duration_ms: durationMs,
  };
}

/* ═══════════════════════════════ Llamada ═══════════════════════════════ */

/** Lo mínimo que necesitamos del SDK (permite probar con un transporte falso). */
export interface MessagesTransport {
  create(params: MessageCreateParamsNonStreaming): PromiseLike<BetaMessage>;
}

export interface CallStructuredOptions<S extends z.ZodType> {
  task: AITask;
  system: string;
  content: UserContent;
  schema: S;
  maxTokens?: number;
  /**
   * Modo inicial. "prompt" evita el intento con salida estructurada para
   * esquemas que se sabe que superan el límite de gramática (ese 400 tarda
   * 1 a 7 s). Por defecto "structured", con paso automático a "prompt" ante un 400.
   */
  mode?: OutputMode;
}

type GlobalWithAnthropic = typeof globalThis & { __vigiaAnthropic?: Anthropic };

/** Cliente único (sobrevive a la recarga en desarrollo). Credenciales desde el entorno por defecto del SDK. */
function getClient(): Anthropic {
  const g = globalThis as GlobalWithAnthropic;
  g.__vigiaAnthropic ??= new Anthropic({ timeout: REQUEST_TIMEOUT_MS, maxRetries: MAX_RETRIES });
  return g.__vigiaAnthropic;
}

const sdkTransport: MessagesTransport = {
  create: (params) => getClient().beta.messages.create(params),
};

type GlobalWithGrammarMemo = typeof globalThis & { __vigiaGrammarRejected?: Set<string> };

/** Esquemas cuya gramática la API rechazó (clave = JSON Schema serializado; sobrevive a la recarga en desarrollo). */
function grammarRejected(): Set<string> {
  const g = globalThis as GlobalWithGrammarMemo;
  g.__vigiaGrammarRejected ??= new Set<string>();
  return g.__vigiaGrammarRejected;
}

function schemaKey(schema: z.ZodType): string {
  return JSON.stringify(outputFormatFor(schema).schema);
}

/** Olvida los esquemas recordados como rechazados (para pruebas). */
export function resetOutputModeMemo(): void {
  grammarRejected().clear();
}

/** Una solicitud HTTP a la API; su duración, modelo y tokens quedan en el registro de la vista técnica. */
async function timedCreate(
  transport: MessagesTransport,
  params: MessageCreateParamsNonStreaming,
  task: AITask,
): Promise<BetaMessage> {
  const call = { task, model: params.model, fast: params.speed === "fast", startedAt: Date.now() };
  try {
    const message = await transport.create(params);
    recordClaudeCall(call, { message });
    return message;
  } catch (error) {
    recordClaudeCall(call, { error });
    throw error;
  }
}

/** Una solicitud a la API, con el reintento a velocidad normal si se agota el modo rápido. */
async function sendOnce(
  transport: MessagesTransport,
  params: MessageCreateParamsNonStreaming,
  task: AITask,
): Promise<BetaMessage> {
  try {
    return await timedCreate(transport, params, task);
  } catch (error) {
    // El modo rápido tiene su propio límite: si se agota, se sigue a velocidad normal.
    if (params.speed === "fast" && error instanceof RateLimitError) {
      console.warn("[vigia-ia] límite del modo rápido; reintento a velocidad normal", { task });
      const standard: MessageCreateParamsNonStreaming = { ...params };
      delete standard.speed;
      return timedCreate(transport, standard, task);
    }
    throw error;
  }
}

function logFailure(task: AITask, model: string, mode: OutputMode, error: unknown, mapped: AIError, started: number) {
  console.warn("[vigia-ia] llamada fallida", {
    task,
    model,
    output_mode: mode,
    code: mapped.code,
    status: error instanceof APIError ? error.status : undefined,
    request_id: error instanceof APIError ? error.requestID : undefined,
    duration_ms: Date.now() - started,
  });
}

/** Igual que callStructured pero con transporte y ajustes explícitos (para pruebas). */
export async function callStructuredWith<S extends z.ZodType>(
  transport: MessagesTransport,
  settings: ModelSettings,
  opts: CallStructuredOptions<S>,
): Promise<z.infer<S>> {
  const key = schemaKey(opts.schema);
  let mode: OutputMode = opts.mode === "prompt" || grammarRejected().has(key) ? "prompt" : "structured";
  let params = buildRequestParams(opts, settings, mode);
  let started = Date.now();
  let message: BetaMessage;
  try {
    message = await sendOnce(transport, params, opts.task);
  } catch (error) {
    const mapped = mapSdkError(error, { model: settings.model });
    logFailure(opts.task, settings.model, mode, error, mapped, started);
    // Un 400 con salida estructurada suele ser la gramática demasiado grande: se reintenta en modo prompt.
    if (mode !== "structured" || !(error instanceof BadRequestError)) throw mapped;
    mode = "prompt";
    params = buildRequestParams(opts, settings, mode);
    started = Date.now();
    try {
      message = await sendOnce(transport, params, opts.task);
    } catch (retryError) {
      const retryMapped = mapSdkError(retryError, { model: settings.model });
      logFailure(opts.task, settings.model, mode, retryError, retryMapped, started);
      throw retryMapped;
    }
    grammarRejected().add(key);
    console.info("[vigia-ia] esquema demasiado grande para salida estructurada; se usa el modo prompt", {
      task: opts.task,
    });
  }

  console.info("[vigia-ia] uso", usageLog(opts.task, settings.model, message, Date.now() - started, mode));
  if (message.stop_reason === "refusal") {
    console.warn("[vigia-ia] el modelo declinó", {
      task: opts.task,
      category: message.stop_details?.category ?? null,
    });
  }
  try {
    return readStructuredOutput(message, opts.schema, mode);
  } catch (error) {
    // En modo prompt la salida no está garantizada: se pide una sola corrección con los problemas.
    if (mode !== "prompt" || !(error instanceof AIError) || error.code !== "invalid_output") throw error;
    const previous = extractFinalText(message.content).trim();
    const cause = error.cause;
    const issues =
      cause !== null && typeof cause === "object" && "issues" in cause && Array.isArray(cause.issues)
        ? describeIssues(cause as z.ZodError)
        : "- La respuesta no es un objeto JSON válido.";
    console.warn("[vigia-ia] salida fuera de esquema; se pide corrección", { task: opts.task });
    const repair: MessageCreateParamsNonStreaming = {
      ...params,
      messages: [
        ...params.messages,
        { role: "assistant", content: previous === "" ? "{}" : previous },
        {
          role: "user",
          content: `Tu respuesta no cumple el esquema:\n${issues}\nResponde de nuevo SOLO con el objeto JSON completo y corregido, sin texto adicional.`,
        },
      ],
    };
    const repairStarted = Date.now();
    let fixed: BetaMessage;
    try {
      fixed = await sendOnce(transport, repair, opts.task);
    } catch (repairError) {
      const mapped = mapSdkError(repairError, { model: settings.model });
      logFailure(opts.task, settings.model, mode, repairError, mapped, repairStarted);
      throw mapped;
    }
    console.info("[vigia-ia] uso", usageLog(opts.task, settings.model, fixed, Date.now() - repairStarted, mode));
    return readStructuredOutput(fixed, opts.schema, mode);
  }
}

/**
 * Llama a Claude con un prompt de sistema estable y contenido de usuario, y
 * devuelve la salida validada con `schema`. Lanza siempre AIError.
 */
export function callStructured<S extends z.ZodType>(
  opts: CallStructuredOptions<S>,
  settings?: ModelSettings,
): Promise<z.infer<S>> {
  return callStructuredWith(
    sdkTransport,
    settings ?? { model: config.aiModel, effort: config.aiEffort, fast: config.aiFast },
    opts,
  );
}
