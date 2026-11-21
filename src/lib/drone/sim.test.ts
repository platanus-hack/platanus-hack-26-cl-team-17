import { test } from "node:test";
import assert from "node:assert/strict";
import type { DroneMission, MissionPattern, TelemetryPoint } from "@/lib/domain";
import { bearingDeg, distanceM, toLocal, type LatLng } from "@/lib/geo";
import { planMission } from "@/lib/drone/plan";
import { advance, MAX_STEP_MS, SAMPLE_MS, type SimEvent, type SimResult } from "@/lib/drone/sim";

const CENTER: LatLng = { lat: -33.4569, lng: -70.5976 };
const T0 = Date.parse("2026-11-21T15:00:00.000Z");

function mission(
  over: Partial<DroneMission> = {},
  plan: { pattern?: MissionPattern; radius_m?: number; altitude_m?: number; speed_ms?: number } = {},
): DroneMission {
  const p = planMission(CENTER, {
    mode: "simulated",
    pattern: plan.pattern ?? "orbit",
    radius_m: plan.radius_m ?? 60,
    altitude_m: plan.altitude_m ?? 45,
    speed_ms: plan.speed_ms ?? 8,
  });
  return {
    id: "m1",
    incident_id: "i1",
    label: "D1",
    status: "planned",
    mode: "simulated",
    ...p,
    command: "continue",
    last: null,
    track: [],
    frames_received: 0,
    created_at: new Date(T0).toISOString(),
    started_at: null,
    ended_at: null,
    ...over,
  };
}

/** Aplica el resultado como lo haría el tick. */
function apply(m: DroneMission, r: SimResult): DroneMission {
  return {
    ...m,
    status: r.status,
    started_at: r.started_at ?? m.started_at,
    ended_at: r.ended_at ?? m.ended_at,
    last: r.points.length > 0 ? r.points[r.points.length - 1] : m.last,
    track: m.track.concat(r.points).slice(-300),
  };
}

interface Run {
  m: DroneMission;
  points: TelemetryPoint[];
  events: SimEvent[];
  now: number;
}

/** Avanza con ticks regulares hasta que `stop` se cumpla o se acabe el plazo. */
function run(
  m0: DroneMission,
  from: number,
  opts: { stepMs?: number; maxMs: number; stop?: (m: DroneMission) => boolean },
): Run {
  const step = opts.stepMs ?? SAMPLE_MS;
  let m = m0;
  const points: TelemetryPoint[] = [];
  const events: SimEvent[] = [];
  let now = from;
  for (; now <= from + opts.maxMs; now += step) {
    const r = advance(m, CENTER, now);
    m = apply(m, r);
    points.push(...r.points);
    events.push(...r.events);
    if (opts.stop?.(m)) break;
  }
  return { m, points, events, now };
}

const home = (m: DroneMission): LatLng => ({ lat: m.home_lat, lng: m.home_lng });
const angDiff = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

function onStation(plan: Parameters<typeof mission>[1] = {}): Run {
  return run(mission({}, plan), T0, { maxMs: 600_000, stop: (m) => m.status === "on_station" });
}

test("primer avance: despega desde el punto de inicio", () => {
  const m = mission();
  const r = advance(m, CENTER, T0);
  assert.equal(r.status, "launching");
  assert.equal(r.started_at, new Date(T0).toISOString());
  assert.equal(r.points.length, 1);
  const p = r.points[0];
  assert.equal(p.at, new Date(T0).toISOString());
  assert.equal(p.alt_m, 0);
  assert.equal(p.battery_pct, 100);
  assert.ok(distanceM(p, home(m)) < 0.01);
  assert.ok(angDiff(p.heading_deg, bearingDeg(home(m), CENTER)) < 1);
  assert.deepEqual(
    r.events.map((e) => e.title),
    ["Dron D1 despegó"],
  );
});

