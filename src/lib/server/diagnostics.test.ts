/**
 * Registro en memoria de la vista técnica.
 *   node --import tsx --test src/lib/server/diagnostics.test.ts
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import {
  getAgentTurns,
  listClaudeCalls,
  listServerErrors,
  MAX_CLAUDE_CALLS,
  mergeRemoteErrors,
  MAX_SERVER_ERRORS,
  noteAgentTurn,
  noteRouteFailure,
  recordClaudeCall,
  recordServerError,
  resetDiagnostics,
  routeErrorSource,
  scrubText,
  shouldRecordRouteFailure,
} from "./diagnostics";

const T0 = Date.parse("2026-11-21T18:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

beforeEach(() => resetDiagnostics());

test("scrubText quita parámetros de URL, tokens, llaves y credenciales", () => {
  const out = scrubText(
    "GET https://storage.googleapis.com/b/o.mp4?X-Goog-Signature=abc&k=SECRETO falló; Bearer abc.def.ghi; sk-ant-api03-XYZ; postgresql://vigia:clave123@/db; token=abcd; xi-api-key: zzz",
  );
  assert.doesNotMatch(out, /X-Goog-Signature|SECRETO|abc\.def|api03|clave123|abcd|zzz/);
  assert.match(out, /https:\/\/storage\.googleapis\.com\/b\/o\.mp4\?…/);
  assert.match(out, /Bearer …/);
  assert.match(out, /sk-ant-…/);
  assert.match(out, /postgresql:\/\/…@/);
  // Las rutas con ids se conservan (no parecen tokens).
  assert.match(scrubText("incidents/0f8c2c8e-1d2a-4f3b-9c7e-123456789abc/media/m1"), /0f8c2c8e-1d2a/);
  assert.equal(scrubText("x".repeat(10) + " " + "y".repeat(500)).length <= 300, true);
});

test("recordClaudeCall guarda modelo, duración y tokens; los errores con su status", () => {
  recordClaudeCall(
    { task: "media", model: "claude-opus-5-5", fast: false, startedAt: T0, endedAt: T0 + 2100 },
    {
      message: {
        model: "claude-opus-5-5",
        stop_reason: "end_turn",
        usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 900, iterations: [{ type: "fallback_message" }] },
      },
    },
  );
  const err = Object.assign(new Error("429 rate_limit_error"), { status: 429, name: "RateLimitError" });
  recordClaudeCall({ task: "agente", model: "claude-opus-5-5", fast: true, startedAt: T0 + 3000, endedAt: T0 + 3500, incidentId: "i1", incidentCode: "VG-AB12" }, { error: err });
  const [last, first] = listClaudeCalls();
  assert.equal(last.ok, false);
  assert.equal(last.status, 429);
  assert.equal(last.ms, 500);
  assert.equal(last.fast, true);
  assert.equal(last.incident_code, "VG-AB12");
  assert.match(last.error ?? "", /RateLimitError: 429/);
  assert.equal(first.ok, true);
  assert.equal(first.ms, 2100);
  assert.equal(first.input_tokens, 1200);
  assert.equal(first.cache_read_tokens, 900);
  assert.equal(first.fallback, true);
  assert.equal(first.at, new Date(T0).toISOString());
});

test("el registro de llamadas está acotado", () => {
  for (let i = 0; i < MAX_CLAUDE_CALLS + 7; i++) {
    recordClaudeCall({ task: "live", model: "m", fast: false, startedAt: T0 + i, endedAt: T0 + i + 1 }, { message: {} });
  }
  const calls = listClaudeCalls();
  assert.equal(calls.length, MAX_CLAUDE_CALLS);
  assert.equal(calls[0].at, new Date(T0 + MAX_CLAUDE_CALLS + 6).toISOString());
});

test("recordServerError agrupa los repetidos y se acota", () => {
  recordServerError("puente", "Zello rechazó el token", { now: T0 });
  recordServerError("puente", "Zello rechazó el token", { now: T0 + 10_000 });
  recordServerError("agente", new Error("boom"), { now: T0 + 20_000, incidentId: "i1", context: "Vuelta fallida" });
  const [agent, bridge] = listServerErrors();
  assert.equal(agent.message, "Vuelta fallida: boom");
  assert.equal(agent.incident_id, "i1");
  assert.equal(bridge.count, 2);
  assert.equal(bridge.first_at, new Date(T0).toISOString());
  assert.equal(bridge.at, new Date(T0 + 10_000).toISOString());
  // Pasada la ventana, el mismo error vuelve a ser una fila nueva.
  recordServerError("puente", "Zello rechazó el token", { now: T0 + 11 * 60_000 });
  assert.equal(listServerErrors().filter((e) => e.source === "puente").length, 2);
  for (let i = 0; i < MAX_SERVER_ERRORS + 5; i++) recordServerError("api", `error ${i}`, { now: T0 + i });
  assert.equal(listServerErrors().length, MAX_SERVER_ERRORS);
});

test("origen y política de los errores de las rutas /api", () => {
  assert.equal(routeErrorSource("/api/zello/status", true), "puente");
  assert.equal(routeErrorSource("/api/incidents/abc/comms/audio", false), "subida");
  assert.equal(routeErrorSource("/api/incidents/abc/comms/audio", true), "puente");
  assert.equal(routeErrorSource("/api/incidents/abc/vigia/salida", true), "puente");
  assert.equal(routeErrorSource("/api/public/reports/m1/complete", false), "subida");
  assert.equal(routeErrorSource("/api/local-upload/incidents/a/b.mp4", false), "subida");
  assert.equal(routeErrorSource("/api/drone/m1/frame", true), "dron");
  assert.equal(routeErrorSource("/api/incidents/abc/vigia", false), "agente");
  assert.equal(routeErrorSource("/api/incidents/abc", false), "api");

  const get = { bearer: false, method: "GET" };
  assert.equal(shouldRecordRouteFailure("api", 500, get), true);
  assert.equal(shouldRecordRouteFailure("api", 400, get), false);
  assert.equal(shouldRecordRouteFailure("subida", 413, { bearer: false, method: "PUT" }), true);
  assert.equal(shouldRecordRouteFailure("subida", 401, { bearer: false, method: "POST" }), false);
  assert.equal(shouldRecordRouteFailure("subida", 404, { bearer: false, method: "POST" }), false);
  // La mesa leyendo el estado de Zello con la sesión vencida no es un error del puente.
  assert.equal(shouldRecordRouteFailure("puente", 401, get), false);
  assert.equal(shouldRecordRouteFailure("puente", 401, { bearer: false, method: "POST" }), true);
  assert.equal(shouldRecordRouteFailure("puente", 403, { bearer: true, method: "POST" }), true);
  assert.equal(shouldRecordRouteFailure("dron", 409, { bearer: true, method: "POST" }), false);
  assert.equal(shouldRecordRouteFailure("dron", 401, { bearer: true, method: "POST" }), true);
});

test("noteRouteFailure registra con la emergencia de la ruta y sin el token", () => {
  const req = new Request("http://x/api/incidents/0f8c2c8e-1d2a-4f3b-9c7e-123456789abc/comms/audio?sig=zzz", {
    method: "POST",
    headers: { authorization: "Bearer el-token-del-puente" },
  });
  noteRouteFailure(req, 403, Object.assign(new Error("Token del puente inválido."), { status: 403 }));
  const [e] = listServerErrors();
  assert.equal(e.source, "puente");
  assert.equal(e.incident_id, "0f8c2c8e-1d2a-4f3b-9c7e-123456789abc");
  assert.match(e.message, /^POST \/api\/incidents\/0f8c2c8e…\/comms\/audio → 403: Token del puente inválido\.$/);
  assert.doesNotMatch(e.message, /el-token|zzz/);
  // Una lectura del mando con la sesión vencida no queda.
  noteRouteFailure(new Request("http://x/api/incidents/abc"), 401, new Error("Debes iniciar sesión."));
  assert.equal(listServerErrors().length, 1);
});

test("noteAgentTurn recuerda la última vuelta y la última en que pensó", () => {
  noteAgentTurn("i1", { at: "2026-11-21T18:00:00.000Z", ms: 3200, thought: true, engine: "claude", events: ["radio"] });
  noteAgentTurn("i1", { at: "2026-11-21T18:00:05.000Z", ms: 4, thought: false, engine: null, events: [] });
  const t = getAgentTurns("i1");
  assert.equal(t.last?.at, "2026-11-21T18:00:05.000Z");
  assert.equal(t.thought?.ms, 3200);
  assert.deepEqual(getAgentTurns("otra"), { last: null, thought: null });
});

test("mergeRemoteErrors reemplaza (no suma) lo que el puente repite en cada latido", () => {
  recordServerError("agente", "boom", { now: T0 + 30_000 });
  const remote = { at: iso(T0 + 10_000), first_at: iso(T0), count: 2, source: "transcripcion" as const, message: "ElevenLabs respondió 401: token=abc" };
  mergeRemoteErrors([remote]);
  mergeRemoteErrors([remote]);
  mergeRemoteErrors([{ ...remote, at: iso(T0 + 20_000), count: 3 }]);
  const list = listServerErrors();
  const stt = list.filter((e) => e.source === "transcripcion");
  assert.equal(stt.length, 1);
  assert.equal(stt[0].count, 3);
  assert.equal(stt[0].first_at, iso(T0));
  assert.doesNotMatch(stt[0].message, /abc/);
  // Ordenado por hora: el error del agente (más nuevo) sigue primero.
  assert.equal(list[0].source, "agente");
});
