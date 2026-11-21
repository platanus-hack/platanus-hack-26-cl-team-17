import { test } from "node:test";
import assert from "node:assert/strict";
import type { MediaView } from "@/lib/contract";
import { CreateMissionInputSchema, type DroneMission, type TelemetryPoint } from "@/lib/domain";
import { destination } from "@/lib/geo";
import { SHOWCASE_A } from "@/lib/demo/data-showcase-a";
import {
  absoluteSensorUrl,
  ALTITUDE_MAX_M,
  ALTITUDE_MIN_M,
  BATCH_MAX_CHIPS,
  batchDigest,
  batchThumbUrl,
  NO_PEOPLE_NOTE,
  batteryRatio,
  batteryTone,
  bridgeCommand,
  distanceToIncidentM,
  droneBatchesFor,
  isLoopbackOrigin,
  pendingCommandText,
  RADIUS_MAX_M,
  RADIUS_MIN_M,
  shellQuote,
  signalState,
  splitMissions,
  trackToSvg,
  validateMissionForm,
} from "./model";

const CENTER = { lat: -33.4569, lng: -70.5987 };
const NOW = Date.parse("2026-11-21T12:00:00.000Z");
const isoAgo = (s: number) => new Date(NOW - s * 1000).toISOString();

function point(secondsAgo: number, over: Partial<TelemetryPoint> = {}): TelemetryPoint {
  return { at: isoAgo(secondsAgo), lat: CENTER.lat, lng: CENTER.lng, alt_m: 45, heading_deg: 0, speed_ms: 8, battery_pct: 90, ...over };
}

function mission(over: Partial<DroneMission> = {}): DroneMission {
  return {
    id: "m1",
    incident_id: "i1",
    label: "D1",
    status: "on_station",
    mode: "simulated",
    pattern: "orbit",
    radius_m: 60,
    altitude_m: 45,
    speed_ms: 8,
    home_lat: CENTER.lat,
    home_lng: CENTER.lng,
    waypoints: [],
    command: "continue",
    last: point(2),
    track: [],
    frames_received: 0,
    created_at: isoAgo(120),
    started_at: isoAgo(118),
    ended_at: null,
    ...over,
  };
}

test("señal: en vivo, dudosa a los 10 s y perdida a los 30 s", () => {
  assert.equal(signalState(mission({ last: point(3) }), NOW).tone, "ok");
  const stale = signalState(mission({ last: point(12) }), NOW);
  assert.equal(stale.level, "stale");
  assert.equal(stale.tone, "warning");
  assert.equal(stale.text, "Sin señal hace 12 s");
  const lost = signalState(mission({ last: point(95) }), NOW);
  assert.equal(lost.level, "lost");
  assert.equal(lost.tone, "critical");
  assert.equal(lost.text, "Sin señal hace 1 min 35 s");
});

test("señal: misión terminada nunca alarma", () => {
  const s = signalState(mission({ status: "landed", last: point(600) }), NOW);
  assert.equal(s.level, "ended");
  assert.equal(s.tone, "neutral");
  assert.equal(signalState(mission({ status: "aborted", last: null }), NOW).level, "never");
});

test("señal: sin primer dato espera y luego advierte", () => {
  assert.equal(signalState(mission({ status: "planned", last: null, created_at: isoAgo(5) }), NOW).level, "waiting");
  const long = signalState(mission({ status: "planned", last: null, created_at: isoAgo(45) }), NOW);
  assert.equal(long.level, "waiting_long");
  assert.equal(long.tone, "warning");
});

test("señal: reloj adelantado del servidor no da edades negativas; sin reloj no inventa edad", () => {
  const ahead = signalState(mission({ last: point(-5) }), NOW);
  assert.equal(ahead.ageS, 0);
  assert.equal(signalState(mission(), null).ageS, null);
});

test("batería: advertencia bajo 35 %, crítica bajo 25 %", () => {
  assert.equal(batteryTone(80), "ok");
  assert.equal(batteryTone(35), "ok");
  assert.equal(batteryTone(34.9), "warning");
  assert.equal(batteryTone(25), "warning");
  assert.equal(batteryTone(24), "critical");
  assert.equal(batteryTone(null), "neutral");
  assert.equal(batteryRatio(63), 0.63);
  assert.equal(batteryRatio(140), 1);
  assert.equal(batteryRatio(undefined), null);
});

test("distancia al incidente desde el último punto", () => {
  const p = destination(CENTER, 90, 60);
  const d = distanceToIncidentM(p, CENTER);
  assert.ok(d !== null && Math.abs(d - 60) < 0.5, `distancia ${d}`);
  assert.equal(distanceToIncidentM(null, CENTER), null);
});

