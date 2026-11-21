import { test } from "node:test";
import assert from "node:assert/strict";
import type { MediaAnalysis } from "@/lib/domain";
import { abcdSide, computeCoverage, sideInText } from "./coverage";
import { fallbackTurn } from "./fallback";
import { applyOps } from "./memory";
import { observe } from "./observe";
import { confirmsRequest, radioRequests } from "./radio";
import { runTool, type TurnContext } from "./tools";
import { emptyVigiaState } from "./types";
import type { World, WorldMedia, WorldRadio } from "./world";

const NOW = Date.parse("2026-11-21T17:00:00.000Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function analysis(people: MediaAnalysis["people"] = []): MediaAnalysis {
  return {
    usable: true,
    unusable_reason: "",
    incident_type: "structure_fire",
    summary: "Casa de dos pisos con humo en el segundo piso.",
    viewpoint: { position_description: "vereda", facing: "unknown", distance_m: 20, elevation: "ground" },
    structure: { present: true, kind: "house_2_story", floors_visible: 2, construction: "unknown", exposures: "", description: "" },
    fire: {
      present: true,
      stage: "growth",
      flames_visible: false,
      locations: [],
      smoke: { present: true, color: "gray", volume: "moderate", description: "" },
      spread_risk: "moderate",
    },
    people,
    vehicles: [],
    hazards: [],
    access: { description: "", obstructions: [], water_sources: [] },
    key_frames: [],
    visible_text: [],
    uncertainties: [],
    confidence: "medium",
  };
}

function media(label: string, side: string | null, people: MediaAnalysis["people"] = []): WorldMedia {
  return {
    id: `id-${label}`,
    label,
    source: "citizen",
    status: "analyzed",
    created_at: iso(60_000),
    analyzed_at: iso(30_000),
    side,
    analysis: analysis(people),
    note: "",
    detections: null,
  };
}

function radio(seq: number, speaker: string, text: string, msAgo = 10_000, obac = false): WorldRadio {
  return { seq, at: iso(msAgo), speaker, channel: "", text, expanded: text, source: "manual", obac };
}

function world(partial: Partial<World> = {}): World {
  return {
    incident: { id: "inc-1", code: "VG-TEST", title: "Incendio", type: "structure_fire", address: "Calle 1", status: "active", lat: -33.4, lng: -70.6, origin: "demo" },
    now: new Date(NOW).toISOString(),
    media: [],
    radio: [],
    drones: [],
    situation: null,
    situation_at: null,
    comms_summary: null,
    scheme: "abcd",
    coverage: [
      { side: "A", media: ["M1", "M2"] },
      { side: "B", media: ["M3"] },
      { side: "C", media: [] },
      { side: "D", media: ["M4"] },
    ],
    blind: ["C"],
    ...partial,
  };
}

function ctxFor(w: World, state = emptyVigiaState("inc-1", iso(600_000))): TurnContext {
  return { world: w, state: structuredClone(state), ops: [], nowMs: NOW, engine: "plantilla", answering: null };
}

test("lados de bomberos: A frente, B, C atrás, D en sentido horario", () => {
  const s = { x: 0, y: 0, rotation_deg: 180 }; // la fachada mira al sur
  assert.equal(abcdSide({ x: 0, y: -20 }, s), "A");
  assert.equal(abcdSide({ x: -20, y: 0 }, s), "B");
  assert.equal(abcdSide({ x: 0, y: 20 }, s), "C");
  assert.equal(abcdSide({ x: 20, y: 0 }, s), "D");
  assert.equal(sideInText("Vigía, ¿se ve alguien en el lado B?", "abcd"), "B");
  assert.equal(sideInText("¿y atrás?", "abcd"), "C");
  assert.equal(sideInText("¿por el poniente?", "cardinal"), "oeste");
});

test("cobertura sin escena: por punto cardinal y sin inventar lados ciegos", () => {
  const inc = { lat: -33.4, lng: -70.6, scene: null };
  const none = computeCoverage(inc, [{ label: "M1", lat: null, lng: null, status: "analyzed", analysis: null, source: "citizen" }]);
  assert.deepEqual(none.blind, []);
  const south = computeCoverage(inc, [{ label: "M1", lat: -33.4005, lng: -70.6, status: "analyzed", analysis: null, source: "citizen" }]);
  assert.equal(south.scheme, "cardinal");
  assert.equal(south.sideOf.M1, "sur");
  assert.deepEqual(south.blind, ["norte", "este", "oeste"]);
});

test("radio: pedidos con claves y su confirmación", () => {
  const reqs = radioRequests("Central, B-3, 6-0, OBAC 43 con 8 voluntarios. Se solicita 2-2 y 1-2.");
  assert.deepEqual(reqs.map((r) => r.clave), ["2-2", "1-2"]);
  assert.equal(radioRequests("B-3 en 6-0 con 8 voluntarios").length, 0);
  assert.equal(confirmsRequest("Central: despacho R-1 al lugar", "2-2", ""), true);
  assert.equal(confirmsRequest("Central: 2-2 en camino", "2-2", ""), true);
  assert.equal(confirmsRequest("Q-8 en el lugar", "2-2", ""), false);
  assert.equal(confirmsRequest("SAMU en camino", "1-2", ""), true);
});

