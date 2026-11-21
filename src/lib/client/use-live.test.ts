import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiClientError } from "@/lib/client/api";
import type { UnchangedResponse } from "@/lib/contract";
import {
  applyPoll,
  briefingKey,
  createLivenessStore,
  hasRev,
  isMissingBriefingKey,
  isStale,
  MISSING_BRIEFING_KEY_ERROR,
  msUntilStale,
  pollWithRev,
  retryDelayMs,
  revOf,
  snapshotKey,
  staleReference,
  toApiClientError,
  TRANSIENT_RETRY_CAP_MS,
  requestTimeoutMs,
  withTimeout,
} from "@/lib/client/live-core";

interface Snap {
  unchanged?: false;
  incident: { rev: number; id: string };
  label: string;
}
const snap = (rev: number, label = `r${rev}`): Snap => ({ incident: { rev, id: "a" }, label });
const unchanged = (rev: number): UnchangedResponse => ({
  unchanged: true,
  rev,
  server_time: "2026-11-21T00:00:00.000Z",
});

test("claves SWR incluyen id y clave, codificados; vacíos → null", () => {
  assert.equal(snapshotKey("abc"), "/api/incidents/abc");
  assert.equal(snapshotKey(" a/b "), "/api/incidents/a%2Fb");
  assert.equal(snapshotKey(null), null);
  assert.equal(snapshotKey("  "), null);
  assert.equal(briefingKey("abc", "k&1"), "/api/briefing/abc?k=k%261");
  assert.equal(briefingKey("abc", null), null);
  assert.equal(briefingKey(null, "k"), null);
  assert.equal(briefingKey("abc", ""), null);
  assert.notEqual(briefingKey("a", "k1"), briefingKey("a", "k2"));
  assert.notEqual(snapshotKey("a"), snapshotKey("b"));
});

test("applyPoll: sin cambios con mismo rev devuelve la misma identidad", () => {
  const prev = snap(4);
  assert.equal(applyPoll(prev, unchanged(4)), prev);
});

test("applyPoll: respuesta completa reemplaza; sin cambios con otro rev o sin prev → null", () => {
  const prev = snap(4);
  const next = snap(5);
  assert.equal(applyPoll(prev, next), next);
  assert.equal(applyPoll(null, next), next);
  assert.equal(applyPoll(prev, unchanged(5)), null);
  assert.equal(applyPoll(null, unchanged(4)), null);
  assert.equal(applyPoll(undefined, unchanged(4)), null);
});

test("hasRev / revOf", () => {
  assert.equal(hasRev(snap(1)), true);
  assert.equal(hasRev(unchanged(1)), false);
  assert.equal(hasRev(undefined), false);
  assert.equal(hasRev({ incident: {} }), false);
  assert.equal(hasRev({ incidents: [] }), false);
  assert.equal(revOf(snap(7)), 7);
  assert.equal(revOf(null), null);
  assert.equal(revOf(undefined), null);
});

test("pollWithRev: envía el rev conocido y conserva identidad si no hubo cambios", async () => {
  const prev = snap(3);
  const revs: (number | null)[] = [];
  let oks = 0;
  const out = await pollWithRev(
    prev,
    async (rev) => {
      revs.push(rev);
      return unchanged(3);
    },
    () => oks++,
  );
  assert.equal(out, prev);
  assert.deepEqual(revs, [3]);
  assert.equal(oks, 1);
});

test("pollWithRev: sin prev pide completo (rev null)", async () => {
  const revs: (number | null)[] = [];
  const full = snap(1);
  const out = await pollWithRev<Snap>(
    null,
    async (rev) => {
      revs.push(rev);
      return full;
    },
    () => {},
  );
  assert.equal(out, full);
  assert.deepEqual(revs, [null]);
});

test("pollWithRev: 'sin cambios' con rev distinto repite sin rev", async () => {
  const revs: (number | null)[] = [];
  let oks = 0;
  const full = snap(9);
  const out = await pollWithRev(
    snap(3),
    async (rev) => {
      revs.push(rev);
      return rev === null ? full : unchanged(9);
    },
    () => oks++,
  );
  assert.equal(out, full);
  assert.deepEqual(revs, [3, null]);
  assert.equal(oks, 2);
});

