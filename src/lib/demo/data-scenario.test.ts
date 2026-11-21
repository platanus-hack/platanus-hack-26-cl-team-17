import { test } from "node:test";
import assert from "node:assert/strict";
import { SCENARIO } from "./data-scenario";
import type { ScenarioMediaSpec } from "./types";
import { validateScenario } from "./validate";

/** Medios en el orden en que el simulacro los crea: M1, M2, M3. */
function mediaInOrder(): ScenarioMediaSpec[] {
  const out: ScenarioMediaSpec[] = [];
  for (const s of SCENARIO.steps) {
    if (s.media) out.push(s.media);
    if (s.drone_media) out.push(s.drone_media);
  }
  return out;
}

test("el guion del simulacro pasa la validación sin problemas", () => {
  assert.deepEqual(validateScenario(SCENARIO), []);
});

test("10 pasos con la secuencia prevista", () => {
  const steps = SCENARIO.steps;
  assert.equal(steps.length, 10);
  assert.ok(steps[0].events?.length && !steps[0].comms);
  assert.equal(steps[2].media?.source, "demo");
  assert.equal(steps[4].media?.source, "demo");
  assert.deepEqual(steps[5].mission, { pattern: "orbit", radius_m: 50, altitude_m: 40, speed_ms: 8 });
  assert.equal(steps[7].drone_media?.source, "drone");
  assert.equal(steps[9].status, "controlled");
  assert.equal(mediaInOrder().length, 3);
});

test("M2 muestra a la persona en el balcón del 3er piso y los pósters calzan", () => {
  const [m1, m2] = mediaInOrder();
  assert.ok(!m1.analysis.people.some((p) => p.status === "at_window_or_balcony"));
  const atBalcony = m2.analysis.people.filter((p) => p.status === "at_window_or_balcony");
  assert.equal(atBalcony.length, 1);
  assert.equal(atBalcony[0].floor, 3);
  // Condición con que el pipeline levanta la alerta de persona en riesgo.
  assert.ok(atBalcony[0].confidence === "high" || atBalcony[0].confidence === "medium");
  assert.ok(atBalcony[0].frame_refs.length > 0);
});

test("la persona aparece en un póster solo si el análisis cita ese fotograma", () => {
  for (const m of mediaInOrder()) {
    const cited = new Set(
      m.analysis.people.filter((p) => p.status === "at_window_or_balcony").flatMap((p) => p.frame_refs),
    );
    m.frames.forEach((f, i) => assert.equal(Boolean(f.poster.person), cited.has(i), `${f.poster.caption} fotograma ${i}`));
  }
});

test("variantes de póster distintas y cámara del dron sobre la órbita de 50 m", () => {
  const variants = mediaInOrder().flatMap((m) => m.frames.map((f) => f.poster.variant));
  assert.equal(new Set(variants).size, variants.length);
  const drone = mediaInOrder()[2];
  assert.equal(drone.drone_alt_m, 40);
  assert.ok(drone.frames.length >= 4 && drone.frames.length <= 6);
  assert.ok(Math.abs(Math.hypot(drone.camera.x, drone.camera.y) - 50) < 1);
  for (const f of drone.frames) assert.equal(f.poster.view, "aerial");
});

test("ninguna comunicación declara el edificio revisado ni descarta víctimas", () => {
  const texts = SCENARIO.steps.flatMap((s) => (s.comms ?? []).map((c) => c.text.toLowerCase()));
  for (const t of texts) {
    assert.ok(!/sin v[ií]ctimas|no hay (m[aá]s )?personas|edificio (revisado|despejado) completo/.test(t), t);
  }
  assert.equal(new Set(texts).size, texts.length);
});

test("nada se sabe antes de que ocurra: balcón tras M2, dron tras desplegarlo", () => {
  const m2Step = SCENARIO.steps.findIndex((s) => s.media && s.media.analysis.people.some((p) => p.status === "at_window_or_balcony"));
  const missionStep = SCENARIO.steps.findIndex((s) => s.mission);
  assert.ok(m2Step > 0 && missionStep > m2Step);
  SCENARIO.steps.forEach((s, i) => {
    const text = [s.label, ...(s.comms ?? []).map((c) => c.text), ...(s.events ?? []).map((e) => `${e.title} ${e.detail}`)]
      .join(" ")
      .toLowerCase();
    if (i < m2Step) assert.ok(!/balc[oó]n/.test(text), `paso ${i} menciona el balcón antes de M2`);
    if (i < missionStep) assert.ok(!/\bdron\b/.test(text), `paso ${i} menciona el dron antes de desplegarlo`);
  });
});

test("chips cortos, rótulos M<n> en orden y relojes que avanzan", () => {
  for (const s of SCENARIO.steps) assert.ok(s.label.length <= 60, s.label);
  let last = "";
  mediaInOrder().forEach((m, i) => {
    for (const f of m.frames) {
      assert.ok(f.poster.caption.startsWith(`M${i + 1} · `), f.poster.caption);
      assert.match(f.poster.clock, /^(19|2[0-3]):[0-5]\d:[0-5]\d$/);
      assert.ok(f.poster.clock >= last, `reloj ${f.poster.clock} retrocede`);
      last = f.poster.clock;
    }
  });
});

test("el lote del dron no muestra a la persona ni la da por rescatada", () => {
  const drone = mediaInOrder()[2];
  assert.ok(!drone.analysis.people.some((p) => p.status === "at_window_or_balcony"));
  assert.ok(drone.analysis.uncertainties.some((u) => /no se puede determinar si la persona sigue/i.test(u)));
  assert.ok(drone.analysis.hazards.some((h) => h.kind === "collapse_risk" && h.severity === "high"));
});
