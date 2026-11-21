import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { api, ApiClientError, buildUrl, errorFromResponse, isUnchanged } from "@/lib/client/api";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Call {
  url: string;
  init: RequestInit;
}
function mockFetch(respond: (call: Call) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return calls;
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("buildUrl omite null/undefined/NaN y codifica valores", () => {
  assert.equal(buildUrl("/api/x"), "/api/x");
  assert.equal(buildUrl("/api/x", { a: undefined, b: null }), "/api/x");
  assert.equal(buildUrl("/api/x", { rev: 0 }), "/api/x?rev=0");
  assert.equal(buildUrl("/api/x", { k: "a b&c", n: Number.NaN }), "/api/x?k=a+b%26c");
  assert.equal(buildUrl("/api/x", { flush: true }), "/api/x?flush=1");
  assert.equal(buildUrl("/api/x", { flush: false }), "/api/x?flush=0");
  assert.equal(buildUrl("/api/x?a=1", { b: 2 }), "/api/x?a=1&b=2");
});

test("errorFromResponse usa el cuerpo ApiError cuando existe", async () => {
  const err = await errorFromResponse(json({ error: "Esta emergencia ya fue cerrada", code: "conflict" }, 409));
  assert.ok(err instanceof ApiClientError);
  assert.equal(err.status, 409);
  assert.equal(err.code, "conflict");
  assert.equal(err.message, "Esta emergencia ya fue cerrada");
});

test("errorFromResponse sin cuerpo JSON deduce el código por status", async () => {
  const e1 = await errorFromResponse(new Response("Bad Gateway", { status: 502 }));
  assert.equal(e1.code, "internal");
  assert.equal(e1.status, 502);
  const e2 = await errorFromResponse(new Response("", { status: 404 }));
  assert.equal(e2.code, "not_found");
});

test("incidents.get envía rev, no-store y same-origin", async () => {
  const calls = mockFetch(() => json({ unchanged: true, rev: 7, server_time: "x" }));
  const res = await api.incidents.get("abc/1", 7);
  assert.equal(calls[0].url, "/api/incidents/abc%2F1?rev=7");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.cache, "no-store");
  assert.equal(calls[0].init.credentials, "same-origin");
  assert.equal(calls[0].init.body, undefined);
  assert.ok(isUnchanged(res));
});

test("POST serializa JSON y completeReport manda x-upload-token", async () => {
  const calls = mockFetch(() => json({ ok: true }));
  await api.public.completeReport("m1", "tok", { part: "frames", ok: true });
  const h = calls[0].init.headers as Record<string, string>;
  assert.equal(calls[0].url, "/api/public/reports/m1/complete");
  assert.equal(h["x-upload-token"], "tok");
  assert.equal(h["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { part: "frames", ok: true });
});

test("briefing.get pasa la clave como k", async () => {
  const calls = mockFetch(() => json({ unchanged: true, rev: 1, server_time: "x" }));
  await api.briefing.get("i1", "s3cr3t", null);
  assert.equal(calls[0].url, "/api/briefing/i1?k=s3cr3t");
});

test("drone.frame envía el blob crudo con Bearer y parámetros", async () => {
  const calls = mockFetch(() => json({ ok: true, media_id: "m", frame_idx: 0, flushed: false, command: "continue" }));
  const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" });
  await api.drone.frame("d1", "T", blob, { lat: -33.4, lng: -70.6, alt: 40, flush: true });
  const h = calls[0].init.headers as Record<string, string>;
  assert.equal(calls[0].url, "/api/drone/d1/frame?lat=-33.4&lng=-70.6&alt=40&flush=1");
  assert.equal(h.Authorization, "Bearer T");
  assert.equal(h["Content-Type"], "image/jpeg");
  assert.equal(calls[0].init.body, blob);
});

test("public.nearby sin posición no llama al servidor", async () => {
  const calls = mockFetch(() => json({ incidents: [{}] }));
  const res = await api.public.nearby(null, null);
  assert.deepEqual(res, { incidents: [] });
  assert.equal(calls.length, 0);
});

test("errores de red y cancelación se tipan", async () => {
  mockFetch(() => {
    throw new TypeError("Failed to fetch");
  });
  await assert.rejects(api.status(), (e: unknown) => e instanceof ApiClientError && e.code === "network" && e.status === 0);
  mockFetch(() => {
    throw new DOMException("aborted", "AbortError");
  });
  await assert.rejects(api.status(), (e: unknown) => e instanceof ApiClientError && e.code === "aborted");
});

test("respuesta no exitosa con ApiError lanza ApiClientError", async () => {
  mockFetch(() => json({ error: "Debes iniciar sesión.", code: "unauthorized" }, 401));
  await assert.rejects(api.incidents.list(), (e: unknown) => e instanceof ApiClientError && e.status === 401 && e.code === "unauthorized");
});
