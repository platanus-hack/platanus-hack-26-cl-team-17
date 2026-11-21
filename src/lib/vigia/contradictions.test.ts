/**
 * Contradicciones radio ↔ imagen: cinco casos realistas de punta a punta (radio + video o
 * detector → observe → plantillas → lo que se le dice al OBAC) y los bordes que no deben avisar.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { MediaAnalysis } from "@/lib/domain";
import type { Detection } from "@/lib/vision/types";
import { contradictionText, crossCheck, radioClaims } from "./contradictions";
import { fallbackTurn } from "./fallback";
import { applyOps } from "./memory";
import { observe, type VigiaEvent } from "./observe";
import type { TurnContext } from "./tools";
import { emptyVigiaState, type VigiaState } from "./types";
import type { World, WorldDrone, WorldMedia, WorldRadio } from "./world";

const NOW = Date.parse("2026-11-21T17:00:00.000Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

type Person = MediaAnalysis["people"][number];

function analysis(over: { people?: Person[]; hazards?: MediaAnalysis["hazards"]; flames?: boolean; stage?: MediaAnalysis["fire"]["stage"] } = {}): MediaAnalysis {
  return {
    usable: true,
    unusable_reason: "",
    incident_type: "structure_fire",
    summary: "Edificio de cuatro pisos con humo.",
    viewpoint: { position_description: "vereda", facing: "unknown", distance_m: 25, elevation: "ground" },
    structure: { present: true, kind: "apartment_building", floors_visible: 4, construction: "unknown", exposures: "", description: "" },
    fire: {
      present: true,
      stage: over.stage ?? "incipient",
      flames_visible: over.flames ?? false,
      locations: [],
      smoke: { present: true, color: "gray", volume: "moderate", description: "" },
      spread_risk: "moderate",
    },
    people: over.people ?? [],
    vehicles: [],
    hazards: over.hazards ?? [],
    access: { description: "", obstructions: [], water_sources: [] },
    key_frames: [],
    visible_text: [],
    uncertainties: [],
    confidence: "medium",
  };
}

function media(label: string, a: MediaAnalysis, over: Partial<WorldMedia> = {}): WorldMedia {
  return {
    id: `id-${label}`,
    label,
    source: "citizen",
    status: "analyzed",
    created_at: iso(120_000),
    analyzed_at: iso(60_000),
    side: "B",
    analysis: a,
    note: "",
    detections: null,
    ...over,
  };
}

function radio(seq: number, speaker: string, text: string, msAgo = 30_000, obac = false): WorldRadio {
  return { seq, at: iso(msAgo), speaker, channel: "", text, expanded: text, source: "zello", obac };
}

function det(label: string, conf: number, pose: Detection["pose"] = null): Detection {
  return { label, conf, box: [0.4, 0.3, 0.5, 0.6], zone: { h: "centro", v: "medio" }, pose };
}

function drone(label: string, detections: Detection[]): WorldDrone {
  return {
    mission_id: `mis-${label}`,
    label,
    active: true,
    insights: [],
    live: { seq: 40, at: iso(2_000), result: { width: 640, height: 360, ms: 70, detections, counts: Object.fromEntries(detections.map((d) => [d.label, 1])) } },
  };
}

function world(partial: Partial<World>): World {
  return {
    incident: { id: "inc-1", code: "VG-TEST", title: "Incendio en edificio", type: "structure_fire", address: "Av. Independencia 1350", status: "active", lat: -33.42, lng: -70.66, origin: "demo" },
    now: new Date(NOW).toISOString(),
    media: [],
    radio: [],
    drones: [],
    situation: null,
    situation_at: null,
    comms_summary: null,
    scheme: "abcd",
    coverage: [],
    blind: [],
    ...partial,
  };
}

function introduced(): VigiaState {
  // Ya presentado y con la radio leída: el caso aísla el cruce (sin presentación ni resumen).
  const s = { ...emptyVigiaState("inc-1", iso(600_000)), introduced: true };
  s.cursors.comm_seq = 99;
  s.cursors.last_clock_at = iso(1_000);
  return s;
}

/** Observa, responde con plantillas y guarda: lo que Vigía le dijo al OBAC en esa vuelta. */
function turn(w: World, state = introduced()) {
  const obs = observe(w, state, NOW);
  const ctx: TurnContext = { world: w, state: structuredClone(state), ops: [], nowMs: NOW, engine: "plantilla", answering: null };
  fallbackTurn(ctx, obs.events);
  const saved = structuredClone(state);
  const said = applyOps(saved, ctx.ops, NOW).filter((u) => u.kind === "contradiccion");
  return { obs, said, saved: { ...saved, cursors: obs.cursors } };
}