test("observe: presentación, pedidos pendientes y pregunta del OBAC por Zello", () => {
  const w = world({
    media: [media("M1", "A")],
    radio: [
      radio(1, "B-3", "B-3, 6-0, se solicita 2-2", 60_000),
      radio(2, "OBAC", "Vigía, ¿se ve alguien en el lado B?", 5_000, true),
    ],
  });
  const obs = observe(w, emptyVigiaState("inc-1", iso(600_000)), NOW);
  const types = obs.events.map((e) => e.type);
  assert.ok(types.includes("inicio"));
  assert.ok(types.includes("pregunta"));
  assert.ok(types.includes("radio"));
  assert.ok(types.includes("video_analizado"));
  assert.equal(obs.newPending.length, 1);
  assert.equal(obs.newPending[0].clave, "2-2");
  assert.equal(obs.newQuestions[0].from, "zello");
  assert.equal(obs.cursors.comm_seq, 2);
  // Segunda vuelta sin cambios: nada nuevo.
  const state = emptyVigiaState("inc-1", iso(600_000));
  applyOps(state, [{ op: "cursors", cursors: obs.cursors }, { op: "introduced" }, ...obs.newQuestions.map((q) => ({ op: "question_add" as const, q })), ...obs.newQuestions.map((q) => ({ op: "answered" as const, id: q.id }))], NOW);
  const again = observe(w, state, NOW + 1000);
  assert.deepEqual(again.events.map((e) => e.type), []);
});

test("observe: 'Vigía, silencio' por Zello se aplica en código", () => {
  const w = world({ radio: [radio(1, "OBAC", "Vigía, silencio", 1000, true)] });
  const obs = observe(w, { ...emptyVigiaState("inc-1", iso(1000)), introduced: true }, NOW);
  assert.equal(obs.silence, "silence");
  assert.equal(obs.newQuestions[0].answered, true);
});

test("observe: un pendiente sin confirmar se recuerda después del plazo", () => {
  const state = { ...emptyVigiaState("inc-1", iso(600_000)), introduced: true };
  state.pending = [
    { id: "p1", at: iso(400_000), text: "B-3 pidió 2-2", who: "B-3", clave: "2-2", source: "C1", status: "abierto", resolved_at: null, resolved_by: null, reminded_at: null },
  ];
  const obs = observe(world(), state, NOW, { clockMs: 120_000, remindMs: 300_000 });
  assert.ok(obs.events.some((e) => e.type === "pendiente_vencido"));
});

test("plantillas: presentación con lo que no ve, pedido de video y respuesta 'no lo veo' con cobertura", () => {
  const w = world({ media: [media("M1", "A"), media("M2", "A"), media("M3", "B"), media("M4", "D")] });
  const ctx = ctxFor(w);
  fallbackTurn(ctx, [{ type: "inicio" }]);
  const texts = ctx.ops.flatMap((o) => (o.op === "utter" ? [o.u.text] : []));
  assert.match(texts[0], /estoy mirando 4 videos/);
  assert.match(texts[0], /no veo el lado C/);
  assert.ok(ctx.ops.some((o) => o.op === "video_request" && /Sin acercarse\.$/.test(o.r.text)));

  const ctx2 = ctxFor(w);
  fallbackTurn(ctx2, [
    { type: "pregunta", question: { id: "q1", at: iso(1000), text: "Vigía, ¿se ve alguien en el lado B?", from: "zello", comm_seq: 9, reply_to: null, answered: false } },
  ]);
  const reply = ctx2.ops.find((o) => o.op === "utter");
  assert.ok(reply && reply.op === "utter");
  assert.match(reply.u.text, /no lo veo en el lado B/);
  assert.match(reply.u.text, /1 de 4 videos/);
  assert.doesNotMatch(reply.u.text, /no hay/i);
});

test("plantillas: posible persona con 'vista en N de M videos' y prioridad persona", () => {
  const person = [{ status: "at_window_or_balcony" as const, count: 1, location: "ventana del tercer piso", floor: 3, frame_refs: [2], confidence: "high" as const, description: "" }];
  const w = world({ media: [media("M1", "B", person), media("M3", "B", person), media("M2", "A")] });
  const ctx = ctxFor(w);
  fallbackTurn(ctx, [{ type: "video_analizado", media: [w.media[0]] }]);
  const alert = ctx.ops.find((o) => o.op === "utter" && o.u.priority === "persona");
  assert.ok(alert && alert.op === "utter");
  assert.match(alert.u.text, /posible persona en ventana del tercer piso, el lado B\. Vista en 2 de 2 videos/);
});