test("ciclo completo: ascenso → en ruta → órbita a radio constante mirando al centro", () => {
  const start = advance(mission(), CENTER, T0);
  let m = apply(mission(), start);

  // Ascenso a 3 m/s en el punto de despegue.
  const r10 = advance(m, CENTER, T0 + 10_000);
  assert.equal(r10.status, "launching");
  assert.equal(r10.points.at(-1)?.alt_m, 30);
  assert.equal(r10.points.at(-1)?.speed_ms, 3);
  assert.ok(distanceM(r10.points.at(-1)!, home(m)) < 0.01);
  assert.equal(r10.events.length, 0);
  m = apply(m, r10);

  // A los 15 s alcanza 45 m y empieza a volar horizontal.
  const r16 = advance(m, CENTER, T0 + 16_000);
  assert.equal(r16.status, "en_route");
  const p16 = r16.points.at(-1)!;
  assert.equal(p16.alt_m, 45);
  assert.equal(p16.speed_ms, 8);
  assert.ok(Math.abs(distanceM(p16, home(m)) - 8) < 0.1);
  assert.ok(angDiff(p16.heading_deg, bearingDeg(home(m), CENTER)) < 1);
  m = apply(m, r16);

  const statuses = new Set<string>();
  const r = run(m, T0 + 18_000, {
    maxMs: 120_000,
    stop: (x) => {
      statuses.add(x.status);
      return x.status === "on_station";
    },
  });
  assert.ok(statuses.has("en_route"));
  assert.equal(r.m.status, "on_station");
  const arrival = r.events.find((e) => e.title.startsWith("Dron D1 en posición"));
  assert.equal(arrival?.title, "Dron D1 en posición — orbitando a 60 m del incidente");
  // 15 s de ascenso + 240 m a 8 m/s.
  assert.ok(Math.abs(Date.parse(arrival!.at) - (T0 + 45_000)) < 50);

  // Órbita: 2 minutos a 60 ± 2 m, rumbo hacia el centro ± 5°, sentido horario.
  const orbit = run(r.m, r.now + SAMPLE_MS, { maxMs: 120_000 });
  assert.equal(orbit.m.status, "on_station");
  assert.equal(orbit.events.length, 0);
  let prevBearing: number | null = null;
  let swept = 0;
  for (const p of orbit.points) {
    assert.ok(Math.abs(distanceM(CENTER, p) - 60) <= 2, `radio ${distanceM(CENTER, p)}`);
    assert.ok(angDiff(p.heading_deg, bearingDeg(p, CENTER)) <= 5, `rumbo ${p.heading_deg}`);
    assert.equal(p.alt_m, 45);
    assert.equal(p.speed_ms, 8);
    assert.ok(p.heading_deg >= 0 && p.heading_deg < 360);
    const b = bearingDeg(CENTER, p);
    if (prevBearing !== null) {
      const d = (b - prevBearing + 360) % 360;
      assert.ok(d > 0 && d < 180, "debe girar en sentido horario");
      swept += d;
    }
    prevBearing = b;
  }
  // ω = 8/60 rad/s → ~15,3°/2 s.
  const expected = ((8 / 60) * 2 * 180) / Math.PI;
  assert.ok(Math.abs(swept / (orbit.points.length - 1) - expected) < 0.5);
});

test("transición a mitad de paso: el evento lleva el instante simulado", () => {
  // 240 m a 7 m/s = 34,29 s → llegada a 49,29 s del despegue.
  const r = onStation({ speed_ms: 7 });
  const ev = r.events.find((e) => e.title.startsWith("Dron D1 en posición"))!;
  const at = Date.parse(ev.at);
  assert.ok(Math.abs(at - (T0 + 15_000 + (240 / 7) * 1000)) < 50);
  assert.notEqual((at - T0) % SAMPLE_MS, 0);
  const firstOn = r.m.track.find((p) => Date.parse(p.at) >= at)!;
  assert.ok(Date.parse(firstOn.at) > at);
});

test("batería: −1 % cada 20 s en el aire, sin acumular error con ticks irregulares", () => {
  const r = onStation();
  const before = r.m.last!;
  const later = run(r.m, r.now + SAMPLE_MS, { maxMs: 18_000 });
  const after = later.m.last!;
  const elapsedS = (Date.parse(after.at) - Date.parse(before.at)) / 1000;
  assert.equal(elapsedS, 20);
  assert.ok(Math.abs(before.battery_pct! - after.battery_pct! - 1) <= 0.051);

  // 230 s con ticks de 2,3 s: consumo esperado 11,5 %.
  const irregular = run(r.m, r.now + 2_300, { stepMs: 2_300, maxMs: 230_000 - 2_300 });
  const t = (Date.parse(irregular.m.last!.at) - Date.parse(before.at)) / 1000;
  assert.equal(t, 230);
  assert.ok(Math.abs(before.battery_pct! - irregular.m.last!.battery_pct! - 11.5) <= 0.11);
  for (const p of irregular.points) assert.equal(p.battery_pct, Math.round(p.battery_pct! * 10) / 10);
});