test("pollWithRev: servidor que insiste en 'sin cambios' sin rev → ApiClientError", async () => {
  await assert.rejects(
    pollWithRev<Snap>(null, async () => unchanged(1), () => {}),
    (err: unknown) => err instanceof ApiClientError && err.code === "internal",
  );
  await assert.rejects(
    pollWithRev<Snap>(snap(1), async () => unchanged(2), () => {}),
    (err: unknown) => err instanceof ApiClientError,
  );
});

test("pollWithRev: errores del fetch se propagan sin marcar éxito", async () => {
  let oks = 0;
  const boom = new ApiClientError(404, "not_found", "No encontrado.");
  await assert.rejects(
    pollWithRev<Snap>(snap(1), async () => {
      throw boom;
    }, () => oks++),
    (err: unknown) => err === boom,
  );
  assert.equal(oks, 0);
});

test("toApiClientError conserva ApiClientError y envuelve el resto en español", () => {
  const e = new ApiClientError(401, "unauthorized", "Debes iniciar sesión.");
  assert.equal(toApiClientError(e), e);
  const w = toApiClientError(new TypeError("x is undefined"));
  assert.ok(w instanceof ApiClientError);
  assert.equal(w.code, "internal");
  assert.match(w.message, /Ocurrió un error inesperado/);
  assert.ok(toApiClientError("raro") instanceof ApiClientError);
});

test("retryDelayMs: 401/403/400 no reintentan", () => {
  for (const [status, code] of [
    [401, "unauthorized"],
    [403, "forbidden"],
    [400, "invalid"],
  ] as const) {
    assert.equal(retryDelayMs(new ApiClientError(status, code, "x"), 1, 2_500), null);
  }
});

test("retryDelayMs: 404 retrocede lento con tope de 5 min", () => {
  const nf = new ApiClientError(404, "not_found", "x");
  assert.equal(retryDelayMs(nf, 1, 2_500), 30_000);
  assert.equal(retryDelayMs(nf, 2, 2_500), 60_000);
  assert.equal(retryDelayMs(nf, 20, 2_500), 300_000);
});

test("retryDelayMs: red/5xx exponencial con variación y tope", () => {
  const net = new ApiClientError(0, "network", "x");
  const mid = () => 0.5; // variación neutra (×1)
  assert.equal(retryDelayMs(net, 1, 2_500, mid), 2_500);
  assert.equal(retryDelayMs(net, 2, 2_500, mid), 5_000);
  assert.equal(retryDelayMs(net, 3, 2_500, mid), 10_000);
  assert.equal(retryDelayMs(net, 4, 2_500, mid), TRANSIENT_RETRY_CAP_MS);
  assert.equal(retryDelayMs(net, 50, 2_500, mid), TRANSIENT_RETRY_CAP_MS);
  assert.equal(retryDelayMs(net, 1, 2_500, () => 0), 2_000);
  assert.equal(retryDelayMs(net, 1, 2_500, () => 1), 3_000);
  const srv = new ApiClientError(500, "internal", "x");
  assert.equal(retryDelayMs(srv, 0, 4_000, mid), 4_000);
});

test("retryDelayMs: 429 espera al menos 10 s, tope 60 s", () => {
  const rl = new ApiClientError(429, "rate_limited", "x");
  assert.equal(retryDelayMs(rl, 1, 2_500), 10_000);
  assert.equal(retryDelayMs(rl, 2, 2_500), 20_000);
  assert.equal(retryDelayMs(rl, 9, 2_500), 60_000);
});

test("isStale / msUntilStale con umbral estricto", () => {
  assert.equal(isStale(null, 100_000, 15_000), false);
  assert.equal(isStale(0, 15_000, 15_000), false);
  assert.equal(isStale(0, 15_001, 15_000), true);
  assert.equal(msUntilStale(0, 10_000, 15_000), 5_001);
  assert.equal(isStale(0, 10_000 + 5_001, 15_000), true);
  assert.equal(msUntilStale(0, 20_000, 15_000), null);
  assert.equal(msUntilStale(null, 0, 15_000), null);
  assert.equal(isStale(0, 19_000, 20_000), false);
});

