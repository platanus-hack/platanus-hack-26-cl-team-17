import { test } from "node:test";
import assert from "node:assert/strict";
import { SCENARIO } from "./data-scenario";
import type { DroneMission } from "@/lib/domain";
import { planMission } from "@/lib/drone/plan";
import { secondsUntilOnStation } from "@/lib/drone/sim";
import { destination } from "@/lib/geo";
import { DRILL_HOME_BEARING_DEG, DRILL_HOME_DISTANCE_M, MAX_DRONE_WAIT_S, TICK_MARGIN_S } from "./scenario";
import type { ScenarioMediaSpec } from "./types";
import { SCENARIO_MAX_S, SCENARIO_NETWORK_MARGIN_S, scenarioWaitS, validateScenario } from "./validate";

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

test("7 pasos con la secuencia prevista", () => {
  const steps = SCENARIO.steps;
  assert.equal(steps.length, 7);
  // El dron despega con la alarma: así llega a su órbita sin hacer esperar al simulacro.
  assert.deepEqual(steps[0].mission, { pattern: "orbit", radius_m: 50, altitude_m: 40, speed_ms: 15 });
  assert.equal(steps[1].media?.source, "demo");
  assert.equal(steps[2].media?.source, "demo");
  assert.equal(steps[4].drone_media?.source, "drone");
  assert.equal(steps[6].status, "controlled");
  assert.equal(mediaInOrder().length, 3);
});

test("el simulacro dura 40 s como máximo, contando la llegada del dron", () => {
  const steps = SCENARIO.steps;
  const missionStep = steps.findIndex((s) => s.mission);
  const droneStep = steps.findIndex((s) => s.drone_media);
  const spec = steps[missionStep].mission!;
  const center = { lat: SCENARIO.incident.lat, lng: SCENARIO.incident.lng };
  const home = destination(center, DRILL_HOME_BEARING_DEG, DRILL_HOME_DISTANCE_M);
  const plan = planMission(center, { mode: "simulated", ...spec, home_lat: home.lat, home_lng: home.lng });
  const t0 = Date.parse("2026-11-21T20:00:00.000Z");
  const mission: DroneMission = {
    id: "m",
    incident_id: "i",
    label: "D1",
    status: "planned",
    mode: "simulated",
    ...plan,
    command: "continue",
    last: null,
    track: [],
    frames_received: 0,
    created_at: new Date(t0).toISOString(),
    started_at: null,
    ended_at: null,
  };
  // El mando avanza la misión cada ~2 s: el despegue real ocurre hasta un tick después.
  const flightS = (secondsUntilOnStation(mission, center, t0) ?? Infinity) + 2;
  let t = 0;
  for (let i = 0; i < steps.length - 1; i++) {
    let wait = steps[i].wait_s;
    if (i === droneStep - 1) {
      const eta = flightS - (t - steps.slice(0, missionStep).reduce((n, s) => n + s.wait_s, 0));
      if (eta > 0) wait = Math.min(MAX_DRONE_WAIT_S, Math.max(wait, Math.ceil(eta) + TICK_MARGIN_S));
    }
    t += wait;
  }
  assert.ok(t + SCENARIO_NETWORK_MARGIN_S <= SCENARIO_MAX_S, `dura ~${t + SCENARIO_NETWORK_MARGIN_S} s (dron en órbita a los ${flightS.toFixed(1)} s)`);
  assert.ok(scenarioWaitS(SCENARIO) <= t);
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

test("nada se sabe antes de que ocurra: balcón tras M2, dron tras desplegarlo, Vigía en los chips", () => {
  const m2Step = SCENARIO.steps.findIndex((s) => s.media && s.media.analysis.people.some((p) => p.status === "at_window_or_balcony"));
  const missionStep = SCENARIO.steps.findIndex((s) => s.mission);
  const droneStep = SCENARIO.steps.findIndex((s) => s.drone_media);
  assert.ok(m2Step > 0 && missionStep >= 0 && droneStep > missionStep);
  SCENARIO.steps.forEach((s, i) => {
    const text = [s.label, ...(s.comms ?? []).map((c) => c.text), ...(s.events ?? []).map((e) => `${e.title} ${e.detail}`)]
      .join(" ")
      .toLowerCase();
    if (i < m2Step) assert.ok(!/balc[oó]n/.test(text), `paso ${i} menciona el balcón antes de M2`);
    if (i < missionStep) assert.ok(!/\bdron\b/.test(text), `paso ${i} menciona el dron antes de desplegarlo`);
    if (i < droneStep) assert.ok(!/cuarto piso|4º piso|techumbre/.test(text), `paso ${i} sabe del 4º piso antes del dron`);
  });
  // Los videos de vecinos los presenta Vigía: es lo que el público tiene que ver.
  for (const s of SCENARIO.steps) if (s.media) assert.match(s.label, /^Vigía /);
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