test("batería baja: retorna, desciende y aterriza; después no hace nada", () => {
  const all = run(mission(), T0, { maxMs: 3_600_000, stop: (m) => m.status === "landed" });
  assert.equal(all.m.status, "landed");
  const titles = all.events.map((e) => e.title);
  assert.deepEqual(titles, [
    "Dron D1 despegó",
    "Dron D1 en posición — orbitando a 60 m del incidente",
    "Dron D1 retornando — batería 24 %",
    "Dron D1 aterrizó",
  ]);
  const low = all.events[2];
  assert.equal(low.severity, "warning");
  // < 25 % en la lectura: 75,05 % consumido a 0,05 %/s → 1501 s.
  assert.ok(Math.abs(Date.parse(low.at) - (T0 + 1_501_000)) < 50);

  const landedEv = all.events[3];
  const touch = all.m.last!;
  assert.equal(all.m.ended_at, touch.at);
  assert.equal(landedEv.at, touch.at);
  assert.equal(touch.alt_m, 0);
  assert.equal(touch.speed_ms, 0);
  assert.ok(distanceM(touch, home(all.m)) < 0.1);
  assert.ok(touch.battery_pct! > 20 && touch.battery_pct! < 25);
  // El descenso es vertical a 2 m/s: los últimos puntos están sobre el despegue.
  const descent = all.points.filter((p) => distanceM(p, home(all.m)) < 0.1 && p.speed_ms === 2);
  assert.ok(descent.length >= 10);

  // Aterrizada: no-op aunque pase el tiempo.
  const idle = advance(all.m, CENTER, Date.parse(touch.at) + 60_000);
  assert.deepEqual(idle, {
    points: [],
    status: "landed",
    started_at: all.m.started_at,
    ended_at: all.m.ended_at,
    events: [],
  });
  // Ni siquiera "continue" la reanuda.
  assert.equal(advance({ ...all.m, command: "continue" }, CENTER, Date.parse(touch.at) + 5_000).points.length, 0);
});

test("orden de retorno y reanudación", () => {
  const r = onStation();
  const recalled = advance({ ...r.m, command: "recall" }, CENTER, r.now + SAMPLE_MS);
  assert.equal(recalled.status, "returning");
  assert.deepEqual(
    recalled.events.map((e) => [e.severity, e.title]),
    [["notice", "Dron D1 retornando — orden del mando"]],
  );
  let m = apply({ ...r.m, command: "recall" }, recalled);

  // Se acerca al despegue.
  const d0 = distanceM(m.last!, home(m));
  const back = run(m, r.now + 2 * SAMPLE_MS, { maxMs: 10_000 });
  assert.equal(back.m.status, "returning");
  assert.equal(back.events.length, 0);
  const d1 = distanceM(back.m.last!, home(m));
  assert.ok(Math.abs(d0 - d1 - 12 * 8) < 1, `${d0} → ${d1}`);
  assert.ok(angDiff(back.m.last!.heading_deg, bearingDeg(back.m.last!, home(m))) < 2);
  m = back.m;

  // Reanuda: vuelve a en ruta y a la estación.
  const resumed = run({ ...m, command: "continue" }, back.now + SAMPLE_MS, {
    maxMs: 120_000,
    stop: (x) => x.status === "on_station",
  });
  assert.equal(resumed.events[0].title, "Dron D1 reanuda la misión");
  assert.equal(resumed.events[0].severity, "notice");
  assert.equal(resumed.m.status, "on_station");
  assert.equal(resumed.events.at(-1)?.title, "Dron D1 en posición — orbitando a 60 m del incidente");
  assert.equal(resumed.events.length, 2);
});