function crossEvent(events: VigiaEvent[]) {
  const e = events.find((x) => x.type === "contradiccion");
  return e && e.type === "contradiccion" ? e : null;
}

const atWindow3: Person = {
  status: "at_window_or_balcony",
  count: 1,
  location: "ventana del tercer piso, costado derecho",
  floor: 3,
  frame_refs: [4],
  confidence: "high",
  description: "Persona haciendo señas",
};

/* ───────────────────────────── 5 casos realistas ───────────────────────────── */

test("caso 1: «tercer piso despejado» por radio y un video con una persona en esa ventana", () => {
  const w = world({
    radio: [radio(5, "B-3", "B-3 a Central, en el lugar. Tercer piso despejado, seguimos al cuarto.")],
    media: [media("M2", analysis({ people: [atWindow3] }))],
  });
  const { obs, said } = turn(w);
  assert.deepEqual(crossEvent(obs.events)?.contradictions.map((c) => c.sources), [["M2", "C5"]]);
  assert.equal(said.length, 1);
  const u = said[0];
  assert.match(u.text, /^OBAC, Vigía: no calza: M2 muestra posible persona en ventana del tercer piso/);
  assert.match(u.text, /B-3 informó «Tercer piso despejado, seguimos al cuarto» \(C5\)/);
  assert.deepEqual(u.evidence, ["M2", "C5"]);
  assert.equal(u.priority, "persona");
  assert.equal(u.speak, true, "una posible persona se dice por radio siempre");
});

test("caso 2: «sin gas, corte realizado» y el detector en vivo del dron ve un cilindro", () => {
  const w = world({
    radio: [radio(7, "B-5", "B-5: sin gas en la vivienda, corte de gas realizado con la compañía.")],
    drones: [drone("D1", [det("cilindro_gas", 0.71), det("humo", 0.4)])],
  });
  const { said } = turn(w);
  assert.equal(said.length, 1);
  assert.match(said[0].text, /El dron D1 detecta posible cilindro de gas \(detección automática 71 %\), pero B-5 informó «.*sin gas en la vivienda.*» \(C7\)/);
  assert.deepEqual(said[0].evidence, ["D1", "C7"]);
  assert.equal(said[0].priority, "riesgo");
});

test("caso 3: «fuego controlado» y un video grabado después con llamas activas", () => {
  const w = world({
    radio: [radio(9, "B-3", "Fuego controlado, comenzamos remoción en el segundo piso.", 300_000)],
    media: [media("M4", analysis({ flames: true, stage: "fully_developed" }), { created_at: iso(60_000) })],
  });
  const { said } = turn(w);
  assert.equal(said.length, 1);
  assert.match(said[0].text, /M4, grabado después, muestra llamas activas, pero B-3 informó «Fuego controlado, comenzamos remoción en el segundo piso» \(C9\)/);
  assert.deepEqual(said[0].evidence, ["M4", "C9"]);
});

test("caso 4: «búsqueda primaria negativa» y el dron detecta una persona tendida", () => {
  const w = world({
    radio: [radio(11, "R-1", "R-1: búsqueda primaria negativa, no hay personas en el interior.")],
    drones: [drone("D1", [det("persona", 0.82, "tendido")])],
  });
  const { said } = turn(w);
  assert.equal(said.length, 1);
  assert.match(said[0].text, /El dron D1 detecta posible persona tendida \(detección automática 82 %\), pero R-1 informó «.*búsqueda primaria negativa.*» \(C11\)/);
  assert.deepEqual(said[0].evidence, ["D1", "C11"]);
  assert.equal(said[0].priority, "persona");
});

test("caso 5: «no hay balones de gas» y YOLO ve un cilindro en el video de un vecino", () => {
  const w = world({
    radio: [radio(3, "B-5", "No hay balones de gas en el patio.")],
    media: [media("M3", analysis(), { detections: [{ label: "cilindro_gas", max_count: 1, max_conf: 0.66, frames: 3 }] })],
  });
  const { said } = turn(w);
  assert.equal(said.length, 1);
  assert.match(said[0].text, /M3 muestra posible cilindro de gas \(detección automática 66 %\), pero B-5 informó «No hay balones de gas en el patio» \(C3\)/);
  assert.deepEqual(said[0].evidence, ["M3", "C3"]);
});