test("LivenessStore: activate, markOk y referencia de frescura", () => {
  const s = createLivenessStore();
  assert.deepEqual(s.get("a"), { lastOkAt: null, since: null });
  s.activate("a", 1_000);
  s.subscribe("a", () => {});
  assert.equal(staleReference(s.get("a")), 1_000);
  s.activate("a", 5_000); // ya la sondea otra instancia: no mueve la referencia
  assert.equal(s.get("a").since, 1_000);
  s.markOk("a", 7_000);
  assert.deepEqual(s.get("a"), { lastOkAt: 7_000, since: 1_000 });
  assert.equal(staleReference(s.get("a")), 7_000);
  s.markOk("a", 6_000); // no retrocede
  assert.equal(s.get("a").lastOkAt, 7_000);
  // claves independientes
  assert.equal(s.get("b").lastOkAt, null);
  s.markOk("b", 2_000);
  assert.equal(s.get("b").since, 2_000);
});

test("LivenessStore: notifica solo a la clave y permite desuscribirse", () => {
  const s = createLivenessStore();
  let a = 0;
  let b = 0;
  const unA = s.subscribe("a", () => a++);
  s.subscribe("b", () => b++);
  s.markOk("a", 1);
  s.markOk("a", 2);
  s.markOk("a", 2); // mismo instante: sin aviso
  assert.equal(a, 2);
  assert.equal(b, 0);
  unA();
  s.markOk("a", 3);
  assert.equal(a, 2);
  unA(); // idempotente
});

test("live-core y use-live se importan sin globals del navegador", async () => {
  assert.equal(typeof (globalThis as { window?: unknown }).window, "undefined");
  const mod = await import("@/lib/client/use-live");
  assert.equal(typeof mod.useIncidentSnapshot, "function");
  assert.equal(typeof mod.useBriefing, "function");
  assert.equal(typeof mod.useIncidentList, "function");
  assert.equal(typeof mod.useRuntimeMode, "function");
  assert.equal(typeof mod.useMe, "function");
});

test("requestTimeoutMs: entre 8 y 20 s según el intervalo", () => {
  assert.equal(requestTimeoutMs(2_500), 8_000);
  assert.equal(requestTimeoutMs(4_000), 12_000);
  assert.equal(requestTimeoutMs(60_000), 20_000);
});

test("withTimeout: resuelve, propaga errores y aborta al vencer", async () => {
  assert.equal(await withTimeout(async () => 7, 50), 7);
  const boom = new ApiClientError(500, "internal", "x");
  await assert.rejects(
    withTimeout(async () => {
      throw boom;
    }, 50),
    (err: unknown) => err === boom,
  );
  let aborted = false;
  await assert.rejects(
    withTimeout(
      (signal) =>
        new Promise<number>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(new ApiClientError(0, "aborted", "Operación cancelada."));
          });
        }),
      20,
    ),
    (err: unknown) => err instanceof ApiClientError && err.code === "network",
  );
  assert.equal(aborted, true);
});

test("withTimeout: un run que lanza de forma síncrona rechaza sin esperar el plazo", async () => {
  const boom = new ApiClientError(500, "internal", "x");
  const started = Date.now();
  await assert.rejects(
    withTimeout(() => {
      throw boom;
    }, 10_000),
    (err: unknown) => err === boom,
  );
  assert.ok(Date.now() - started < 1_000);
});

test("LivenessStore: activate reinicia la referencia de una clave sin éxitos ni suscriptores", () => {
  const s = createLivenessStore();
  s.activate("a", 1_000);
  s.activate("a", 50_000); // nadie la miraba: vuelve a empezar
  assert.equal(staleReference(s.get("a")), 50_000);
  const un = s.subscribe("a", () => {});
  s.activate("a", 90_000); // otra instancia ya la sondea: no se mueve
  assert.equal(s.get("a").since, 50_000);
  un();
  s.markOk("a", 100_000);
  s.activate("a", 200_000); // con un éxito previo, la referencia es ese éxito
  assert.deepEqual(s.get("a"), { lastOkAt: 100_000, since: 50_000 });
});

test("isMissingBriefingKey: id con clave ausente o vacía", () => {
  assert.equal(isMissingBriefingKey("abc", null), true);
  assert.equal(isMissingBriefingKey("abc", "  "), true);
  assert.equal(isMissingBriefingKey("abc", "k"), false);
  assert.equal(isMissingBriefingKey(null, null), false);
  assert.equal(isMissingBriefingKey(" ", null), false);
  assert.ok(MISSING_BRIEFING_KEY_ERROR instanceof ApiClientError);
  assert.equal(MISSING_BRIEFING_KEY_ERROR.code, "unauthorized");
  assert.match(MISSING_BRIEFING_KEY_ERROR.message, /Enlace inválido o vencido/);
});