test("traza: incidente al centro, Norte arriba, órbita y último punto", () => {
  const north = destination(CENTER, 0, 60);
  const east = destination(CENTER, 90, 60);
  const svg = trackToSvg([north, east], CENTER, { radiusM: 60, pattern: "orbit", size: 120 });
  assert.equal(svg.size, 120);
  assert.ok(svg.path.startsWith("M60 "), svg.path);
  assert.ok(svg.orbitR > 0 && svg.orbitR < 60);
  assert.ok(svg.current && svg.current.x > 60 && Math.abs(svg.current.y - 60) < 0.2, JSON.stringify(svg.current));
  // El punto Norte queda arriba (y menor que el centro).
  const firstY = Number(svg.path.split(" ")[1]);
  assert.ok(firstY < 60);
});

test("traza: incluye el despegue lejano, recorta a los últimos puntos y no dibuja órbita en punto fijo", () => {
  const far = destination(CENTER, 180, 300);
  const svg = trackToSvg([far, CENTER], CENTER, { radiusM: 60, pattern: "hover" });
  assert.equal(svg.orbitR, 0);
  assert.ok(svg.halfExtentM >= 300);
  const many = Array.from({ length: 300 }, (_, i) => destination(CENTER, i, 60));
  const cut = trackToSvg(many, CENTER, { radiusM: 60, pattern: "orbit", maxPoints: 120 });
  assert.equal(cut.path.split("L").length, 120);
  assert.equal(trackToSvg([], CENTER, { radiusM: 60, pattern: "orbit" }).path, "");
});

test("misiones: activas e historial, la más reciente primero", () => {
  const a = mission({ id: "a", created_at: isoAgo(300), status: "landed" });
  const b = mission({ id: "b", created_at: isoAgo(100) });
  const c = mission({ id: "c", created_at: isoAgo(50), status: "aborted" });
  const d = mission({ id: "d", created_at: isoAgo(10), status: "planned" });
  const { active, finished } = splitMissions([a, b, c, d]);
  assert.deepEqual(active.map((m) => m.id), ["d", "b"]);
  assert.deepEqual(finished.map((m) => m.id), ["c", "a"]);
});

test("lotes del dron: solo source drone de esa misión; miniatura póster o primer cuadro", () => {
  const base = { urls: { video: null, poster: null, frames: [] } } as unknown as MediaView;
  const media = [
    { ...base, id: "1", source: "drone", mission_id: "m1", created_at: isoAgo(60) },
    { ...base, id: "2", source: "citizen", mission_id: null, created_at: isoAgo(50) },
    { ...base, id: "3", source: "drone", mission_id: "m2", created_at: isoAgo(40) },
    { ...base, id: "4", source: "drone", mission_id: "m1", created_at: isoAgo(30) },
  ] as MediaView[];
  assert.deepEqual(droneBatchesFor(media, "m1").map((m) => m.id), ["4", "1"]);
  assert.equal(batchThumbUrl({ urls: { video: null, poster: "/p.jpg", frames: [{ idx: 0, t_s: 0, url: "/f0.jpg", width: 1, height: 1 }] } }), "/p.jpg");
  assert.equal(batchThumbUrl({ urls: { video: null, poster: null, frames: [{ idx: 0, t_s: 0, url: "/f0.jpg", width: 1, height: 1 }] } }), "/f0.jpg");
  assert.equal(batchThumbUrl({ urls: { video: null, poster: null, frames: [] } }), null);
});

test("orden pendiente en mayúsculas", () => {
  assert.equal(pendingCommandText("recall"), "RETORNAR");
  assert.equal(pendingCommandText("abort"), "ABORTAR");
  assert.equal(pendingCommandText("continue"), null);
});

test("formulario: acepta valores sanos y los límites coinciden con el esquema", () => {
  const r = validateMissionForm({ mode: "simulated", pattern: "orbit", radius: "60", altitude: "45" });
  assert.ok(r.ok);
  if (r.ok) assert.deepEqual([r.input.radius_m, r.input.altitude_m, r.input.speed_ms], [60, 45, 8]);
  for (const [radius, altitude, ok] of [
    [RADIUS_MIN_M, ALTITUDE_MIN_M, true],
    [RADIUS_MAX_M, ALTITUDE_MAX_M, true],
    [RADIUS_MIN_M - 1, 45, false],
    [60, ALTITUDE_MAX_M + 1, false],
  ] as const) {
    const schemaOk = CreateMissionInputSchema.safeParse({ mode: "api", radius_m: radius, altitude_m: altitude }).success;
    assert.equal(schemaOk, ok);
    assert.equal(validateMissionForm({ mode: "api", pattern: "orbit", radius: String(radius), altitude: String(altitude) }).ok, ok);
  }
});

test("formulario: errores en español; coma decimal; punto fijo ignora el radio", () => {
  const bad = validateMissionForm({ mode: "device", pattern: "grid", radius: "", altitude: "abc" });
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.equal(bad.errors.radius, "Escribe un radio entre 10 y 500 m.");
    assert.equal(bad.errors.altitude, "Escribe una altura entre 10 y 120 m.");
  }
  const comma = validateMissionForm({ mode: "device", pattern: "orbit", radius: "62,5", altitude: "40" });
  assert.ok(comma.ok && comma.input.radius_m === 62.5);
  assert.ok(validateMissionForm({ mode: "simulated", pattern: "hover", radius: "", altitude: "30" }).ok);
});