test("retorno por batería no se reanuda con 'continue'", () => {
  const r = onStation();
  // Batería coherente con el despegue para quedar bajo el umbral.
  const startedMs = Date.parse(r.m.last!.at) - 1_520_000;
  const m: DroneMission = {
    ...r.m,
    status: "returning",
    started_at: new Date(startedMs).toISOString(),
    last: { ...r.m.last!, battery_pct: 24 },
  };
  const res = advance(m, CENTER, r.now + SAMPLE_MS);
  assert.equal(res.status, "returning");
  assert.equal(res.events.length, 0);
});

test("abortar: inmediato, sin puntos y desde cualquier estado activo", () => {
  const r = onStation();
  const now = r.now + 5_000;
  const ab = advance({ ...r.m, command: "abort" }, CENTER, now);
  assert.equal(ab.status, "aborted");
  assert.equal(ab.points.length, 0);
  assert.equal(ab.ended_at, new Date(now).toISOString());
  assert.deepEqual(
    ab.events.map((e) => [e.severity, e.title, e.at]),
    [["warning", "Dron D1 abortado por el mando", new Date(now).toISOString()]],
  );

  const planned = advance(mission({ command: "abort" }), CENTER, T0);
  assert.equal(planned.status, "aborted");
  assert.equal(planned.points.length, 0);

  const aborted = apply({ ...r.m, command: "abort" }, ab);
  assert.deepEqual(advance(aborted, CENTER, now + 10_000), {
    points: [],
    status: "aborted",
    started_at: aborted.started_at,
    ended_at: aborted.ended_at,
    events: [],
  });
});

test("salto acotado: una hora sin ticks es una pausa; retoma ahora con un solo paso", () => {
  const r = onStation();
  const lastMs = Date.parse(r.m.last!.at);
  const now = lastMs + 3_600_000;
  const res = advance(r.m, CENTER, now);
  assert.equal(res.points.length, 1);
  assert.equal(res.status, "on_station");
  // El punto queda en el presente (sin "sin señal hace 1 h") y el vuelo avanza solo un paso.
  assert.equal(res.points[0].at, new Date(now).toISOString());
  assert.ok(distanceM(r.m.last!, res.points[0]) <= 8 * (SAMPLE_MS / 1000) + 0.5);
  // La batería no se descuenta por la pausa: solo por el paso simulado.
  assert.ok(Math.abs(r.m.last!.battery_pct! - res.points[0].battery_pct! - 0.1) <= 0.051);
  // Tras la pausa sigue sin deriva: 10 ticks de 2 s consumen 1 %.
  const after = run(apply(r.m, res), now + SAMPLE_MS, { maxMs: 9 * SAMPLE_MS });
  assert.ok(Math.abs(res.points[0].battery_pct! - after.m.last!.battery_pct! - 1) <= 0.051);
  // Justo en el tope (10 s) no es pausa: avanza los 10 s completos.
  const edge = advance(r.m, CENTER, lastMs + MAX_STEP_MS);
  assert.equal(edge.points.length, 5);
  assert.equal(edge.points.at(-1)!.at, new Date(lastMs + MAX_STEP_MS).toISOString());

  assert.deepEqual(advance(r.m, CENTER, lastMs).points, []);
  const past = advance(r.m, CENTER, lastMs - 5_000);
  assert.deepEqual(past, {
    points: [],
    status: "on_station",
    started_at: r.m.started_at,
    ended_at: null,
    events: [],
  });
});

test("cantidad de puntos por paso", () => {
  const r = onStation();
  const lastMs = Date.parse(r.m.last!.at);
  const offsets = (dt: number) => advance(r.m, CENTER, lastMs + dt).points.map((p) => Date.parse(p.at) - lastMs);
  assert.deepEqual(offsets(10_000), [2_000, 4_000, 6_000, 8_000, 10_000]);
  assert.deepEqual(offsets(3_000), [2_000, 3_000]);
  assert.deepEqual(offsets(1_000), [1_000]);
  assert.deepEqual(offsets(4_000), [2_000, 4_000]);
});

test("determinista: misma misión y mismo instante → mismo resultado", () => {
  const r = onStation();
  const now = r.now + 7_300;
  assert.deepEqual(advance(r.m, CENTER, now), advance(structuredClone(r.m), CENTER, now));
  const a = run(mission(), T0, { maxMs: 200_000 });
  const b = run(mission(), T0, { maxMs: 200_000 });
  assert.deepEqual(a.points, b.points);
  assert.deepEqual(a.events, b.events);
});

