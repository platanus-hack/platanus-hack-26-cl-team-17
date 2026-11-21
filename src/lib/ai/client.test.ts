import { test } from "node:test";
import assert from "node:assert/strict";
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  AuthenticationError,
  BadRequestError,
  ContentTooLargeError,
  InternalServerError,
  NotFoundError,
  OverloadedError,
  PermissionDeniedError,
  RateLimitError,
} from "@anthropic-ai/sdk";
import type {
  BetaContentBlock,
  BetaMessage,
  BetaStopReason,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { z } from "zod";
import { CommsAnalysisAISchema } from "@/lib/domain";
import {
  AIError,
  DEFAULT_MAX_TOKENS,
  FALLBACK_BETA,
  REFUSAL_MESSAGE,
  buildRequestParams,
  callStructuredWith,
  extractFinalText,
  mapSdkError,
  normalizeToJsonSchema,
  outputFormatFor,
  readStructuredOutput,
  resetOutputModeMemo,
  toSdkContent,
  type MessagesTransport,
  type ModelSettings,
} from "./client";

const Small = z.object({ ok: z.boolean(), note: z.string() });
const SETTINGS: ModelSettings = { model: "claude-opus-5-5", effort: "medium", fast: false };

function fakeMessage(
  stop: BetaStopReason | null,
  content: BetaContentBlock[],
  extra: Partial<BetaMessage> = {},
): BetaMessage {
  return {
    id: "msg_test",
    container: null,
    content,
    context_management: null,
    diagnostics: null,
    model: "claude-opus-5-5",
    role: "assistant",
    stop_details: null,
    stop_reason: stop,
    stop_sequence: null,
    type: "message",
    usage: {
      cache_creation: null,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 1200,
      fallback_credit: null,
      inference_geo: null,
      input_tokens: 300,
      iterations: null,
      output_tokens: 80,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: "standard",
      speed: "standard",
    },
    ...extra,
  };
}

function text(t: string): BetaContentBlock {
  return { type: "text", text: t, citations: null };
}

const headers = () => new Headers();

async function captureConsole<T>(fn: () => Promise<T>): Promise<{ result: T | AIError; logs: string[] }> {
  const logs: string[] = [];
  const origInfo = console.info;
  const origWarn = console.warn;
  console.info = (...args: unknown[]) => void logs.push(JSON.stringify(args));
  console.warn = (...args: unknown[]) => void logs.push(JSON.stringify(args));
  try {
    try {
      return { result: await fn(), logs };
    } catch (e) {
      assert.ok(e instanceof AIError, "solo debe lanzar AIError");
      return { result: e, logs };
    }
  } finally {
    console.info = origInfo;
    console.warn = origWarn;
  }
}

/* ─────────────── contenido ─────────────── */

test("toSdkContent convierte texto e imágenes base64 con su media_type real", () => {
  const blocks = toSdkContent([
    { type: "text", text: "Fotograma 0 · t=1.5s" },
    { type: "image", media_type: "image/webp", base64: "QUJD" },
    { type: "text", text: "   " },
    { type: "text", text: "Pregunta" },
  ]);
  assert.deepEqual(blocks, [
    { type: "text", text: "Fotograma 0 · t=1.5s" },
    { type: "image", source: { type: "base64", media_type: "image/webp", data: "QUJD" } },
    { type: "text", text: "Pregunta" },
  ]);
});

test("toSdkContent rechaza contenido vacío o imágenes inválidas", () => {
  assert.throws(() => toSdkContent([]), (e) => e instanceof AIError && e.code === "bad_request");
  assert.throws(
    () => toSdkContent([{ type: "image", media_type: "image/jpeg", base64: "" }]),
    (e) => e instanceof AIError && e.code === "bad_request",
  );
});

/* ─────────────── solicitud ─────────────── */

test("buildRequestParams: sin thinking ni temperatura, con effort, fallbacks y caché del sistema", () => {
  const p = buildRequestParams(
    { system: "SISTEMA", content: [{ type: "text", text: "hola" }], schema: Small },
    SETTINGS,
  );
  const raw = p as unknown as Record<string, unknown>;
  assert.equal("thinking" in raw, false);
  assert.equal("temperature" in raw, false);
  assert.equal("top_p" in raw, false);
  assert.equal("speed" in raw, false);
  assert.equal("stream" in raw, false);
  assert.equal(p.model, "claude-opus-5-5");
  assert.equal(p.max_tokens, DEFAULT_MAX_TOKENS);
  assert.equal(p.fallbacks, "default");
  assert.ok(p.betas?.includes(FALLBACK_BETA));
  assert.deepEqual(p.system, [{ type: "text", text: "SISTEMA", cache_control: { type: "ephemeral" } }]);
  assert.equal(p.messages.length, 1);
  assert.equal(p.messages[0].role, "user");
  assert.equal(p.output_config?.effort, "medium");
  const format = p.output_config?.format;
  assert.equal(format?.type, "json_schema");
  const schemaJson = JSON.stringify(format?.schema);
  assert.match(schemaJson, /"additionalProperties":false/);
  // Se serializa sin funciones (parse) y es estable entre llamadas.
  assert.equal(JSON.stringify(format), JSON.stringify(p.output_config?.format));
  const again = buildRequestParams(
    { system: "SISTEMA", content: [{ type: "text", text: "otra" }], schema: Small, maxTokens: 900 },
    { ...SETTINGS, fast: true, effort: "high" },
  );
  assert.equal(again.output_config?.format, format, "el formato se reutiliza por esquema");
  assert.equal(again.speed, "fast");
  assert.equal(again.max_tokens, 900);
  assert.equal(again.output_config?.effort, "high");
});

test("el esquema real de comunicaciones se convierte a JSON Schema", () => {
  const p = buildRequestParams(
    { system: "S", content: [{ type: "text", text: "x" }], schema: CommsAnalysisAISchema },
    SETTINGS,
  );
  const json = JSON.stringify(p.output_config?.format?.schema);
  assert.match(json, /denied_by_unit/);
  assert.doesNotMatch(json, /"minimum"|"maxLength"/);
});

/* ─────────────── respuesta ─────────────── */

test("refusal se detecta antes de leer el contenido", () => {
  const msg = fakeMessage("refusal", [text("{trunc")]);
  assert.throws(
    () => readStructuredOutput(msg, Small),
    (e) => e instanceof AIError && e.code === "refusal" && e.message === REFUSAL_MESSAGE && !e.retryable,
  );
});

test("max_tokens y ventana de contexto dan error max_tokens claro", () => {
  for (const stop of ["max_tokens", "model_context_window_exceeded"] as const) {
    assert.throws(
      () => readStructuredOutput(fakeMessage(stop, [text('{"ok": tr')]), Small),
      (e) => e instanceof AIError && e.code === "max_tokens" && /fotogramas/.test(e.message),
    );
  }
});

test("otros stop_reason y salidas inválidas → invalid_output", () => {
  assert.throws(
    () => readStructuredOutput(fakeMessage("pause_turn", []), Small),
    (e) => e instanceof AIError && e.code === "invalid_output",
  );
  assert.throws(
    () => readStructuredOutput(fakeMessage("end_turn", []), Small),
    (e) => e instanceof AIError && e.code === "invalid_output",
  );
  assert.throws(
    () => readStructuredOutput(fakeMessage("end_turn", [text("no es json")]), Small),
    (e) => e instanceof AIError && e.code === "invalid_output" && /JSON/.test(e.message),
  );
  assert.throws(
    () => readStructuredOutput(fakeMessage("end_turn", [text('{"ok":"si","note":1}')]), Small),
    (e) => e instanceof AIError && e.code === "invalid_output" && /formato/.test(e.message),
  );
});

test("salida válida se devuelve tipada; ignora thinking y lo previo a un fallback", () => {
  const content: BetaContentBlock[] = [
    { type: "thinking", thinking: "", signature: "sig" },
    text('{"ok":false,'),
    {
      type: "fallback",
      from: { model: "claude-opus-5-5" },
      to: { model: "claude-opus-4-8" },
      trigger: { type: "refusal", category: "cyber" },
    },
    text('{"ok":true,"note":"listo"}'),
  ];
  assert.equal(extractFinalText(content), '{"ok":true,"note":"listo"}');
  const out = readStructuredOutput(fakeMessage("end_turn", content), Small);
  assert.deepEqual(out, { ok: true, note: "listo" });
});

/* ─────────────── errores del SDK ─────────────── */

test("mapSdkError usa las clases tipadas, de la más específica a la más general", () => {
  const ctx = { model: "claude-opus-5-5" };
  const cases: Array<[unknown, string, boolean]> = [
    [new AuthenticationError(401, undefined, "x", headers()), "auth", false],
    [new PermissionDeniedError(403, undefined, "x", headers()), "permission", false],
    [new NotFoundError(404, undefined, "x", headers()), "not_found", false],
    [new RateLimitError(429, undefined, "x", headers()), "rate_limit", true],
    [new BadRequestError(400, undefined, "x", headers()), "bad_request", false],
    [new ContentTooLargeError(413, undefined, "x", headers()), "bad_request", false],
    [new OverloadedError(529, undefined, "x", headers()), "overloaded", true],
    [new InternalServerError(500, undefined, "x", headers()), "api", true],
    [new APIConnectionTimeoutError(), "timeout", true],
    [new APIConnectionError({ message: "x" }), "connection", true],
    [new Error("cualquier cosa"), "api", false],
  ];
  for (const [err, code, retryable] of cases) {
    const mapped = mapSdkError(err, ctx);
    assert.equal(mapped.code, code, `código para ${(err as Error).constructor.name}`);
    assert.equal(mapped.retryable, retryable, `reintentable para ${(err as Error).constructor.name}`);
    assert.equal(mapped.cause, err);
    assert.ok(mapped.message.length > 0);
  }
  assert.match(mapSdkError(new NotFoundError(404, undefined, "x", headers()), ctx).message, /claude-opus-5-5/);
});

test("429 por tope de gasto no es reintentable (por error_code, no por mensaje)", () => {
  const body = { type: "error", error: { type: "rate_limit_error", message: "m", details: { error_code: "enforced_spend_limit_reached" } } };
  const mapped = mapSdkError(new RateLimitError(429, body, "x", headers()), { model: "m" });
  assert.equal(mapped.code, "rate_limit");
  assert.equal(mapped.retryable, false);
});

test("AIError existente se propaga tal cual", () => {
  const e = new AIError("refusal", REFUSAL_MESSAGE);
  assert.equal(mapSdkError(e, { model: "m" }), e);
  assert.equal(e.retryable, false);
  assert.equal(new AIError("overloaded", "x").retryable, true);
  assert.equal(new AIError("overloaded", "x", { retryable: false }).retryable, false);
});

/* ─────────────── llamada completa con transporte falso ─────────────── */

function transport(
  handler: (p: MessageCreateParamsNonStreaming, n: number) => BetaMessage,
): MessagesTransport & { calls: MessageCreateParamsNonStreaming[] } {
  const calls: MessageCreateParamsNonStreaming[] = [];
  return {
    calls,
    create(p) {
      calls.push(p);
      try {
        return Promise.resolve(handler(p, calls.length));
      } catch (e) {
        return Promise.reject(e);
      }
    },
  };
}

const SECRET_NOTE = "nota-secreta-del-vecino";

test("callStructuredWith devuelve el resultado y registra uso sin contenido", async () => {
  const t = transport(() => fakeMessage("end_turn", [text('{"ok":true,"note":"bien"}')]));
  const { result, logs } = await captureConsole(() =>
    callStructuredWith(t, SETTINGS, {
      task: "media",
      system: "S",
      content: [{ type: "text", text: SECRET_NOTE }],
      schema: Small,
    }),
  );
  assert.deepEqual(result, { ok: true, note: "bien" });
  assert.equal(t.calls.length, 1);
  const joined = logs.join("\n");
  assert.match(joined, /"task":"media"/);
  assert.match(joined, /"cache_read_input_tokens":1200/);
  assert.match(joined, /"input_tokens":300/);
  assert.match(joined, /"stop_reason":"end_turn"/);
  assert.match(joined, /"duration_ms":\d+/);
  assert.doesNotMatch(joined, new RegExp(SECRET_NOTE));
  assert.doesNotMatch(joined, /bien/);
});

test("callStructuredWith: refusal → AIError refusal", async () => {
  const t = transport(() =>
    fakeMessage("refusal", [], {
      stop_details: {
        type: "refusal",
        category: "bio",
        explanation: null,
        fallback_credit_token: null,
        fallback_has_prefill_claim: null,
        recommended_model: null,
      },
    }),
  );
  const { result } = await captureConsole(() =>
    callStructuredWith(t, SETTINGS, { task: "comms", system: "S", content: [{ type: "text", text: "x" }], schema: Small }),
  );
  assert.ok(result instanceof AIError);
  assert.equal(result.code, "refusal");
});

test("callStructuredWith: error del SDK se traduce y no se filtra contenido al registro", async () => {
  const t = transport(() => {
    throw new OverloadedError(529, undefined, "overloaded", headers());
  });
  const { result, logs } = await captureConsole(() =>
    callStructuredWith(t, SETTINGS, {
      task: "situation",
      system: "S",
      content: [{ type: "text", text: SECRET_NOTE }],
      schema: Small,
    }),
  );
  assert.ok(result instanceof AIError);
  assert.equal(result.code, "overloaded");
  assert.equal(result.retryable, true);
  assert.doesNotMatch(logs.join("\n"), new RegExp(SECRET_NOTE));
});

test("modo rápido: si su límite se agota, reintenta una vez a velocidad normal", async () => {
  const t = transport((p, n) => {
    if (n === 1) {
      assert.equal(p.speed, "fast");
      throw new RateLimitError(429, undefined, "x", headers());
    }
    assert.equal("speed" in p, false);
    return fakeMessage("end_turn", [text('{"ok":true,"note":"normal"}')]);
  });
  const { result } = await captureConsole(() =>
    callStructuredWith(t, { ...SETTINGS, fast: true }, {
      task: "scene",
      system: "S",
      content: [{ type: "text", text: "x" }],
      schema: Small,
    }),
  );
  assert.deepEqual(result, { ok: true, note: "normal" });
  assert.equal(t.calls.length, 2);
});

/* ─────────────── modo prompt (esquemas que superan el límite de gramática) ─────────────── */

test("400 con salida estructurada → reintenta en modo prompt y lo recuerda para el esquema", async () => {
  resetOutputModeMemo();
  const Big = z.object({ ok: z.boolean(), note: z.string(), level: z.enum(["low", "unknown"]) });
  const t = transport((p, n) => {
    if (n === 1) {
      assert.ok(p.output_config?.format, "primer intento con salida estructurada");
      throw new BadRequestError(400, undefined, "compiled grammar is too large", headers());
    }
    assert.equal(p.output_config?.format, undefined, "modo prompt sin output_config.format");
    assert.equal(p.output_config?.effort, "medium");
    assert.equal(p.betas?.includes(FALLBACK_BETA), true);
    const system = (p.system as { text: string }[])[0].text;
    assert.match(system, /FORMATO DE SALIDA/);
    assert.match(system, /"level"/);
    return fakeMessage("end_turn", [text('Listo:\n```json\n{"ok":true,"note":"x","level":"LOW"}\n```')]);
  });
  const run = () =>
    captureConsole(() =>
      callStructuredWith(t, SETTINGS, { task: "media", system: "S", content: [{ type: "text", text: "x" }], schema: Big }),
    );
  const first = await run();
  assert.deepEqual(first.result, { ok: true, note: "x", level: "low" });
  assert.equal(t.calls.length, 2);
  const second = await run();
  assert.deepEqual(second.result, { ok: true, note: "x", level: "low" });
  assert.equal(t.calls.length, 3, "la segunda vez va directo en modo prompt");
  resetOutputModeMemo();
});

test("modo prompt: salida fuera de esquema → una sola corrección con los problemas", async () => {
  const t = transport((p, n) => {
    if (n === 1) return fakeMessage("end_turn", [text('{"note":"sin ok"}')]);
    assert.equal(p.messages.length, 3);
    assert.equal(p.messages[1].role, "assistant");
    const last = p.messages[2].content;
    assert.equal(typeof last, "string");
    assert.match(String(last), /ok/);
    return fakeMessage("end_turn", [text('{"ok":false,"note":"corregido"}')]);
  });
  const { result, logs } = await captureConsole(() =>
    callStructuredWith(t, SETTINGS, {
      task: "scene",
      system: "S",
      content: [{ type: "text", text: SECRET_NOTE }],
      schema: Small,
      mode: "prompt",
    }),
  );
  assert.deepEqual(result, { ok: false, note: "corregido" });
  assert.equal(t.calls.length, 2);
  assert.doesNotMatch(logs.join("\n"), new RegExp(SECRET_NOTE));
});

test("normalizeToJsonSchema rellena solo lo seguro: nunca inventa booleanos, números ni estados", () => {
  const S = z.object({
    flag: z.boolean(),
    count: z.number(),
    status: z.enum(["confirmed", "possible"]),
    kind: z.enum(["car", "unknown"]),
    list: z.array(z.string()),
    label: z.string(),
  });
  const filled: string[] = [];
  const out = normalizeToJsonSchema({ count: "3", kind: "Bus" }, outputFormatFor(S).schema, filled) as Record<string, unknown>;
  assert.equal(out.count, 3);
  assert.equal(out.kind, "unknown");
  assert.deepEqual(out.list, []);
  assert.equal(out.label, "");
  assert.equal("flag" in out, false);
  assert.equal(out.status, undefined);
  assert.equal(S.safeParse(out).success, false, "sin flag ni status debe fallar y pedir corrección");
  assert.deepEqual(filled.sort(), ["flag", "label", "list", "status"]);
});
