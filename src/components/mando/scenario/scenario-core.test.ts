import { test } from "node:test";
import assert from "node:assert/strict";
import type { ScenarioStepRequest, ScenarioStepResponse } from "@/lib/contract";
import { abortableSleep, runScenario, type ScenarioDeps, type ScenarioProgress } from "./scenario-core";

const TOTAL = 3;

function step(req: ScenarioStepRequest): ScenarioStepResponse {
  return {
    incident_id: req.incident_id ?? "inc-1",
    done: req.step >= TOTAL - 1,
    next_step: req.step + 1,
    wait_s: 2,
    label: `Paso ${req.step}`,
    total_steps: TOTAL,
  };
}

interface Harness {
  deps: ScenarioDeps;
  calls: ScenarioStepRequest[];
  sleeps: number[];
  progress: ScenarioProgress[];
  started: string[];
}

function harness(
  callStep: (req: ScenarioStepRequest, signal: AbortSignal) => Promise<ScenarioStepResponse>,
  sleep: (ms: number, signal: AbortSignal) => Promise<void> = async () => {},
): Harness {
  const h: Harness = {
    calls: [],
    sleeps: [],
    progress: [],
    started: [],
    deps: {
      callStep: (req, signal) => {
        h.calls.push(req);
        return callStep(req, signal);
      },
      sleep: (ms, signal) => {
        h.sleeps.push(ms);
        return sleep(ms, signal);
      },
      onProgress: (p) => h.progress.push(p),
      onStarted: (id) => h.started.push(id),
    },
  };
  return h;
}

test("camino feliz: ejecuta todos los pasos respetando wait_s", async () => {
  const h = harness(async (req) => step(req));
  const res = await runScenario(h.deps, new AbortController().signal);
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(h.calls, [
    { incident_id: null, step: 0 },
    { incident_id: "inc-1", step: 1 },
    { incident_id: "inc-1", step: 2 },
  ]);
  assert.deepEqual(h.started, ["inc-1"]);
  assert.deepEqual(
    h.progress.map((p) => [p.step, p.total, p.label, p.done]),
    [
      [1, 3, "Paso 0", false],
      [2, 3, "Paso 1", false],
      [3, 3, "Paso 2", true],
    ],
  );
  assert.deepEqual(h.sleeps, [2000, 2000]);
});

test("reintenta un paso fallido con espera creciente y continúa", async () => {
  let failures = 0;
  const h = harness(async (req) => {
    if (req.step === 1 && failures < 2) {
      failures++;
      throw new Error("falla transitoria");
    }
    return step(req);
  });
  const res = await runScenario(h.deps, new AbortController().signal);
  assert.deepEqual(res, { ok: true });
  assert.equal(h.calls.filter((c) => c.step === 1).length, 3);
  // wait 2 s tras el paso 0, luego 1,5 s y 3 s de backoff, luego wait 2 s tras el paso 1.
  assert.deepEqual(h.sleeps, [2000, 1500, 3000, 2000]);
  assert.equal(h.progress.at(-1)?.done, true);
});

test("tras 3 intentos fallidos se detiene con el último error", async () => {
  const boom = new Error("servidor caído");
  const h = harness(async (req) => {
    if (req.step === 2) throw boom;
    return step(req);
  });
  const res = await runScenario(h.deps, new AbortController().signal);
  assert.deepEqual(res, { ok: false, error: boom });
  assert.equal(h.calls.filter((c) => c.step === 2).length, 3);
  assert.equal(h.progress.length, 2);
});

test("falla del paso 0: no llama onStarted", async () => {
  const h = harness(async () => {
    throw new Error("x");
  });
  const res = await runScenario(h.deps, new AbortController().signal, { maxAttempts: 2, backoffMs: [10] });
  assert.equal(res.ok, false);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.sleeps, [10]);
  assert.deepEqual(h.started, []);
});

test("shouldRetry false: no reintenta", async () => {
  const h = harness(async () => {
    throw new Error("401");
  });
  const res = await runScenario(h.deps, new AbortController().signal, { shouldRetry: () => false });
  assert.equal(res.ok, false);
  assert.equal(h.calls.length, 1);
});

test("guion que no avanza → error en vez de ciclo infinito", async () => {
  const h = harness(async (req) => ({ ...step(req), done: false, next_step: req.step }));
  const res = await runScenario(h.deps, new AbortController().signal);
  assert.equal(res.ok, false);
  assert.ok("error" in res);
  assert.equal(h.calls.length, 1);
});

test("cancelar durante la espera: termina como aborted sin más pasos", async () => {
  const ctrl = new AbortController();
  const h = harness(
    async (req) => step(req),
    (ms, signal) => {
      queueMicrotask(() => ctrl.abort());
      return abortableSleep(ms, signal);
    },
  );
  const res = await runScenario(h.deps, ctrl.signal);
  assert.deepEqual(res, { ok: false, aborted: true });
  assert.equal(h.calls.length, 1);
  assert.equal(h.progress.length, 1);
});

test("cancelar con una llamada en curso: ignora su resultado", async () => {
  const ctrl = new AbortController();
  const h = harness(async (req) => {
    if (req.step === 1) {
      ctrl.abort();
      return step(req);
    }
    return step(req);
  });
  const res = await runScenario(h.deps, ctrl.signal);
  assert.deepEqual(res, { ok: false, aborted: true });
  assert.equal(h.progress.length, 1);
});

test("cancelar durante el backoff de un reintento", async () => {
  const ctrl = new AbortController();
  const h = harness(
    async () => {
      throw new Error("x");
    },
    (ms, signal) => {
      queueMicrotask(() => ctrl.abort());
      return abortableSleep(ms, signal);
    },
  );
  const res = await runScenario(h.deps, ctrl.signal);
  assert.deepEqual(res, { ok: false, aborted: true });
  assert.equal(h.calls.length, 1);
});

test("abortableSleep resuelve tras el plazo", async () => {
  const t0 = Date.now();
  await abortableSleep(20, new AbortController().signal);
  assert.ok(Date.now() - t0 >= 15);
});

test("abortableSleep rechaza con AbortError si ya estaba cancelado o se cancela", async () => {
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(abortableSleep(1000, pre.signal), { name: "AbortError" });
  const mid = new AbortController();
  const p = abortableSleep(10_000, mid.signal);
  mid.abort();
  await assert.rejects(p, { name: "AbortError" });
});