test("punto fijo: queda sobre el incidente", () => {
  const r = onStation({ pattern: "hover" });
  assert.equal(
    r.events.find((e) => e.title.startsWith("Dron D1 en posición"))?.title,
    "Dron D1 en posición — sobre el incidente",
  );
  const stay = run(r.m, r.now + SAMPLE_MS, { maxMs: 60_000 });
  assert.equal(stay.m.status, "on_station");
  for (const p of stay.points) {
    assert.ok(distanceM(p, CENTER) < 0.5);
    assert.equal(p.speed_ms, 0);
    assert.equal(p.alt_m, 45);
  }
});

test("barrido: recorre los waypoints en orden y repite", () => {
  const r = onStation({ pattern: "grid" });
  assert.equal(
    r.events.find((e) => e.title.startsWith("Dron D1 en posición"))?.title,
    "Dron D1 en posición — iniciando barrido",
  );
  const wps = r.m.waypoints.map((w) => toLocal(CENTER, w));
  const n = wps.length;
  const segDist = (i: number, p: { x: number; y: number }) => {
    const a = wps[i];
    const b = wps[(i + 1) % n];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const u = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(p.x - (a.x + u * dx), p.y - (a.y + u * dy));
  };

  // Llegó a waypoints[0] a mitad de paso y siguió por el primer tramo.
  assert.ok(segDist(0, toLocal(CENTER, r.m.last!)) <= 0.5);

  // Ticks de 1 s (puntos cada 8 m) durante ~2,5 vueltas.
  const sweep = run(r.m, r.now + 1_000, { stepMs: 1_000, maxMs: 260_000 });
  assert.equal(sweep.m.status, "on_station");
  let cur = 0;
  let advances = 0;
  for (const p of sweep.points.map((q) => toLocal(CENTER, q))) {
    if (segDist(cur, p) <= 0.5) continue;
    const next = (cur + 1) % n;
    assert.ok(segDist(next, p) <= 0.5, `punto fuera de la ruta tras el tramo ${cur}`);
    cur = next;
    advances++;
  }
  assert.ok(advances >= 2 * n, `solo avanzó ${advances} tramos`);
  for (const p of sweep.points) {
    assert.equal(p.alt_m, 45);
    assert.equal(p.speed_ms, 8);
  }
});

test("retorno antes de despegar: cierra la misión sin vuelo", () => {
  const r = advance(mission({ command: "recall" }), CENTER, T0);
  assert.equal(r.status, "landed");
  assert.equal(r.points.length, 0);
  assert.equal(r.events.length, 1);
});

/* ───────────── Regresiones (revisión adversarial) ───────────── */

test("órbita de 30 min en pasos de 10 s: radio sin deriva y batería exacta", () => {
  const r = onStation();
  const t0 = Date.parse(r.m.last!.at);
  const startedMs = Date.parse(r.m.started_at!);
  const long = run(r.m, t0 + MAX_STEP_MS, { stepMs: MAX_STEP_MS, maxMs: 1_800_000 });
  const orbiting = long.points.filter((p) => Date.parse(p.at) - startedMs < 1_500_000);
  assert.ok(orbiting.length > 600);
  for (const p of orbiting) {
    assert.ok(Math.abs(distanceM(CENTER, p) - 60) < 0.05, `radio ${distanceM(CENTER, p)}`);
    assert.ok(angDiff(p.heading_deg, bearingDeg(p, CENTER)) < 0.5);
    const exact = 100 - ((Date.parse(p.at) - startedMs) / 1000) * 0.05;
    assert.ok(Math.abs(p.battery_pct! - exact) <= 0.051, `batería ${p.battery_pct} ≠ ${exact}`);
  }
  assert.equal(long.m.status, "landed");
  const titles = long.events.map((e) => e.title);
  assert.equal(new Set(titles).size, titles.length, "eventos duplicados");
});