test("enlace absoluto del modo sensor y comando del puente", () => {
  assert.equal(absoluteSensorUrl("https://10.0.0.5:3100", "/dron/abc?t=x%2By"), "https://10.0.0.5:3100/dron/abc?t=x%2By");
  const cmd = bridgeCommand({ origin: "http://localhost:3100", missionId: "abc", token: "tok_123-Z", lat: -33.4569, lng: -70.5987 });
  assert.equal(
    cmd,
    "python3 tools/drone_bridge.py --url http://localhost:3100 --mission abc --token tok_123-Z --simulate --lat -33.456900 --lng -70.598700",
  );
  assert.equal(shellQuote("a b'c"), `'a b'\\''c'`);
  assert.equal(shellQuote("$(rm)"), `'$(rm)'`);
});

test("origen local que otro equipo no puede abrir", () => {
  assert.equal(isLoopbackOrigin("http://localhost:3100"), true);
  assert.equal(isLoopbackOrigin("http://127.0.0.1:3100"), true);
  assert.equal(isLoopbackOrigin("https://192.168.1.20:3100"), false);
  assert.equal(isLoopbackOrigin("https://vigia.example"), false);
});

/* ───────────── Lotes del dron: resumen ───────────── */

const ANALYSIS = SHOWCASE_A.media.find((m) => m.source === "drone")!.analysis;
const frames = (n: number) =>
  Array.from({ length: n }, (_, idx) => ({ idx })) as unknown as MediaView["frames"];

test("lote: estados previos al análisis en español", () => {
  assert.deepEqual(batchDigest({ status: "uploading", error: null, analysis: null, frames: frames(3) }).text, "Reuniendo cuadros (3 de 6)");
  assert.equal(batchDigest({ status: "uploaded", error: null, analysis: null, frames: frames(6) }).phase, "queued");
  assert.equal(batchDigest({ status: "analyzing", error: null, analysis: null, frames: frames(6) }).phase, "analyzing");
  const failed = batchDigest({ status: "failed", error: "Sin fotogramas útiles", analysis: null, frames: frames(6) });
  assert.equal(failed.phase, "failed");
  assert.equal(failed.text, "Sin fotogramas útiles");
  // Un medio "analizado" sin análisis no se presenta como listo.
  assert.equal(batchDigest({ status: "analyzed", error: null, analysis: null, frames: frames(6) }).phase, "queued");
});

test("lote: personas en riesgo primero (atrapada antes que evacuando), peligros altos y tope de chips", () => {
  const analysis = {
    ...ANALYSIS,
    usable: true,
    people: [
      { ...ANALYSIS.people[0], status: "evacuating" as const, count: 3 },
      { ...ANALYSIS.people[0], status: "bystander" as const, count: 9 },
      { ...ANALYSIS.people[0], status: "trapped" as const, count: 0 },
    ],
    hazards: [
      { kind: "power_lines" as const, description: "", severity: "medium" as const, frame_refs: [] },
      { kind: "gas_cylinder" as const, description: "", severity: "high" as const, frame_refs: [] },
      { kind: "traffic" as const, description: "", severity: "low" as const, frame_refs: [] },
    ],
  };
  const d = batchDigest({ status: "analyzed", error: null, analysis, frames: frames(6) });
  assert.equal(d.phase, "analyzed");
  assert.equal(d.text, ANALYSIS.summary.trim());
  assert.deepEqual(
    d.chips.map((c) => [c.tone, c.text]),
    [
      ["critical", "1 · Persona atrapada"],
      ["warning", "3 · Evacuando"],
      ["critical", "Cilindro de gas"],
      ["warning", "Tendido eléctrico"],
    ],
  );
  assert.equal(d.noPeopleNote, null);

  const many = { ...analysis, people: Array.from({ length: 8 }, () => ({ ...ANALYSIS.people[0], status: "trapped" as const, count: 1 })) };
  const capped = batchDigest({ status: "analyzed", error: null, analysis: many, frames: frames(6) });
  assert.equal(capped.chips.length, BATCH_MAX_CHIPS + 1);
  assert.match(capped.chips.at(-1)!.text, /^\+\d+ más$/);
});

test("lote: sin personas vistas la IA NO descarta víctimas", () => {
  const analysis = { ...ANALYSIS, people: [{ ...ANALYSIS.people[0], status: "responder" as const }] };
  const d = batchDigest({ status: "analyzed", error: null, analysis, frames: frames(6) });
  assert.equal(d.noPeopleNote, NO_PEOPLE_NOTE);
  assert.match(NO_PEOPLE_NOTE, /no descarta víctimas/i);
  const unusable = batchDigest({
    status: "analyzed",
    error: null,
    analysis: { ...analysis, usable: false, unusable_reason: "humo denso" },
    frames: frames(6),
  });
  assert.ok(unusable.chips.some((c) => c.text === "Poco útil: humo denso"));
  assert.equal(unusable.noPeopleNote, NO_PEOPLE_NOTE);
});