/* ───────────────────────────── lo que no debe avisar ───────────────────────────── */

test("bordes: otro piso, persona que es bombero o transeúnte, detección débil y llamas de antes del control", () => {
  const second: Person = { ...atWindow3, floor: 2, location: "ventana del segundo piso" };
  const responder: Person = { ...atWindow3, status: "responder", description: "Bombero en la ventana" };
  const w = world({
    radio: [
      radio(5, "B-3", "Tercer piso despejado."),
      radio(7, "B-5", "Sin gas."),
      radio(9, "B-3", "Fuego controlado.", 60_000),
    ],
    media: [
      media("M1", analysis({ people: [second] })),
      media("M2", analysis({ people: [responder] })),
      media("M5", analysis({ flames: true, stage: "fully_developed" }), { created_at: iso(120_000) }),
    ],
    drones: [drone("D1", [det("cilindro_gas", 0.2)])],
  });
  assert.deepEqual(crossCheck(w), []);
});

test("bordes: preguntas, frases negadas y lo que dice el OBAC no son afirmaciones de la radio", () => {
  assert.deepEqual(radioClaims(radio(1, "B-3", "¿Tercer piso despejado?")), []);
  assert.deepEqual(radioClaims(radio(2, "B-5", "Todavía no hay corte de gas realizado.")), []);
  assert.deepEqual(radioClaims(radio(3, "B-3", "No está controlado el fuego.")), []);
  assert.deepEqual(radioClaims(radio(4, "OBAC", "Vigía, sin gas en el sector", 1000, true)), []);
});

test("la radio en sus variantes: piso por número u ordinal, y descarte de toda la estructura", () => {
  const claim = (text: string) => radioClaims(radio(1, "B-3", text)).map((c) => `${c.kind}:${c.floor ?? "todo"}`);
  assert.deepEqual(claim("Piso 3 despejado"), ["sin_personas:3"]);
  assert.deepEqual(claim("3er piso despejado, subimos"), ["sin_personas:3"]);
  assert.deepEqual(claim("No hay nadie en el segundo piso"), ["sin_personas:2"]);
  assert.deepEqual(claim("Cuarto piso revisado, sin novedad"), ["sin_personas:4"]);
  assert.deepEqual(claim("Sin atrapados, casa evacuada"), ["sin_personas:todo"]);
  assert.deepEqual(claim("Gas cortado y fuego controlado"), ["sin_gas:todo", "fuego_controlado:todo"]);
  assert.deepEqual(claim("Acceso despejado por el pasaje"), []);
});

/* ───────────────────────────── memoria y fusión ───────────────────────────── */

test("se avisa una sola vez, y la fusión que trae la misma contradicción no la repite", () => {
  const w = world({
    radio: [radio(5, "B-3", "Tercer piso despejado.")],
    media: [media("M2", analysis({ people: [atWindow3] }))],
  });
  const first = turn(w);
  assert.equal(first.said.length, 1);
  const again = turn(w, first.saved);
  assert.equal(again.said.length, 0, "el mismo cruce no se vuelve a decir");

  // Llega el informe de situación con la misma contradicción (otras palabras, mismas fuentes).
  const fused = world({
    ...w,
    situation_at: iso(500),
    situation: {
      headline: "Incendio en edificio",
      contradictions: [{ description: "Video M2 muestra persona en ventana del 3.er piso; C5 informa piso despejado.", sources: ["C5", "M2"] }],
      insights: [],
      trapped: { status: "possible", count_min: 0, count_max: 1, locations: [], basis: "", evidence: [] },
    } as unknown as World["situation"],
  });
  const third = turn(fused, again.saved);
  assert.equal(third.said.length, 0, "la fusión no repite lo que el cruce ya avisó");
});

test("una contradicción larga de la fusión igual nombra las dos fuentes al OBAC", () => {
  const long = {
    description:
      "M2, M3 y M6 muestran persona(s) en situación de atrapamiento en el costado derecho del edificio, con humo denso saliendo por las ventanas del tercer y cuarto piso, pero la unidad B-3 informó por radio que no hay personas atrapadas. Confirmar.",
    sources: ["M2", "M3", "M6", "C14"],
  };
  const text = contradictionText(long);
  for (const s of long.sources) assert.match(text, new RegExp(`\\b${s}\\b`), `falta ${s}`);
  assert.ok(text.length < 260, `demasiado largo para la radio: ${text.length}`);
});