test("herramientas: hablarle_al_obac bloquea órdenes y respeta el límite de 20 s", () => {
  const ctx = ctxFor(world());
  const blocked = runTool(ctx, "hablarle_al_obac", { texto: "Entren por el lado A.", tipo: "alerta", prioridad: "riesgo" });
  assert.equal(blocked.isError, true);
  const first = runTool(ctx, "hablarle_al_obac", { texto: "OBAC, Vigía: humo denso en el lado A.", tipo: "alerta", prioridad: "riesgo" });
  assert.match(first.content, /Dicho por radio/);
  const second = runTool(ctx, "hablarle_al_obac", { texto: "OBAC, Vigía: B-5 llegando.", tipo: "resumen", prioridad: "resto" });
  assert.match(second.content, /Solo en pantalla \(límite de 20 s\)/);
  const person = runTool(ctx, "hablarle_al_obac", { texto: "OBAC, Vigía: posible persona en ventana, lado B.", tipo: "alerta", prioridad: "persona" });
  assert.match(person.content, /Dicho por radio/);

  // applyOps decide lo mismo al guardar.
  const state = emptyVigiaState("inc-1", iso(1000));
  const added = applyOps(state, ctx.ops, NOW);
  assert.deepEqual(added.map((u) => u.speak), [true, false, true]);
  assert.deepEqual(added.map((u) => u.seq), [1, 2, 3]);
});

test("herramientas: propuesta nunca va por voz; pedir_video agrega 'Sin acercarse'", () => {
  const ctx = ctxFor(world());
  runTool(ctx, "proponer_mensaje", { mensaje_claves: "B-3, 7-2", explicacion: "Para saber dónde está B-3." });
  runTool(ctx, "pedir_video", { zona: "del lado C", motivo: "Ningún video lo cubre." });
  const rejected = runTool(ctx, "pedir_video", { zona: "entrando al pasaje del lado C", motivo: "x" });
  assert.equal(rejected.isError, true);
  const state = emptyVigiaState("inc-1", iso(1000));
  const added = applyOps(state, ctx.ops, NOW);
  const propuesta = added.find((u) => u.kind === "propuesta");
  assert.equal(propuesta?.speak, false);
  assert.equal(propuesta?.claves, "B-3, 7-2");
  assert.match(state.video_requests[0].text, /^Bomberos necesita un video del lado C, desde la vereda\. Sin acercarse\.$/);
});

test("observe: dos radios a la vez → resumen apenas se callan", () => {
  const state = { ...emptyVigiaState("inc-1", iso(600_000)), introduced: true };
  state.cursors.last_clock_at = iso(120_000 - 1000);
  state.cursors.comm_seq = 2;
  const w = world({ radio: [radio(1, "B-3", "B-3, 6-0", 12_000), radio(2, "B-5", "B-5, 6-3 por el lado C", 9_000)] });
  const talking = observe(w, state, NOW - 8_000);
  assert.ok(!talking.events.some((e) => e.type === "reloj"), "no resume mientras siguen hablando");
  const quiet = observe(w, state, NOW);
  const reloj = quiet.events.find((e) => e.type === "reloj");
  assert.ok(reloj && reloj.type === "reloj");
  assert.equal(reloj.radio.length, 2);
  const after = observe(w, { ...state, cursors: quiet.cursors }, NOW + 3000);
  assert.ok(!after.events.some((e) => e.type === "reloj"), "un solo resumen por ráfaga");
});

test("observe: YOLO en vivo del dron despierta a Vigía solo cuando aparece algo crítico nuevo", () => {
  const det = (label: string, conf: number, pose: "tendido" | "de_pie" | null = null) => ({
    label, conf, box: [0.1, 0.1, 0.2, 0.3] as [number, number, number, number], zone: { h: "centro" as const, v: "medio" as const }, pose,
  });
  const drone = (seq: number, detections: ReturnType<typeof det>[]) => ({
    mission_id: "m1", label: "D1", active: true, insights: [],
    live: { seq, at: iso(1000), result: { width: 640, height: 360, ms: 80, detections, counts: Object.fromEntries(detections.map((d) => [d.label, 1])) } },
  });
  const state = { ...emptyVigiaState("inc-1", iso(60_000)), introduced: true };
  const first = observe(world({ drones: [drone(10, [det("persona", 0.86), det("auto", 0.9)])] }), state, NOW);
  const ev = first.events.find((e) => e.type === "dron_yolo");
  assert.ok(ev && ev.type === "dron_yolo");
  assert.deepEqual(ev.found.map((f) => f.label), ["persona"]);
  const again = observe(world({ drones: [drone(11, [det("persona", 0.8)])] }), { ...state, cursors: first.cursors }, NOW + 500);
  assert.ok(!again.events.some((e) => e.type === "dron_yolo"), "la misma persona no vuelve a despertar");
  const lying = observe(world({ drones: [drone(12, [det("persona", 0.8, "tendido")])] }), { ...state, cursors: again.cursors }, NOW + 1000);
  assert.ok(lying.events.some((e) => e.type === "dron_yolo"), "una persona tendida sí");
});