test("batería inicial distinta de 100 (vitrina): sin deriva con ticks irregulares", () => {
  const r = onStation();
  // Igual que la vitrina: el primer punto parte con 96 %.
  const offset = 4;
  const m: DroneMission = {
    ...r.m,
    last: { ...r.m.last!, battery_pct: Math.round((r.m.last!.battery_pct! - offset) * 10) / 10 },
  };
  const before = m.last!.battery_pct!;
  const irregular = run(m, r.now + 2_300, { stepMs: 2_300, maxMs: 230_000 - 2_300 });
  assert.ok(
    Math.abs(before - irregular.m.last!.battery_pct! - 11.5) <= 0.11,
    `consumió ${before - irregular.m.last!.battery_pct!}`,
  );
});

test("orden de retorno: el evento no queda antes del instante del tick que la aplica", () => {
  const r = onStation();
  const lastMs = Date.parse(r.m.last!.at);
  // La orden llega 1,5 s después del último punto; el tick corre a los 2 s.
  const res = advance({ ...r.m, command: "recall" }, CENTER, lastMs + 2_000);
  assert.equal(res.status, "returning");
  assert.ok(Date.parse(res.events[0].at) >= lastMs + 1_500, `evento en ${res.events[0].at}`);
});

test("retorno justo tras despegar: nunca repite el instante del último punto", () => {
  const start = advance(mission(), CENTER, T0);
  let m = apply(mission(), start);
  m = { ...m, command: "recall" };
  const all = run(m, T0 + SAMPLE_MS, { maxMs: 120_000, stop: (x) => x.status === "landed" });
  assert.equal(all.m.status, "landed");
  const times = [T0, ...all.points.map((p) => Date.parse(p.at))];
  for (let i = 1; i < times.length; i++) assert.ok(times[i] > times[i - 1], `punto ${i} no avanza`);
  assert.equal(all.m.ended_at, all.m.last!.at);
});

test("instantes fraccionarios y reloj atrasado: puntos estrictamente crecientes", () => {
  const r = onStation();
  const lastMs = Date.parse(r.m.last!.at);
  assert.deepEqual(advance(r.m, CENTER, lastMs + 0.4).points, []);
  const frac = advance(r.m, CENTER, lastMs + 2_000.7);
  for (const p of frac.points) assert.ok(Date.parse(p.at) > lastMs);
  // Abortar con un reloj atrasado no cierra la misión antes de su último punto.
  const ab = advance({ ...r.m, command: "abort" }, CENTER, lastMs - 3_000);
  assert.ok(Date.parse(ab.ended_at!) >= lastMs);
});

test("valores límite: radio 0 y velocidad no finita no producen NaN", () => {
  const base = onStation();
  const zero: DroneMission = { ...base.m, radius_m: 0 };
  const odd: DroneMission = { ...base.m, speed_ms: Number.NaN };
  for (const m of [zero, odd]) {
    const res = run(m, base.now + SAMPLE_MS, { maxMs: 20_000 });
    assert.ok(res.points.length > 0);
    for (const p of res.points) {
      for (const v of [p.lat, p.lng, p.alt_m, p.heading_deg, p.speed_ms, p.battery_pct]) {
        assert.ok(Number.isFinite(v), `valor no finito en ${JSON.stringify(p)}`);
      }
    }
  }
});

test("todos los instantes en ISO UTC con milisegundos", () => {
  const all = run(mission(), T0, { maxMs: 120_000 });
  for (const x of [...all.points, ...all.events]) assert.match(x.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
});

test("secondsUntilOnStation: estima la llegada sin modificar la misión", async () => {
  const { secondsUntilOnStation } = await import("@/lib/drone/sim");
  const m = mission();
  const eta = secondsUntilOnStation(m, CENTER, T0);
  assert.ok(eta !== null && eta > 0);
  // Coincide con lo que tarda el vuelo real a ticks de 2 s.
  const flown = run(m, T0, { maxMs: 600_000, stop: (x) => x.status === "on_station" });
  assert.ok(Math.abs(flown.now - T0 - eta * 1000) <= SAMPLE_MS, `eta ${eta} vs ${(flown.now - T0) / 1000}`);
  assert.equal(m.status, "planned");
  assert.equal(secondsUntilOnStation(flown.m, CENTER, flown.now), 0);
  assert.equal(secondsUntilOnStation({ ...m, command: "recall" }, CENTER, T0), null);
  assert.equal(secondsUntilOnStation(m, CENTER, T0, 5), null);
});
