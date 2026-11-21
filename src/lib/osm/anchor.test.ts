import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SceneModel } from "@/lib/domain";
import { ANCHOR_NOTE_PREFIX, ANCHOR_WARNING_PREFIX, anchorModeFor, anchorScene, sameRoadName } from "./anchor";
import type { OsmBuilding, OsmContext, OsmRoad, OsmXY } from "./types";

type Vehicle = SceneModel["vehicles"][number];
type Structure = SceneModel["structures"][number];

function scene(over: Partial<SceneModel> = {}): SceneModel {
  return {
    description: "Escena",
    ground: { street_axis_deg: 90, notes: "" },
    roads: [],
    structures: [],
    fire_zones: [],
    smoke_plumes: [],
    people: [],
    vehicles: [],
    hazards: [],
    access_points: [],
    cameras: [],
    annotations: [],
    uncertainty_notes: ["Nota previa."],
    confidence: "medium",
    ...over,
  };
}

const vehicle = (id: string, x: number, y: number, rotation_deg = 90): Vehicle => ({
  id,
  kind: "car",
  state: "upright",
  x,
  y,
  rotation_deg,
  length_m: 4.5,
  width_m: 1.8,
  entrapment_suspected: false,
  burning: false,
  note: "",
});

const structure = (over: Partial<Structure> = {}): Structure => ({
  id: "S1",
  label: "Casa",
  kind: "house_2_story",
  role: "involved",
  x: 0,
  y: 0,
  width_m: 10,
  depth_m: 12,
  floors: 2,
  floor_height_m: 2.7,
  rotation_deg: 180,
  roof: "gable",
  construction: "unknown",
  confidence: "medium",
  notes: "",
  ...over,
});

const person = (id: string, x: number, y: number) => ({
  id,
  status: "trapped" as const,
  count: 1,
  structure_id: "",
  floor: 0,
  x,
  y,
  z: 0,
  confidence: "medium" as const,
  note: "",
  evidence: [],
});

const road = (id: string, cls: string, name: string | null, points: OsmXY[]): OsmRoad => ({ id, cls, name, points });
const rect = (cx: number, cy: number, w: number, d: number, rotDeg = 0): OsmXY[] => {
  const r = (rotDeg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [
    [-w / 2, -d / 2],
    [w / 2, -d / 2],
    [w / 2, d / 2],
    [-w / 2, d / 2],
  ].map(([x, y]) => ({ x: cx + x * c + y * s, y: cy - x * s + y * c }));
};
const building = (id: string, ring: OsmXY[]): OsmBuilding => ({ id, rings: [ring], height: 6, minHeight: 0 });

/** Manzana de 40×40 m centrada en el origen, Avenida Test (E–O) a y = 30 y un pasaje (N–S) a x = −30. */
function blockCtx(): OsmContext {
  return {
    buildings: [building("b1", rect(0, 0, 40, 40))],
    roads: [
      road("100:0.0", "primary", "Avenida Test", [{ x: -200, y: 30 }, { x: 200, y: 30 }]),
      road("200:0.0", "minor", "Pasaje Lateral", [{ x: -30, y: -200 }, { x: -30, y: 200 }]),
    ],
  };
}

const inside = (p: OsmXY, ring: OsmXY[]) => {
  let r = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) r = !r;
  }
  return r;
};
const anchorNotes = (s: SceneModel) => s.uncertainty_notes.filter((n) => n.startsWith(ANCHOR_NOTE_PREFIX));

describe("anchorScene · tránsito", () => {
  const crash = () =>
    scene({
      roads: [{ id: "R1", name: "Av. Test", x1: -100, y1: 0, x2: 100, y2: 0, width_m: 10, blocked: true }],
      vehicles: [vehicle("V1", -2, 0.5, 80), vehicle("V2", 3, -0.5, 260)],
      people: [person("P1", -2, 1.5)],
      hazards: [{ id: "H1", kind: "fuel_spill", x: 0, y: 0, z: 0, radius_m: 4, severity: "medium", note: "" }],
    });

  it("un choque dentro de una manzana pasa al eje de la calle con nombre coincidente", () => {
    const input = crash();
    const { scene: out, adjustment } = anchorScene(input, "vehicle_collision", blockCtx());
    assert.ok(adjustment, "debió ajustarse");
    assert.equal(adjustment.target, "Avenida Test");
    assert.equal(adjustment.rotation_deg, 0);
    assert.ok(Math.abs(adjustment.dy - 30) < 0.01 && Math.abs(adjustment.dx) < 0.01, JSON.stringify(adjustment));
    const cy = (out.vehicles[0].y + out.vehicles[1].y) / 2;
    assert.ok(Math.abs(cy - 30) < 0.01);
    for (const v of out.vehicles) assert.ok(!inside(v, blockCtx().buildings[0].rings[0]), `${v.id} quedó dentro del edificio`);
    // Movimiento rígido: personas, peligros y calles acompañan; estados intactos.
    assert.deepEqual(out.people.map((p) => [p.x, p.y, p.status]), [[-2, 31.5, "trapped"]]);
    assert.deepEqual([out.hazards[0].x, out.hazards[0].y], [0, 30]);
    assert.deepEqual([out.roads[0].y1, out.roads[0].y2], [30, 30]);
    assert.equal(out.vehicles.length, 2);
    assert.match(adjustment.reason, /^Ubicación ajustada al mapa real \(OpenStreetMap\): escena desplazada 30 m al norte hasta el eje de Avenida Test\.$/);
    assert.deepEqual(out.uncertainty_notes, ["Nota previa.", adjustment.reason]);
    // La entrada no se muta.
    assert.equal(input.vehicles[0].y, 0.5);
  });

  it("es idempotente: una segunda pasada no mueve ni agrega notas", () => {
    const first = anchorScene(crash(), "vehicle_collision", blockCtx()).scene;
    const second = anchorScene(first, "vehicle_collision", blockCtx());
    assert.equal(second.adjustment, null);
    assert.deepEqual(second.scene, first);
    assert.equal(anchorNotes(second.scene).length, 1);
  });

  it("reemplaza la nota de ajuste anterior en vez de acumularla", () => {
    const stale = crash();
    stale.uncertainty_notes.push(`${ANCHOR_NOTE_PREFIX} escena desplazada 99 m al sur hasta el eje de Otra.`);
    const { scene: out } = anchorScene(stale, "vehicle_collision", blockCtx());
    assert.equal(anchorNotes(out).length, 1);
    assert.match(anchorNotes(out)[0], /30 m al norte/);
  });

  it("si ya está sobre la calzada no cambia nada", () => {
    const onStreet = scene({ vehicles: [vehicle("V1", 5, 28), vehicle("V2", 10, 31)] });
    const r = anchorScene(onStreet, "vehicle_collision", blockCtx());
    assert.equal(r.adjustment, null);
    assert.equal(r.scene, onStreet);
  });

  it("gira para alinear la calle de la escena con el eje OSM (múltiplo de 180° más cercano)", () => {
    // OSM: calle a 20° del eje Este–Oeste, al sur de la escena; escena: calle E–O.
    const th = (20 * Math.PI) / 180;
    const dir = { x: Math.cos(th), y: -Math.sin(th) }; // rumbo 110°
    const ctx: OsmContext = {
      buildings: [building("b1", rect(0, 0, 30, 30))],
      roads: [road("1:0.0", "secondary", "Avenida Test", [{ x: -200 * dir.x, y: -25 - 200 * dir.y }, { x: 200 * dir.x, y: -25 + 200 * dir.y }])],
    };
    const s = scene({
      roads: [{ id: "R1", name: "Av. Test", x1: 100, y1: 0, x2: -100, y2: 0, width_m: 9, blocked: false }],
      vehicles: [vehicle("V1", 0, 0, 90)],
    });
    const { scene: out, adjustment } = anchorScene(s, "vehicle_fire", ctx);
    assert.ok(adjustment);
    assert.ok(Math.abs(adjustment.rotation_deg - 20) < 0.5, `rotación ${adjustment.rotation_deg}`);
    assert.ok(Math.abs(out.vehicles[0].rotation_deg - 110) < 0.5);
    assert.match(adjustment.reason, /girada 20° en sentido horario/);
  });

  it("con dos calles que se cruzan, calza el cruce de la escena con el cruce OSM", () => {
    // Escena: autos 35 m al oriente del cruce (−35, 0). OSM: el mismo cruce está 12 m al norte y 10 m al oriente.
    const s = scene({
      roads: [
        { id: "R1", name: "Av. Uno (calzada sur)", x1: -200, y1: 0, x2: 200, y2: 0, width_m: 10, blocked: true },
        { id: "R2", name: "Av. Dos", x1: -35, y1: -200, x2: -35, y2: 200, width_m: 14, blocked: false },
      ],
      vehicles: [vehicle("V1", -2, 0), vehicle("V2", 2, 0)],
    });
    const ctx: OsmContext = {
      buildings: [building("b1", rect(0, 0, 20, 16))],
      roads: [
        road("10:0.0", "primary", "Avenida Uno", [{ x: -200, y: 12 }, { x: 200, y: 12 }]),
        road("20:0.0", "primary", "Avenida Dos", [{ x: -25, y: -200 }, { x: -25, y: 200 }]),
      ],
    };
    const { scene: out, adjustment } = anchorScene(s, "vehicle_collision", ctx);
    assert.ok(adjustment);
    assert.equal(adjustment.target, "Avenida Uno con Avenida Dos");
    assert.deepEqual([adjustment.dx, adjustment.dy], [10, 12]);
    assert.deepEqual(out.vehicles.map((v) => [v.x, v.y]), [[8, 12], [12, 12]]);
    assert.match(adjustment.reason, /hasta el cruce de Avenida Uno con Avenida Dos/);
  });

  it("no mueve más allá del máximo ni deja vehículos dentro de edificios", () => {
    const far: OsmContext = { buildings: [building("b1", rect(0, 0, 40, 40))], roads: [road("1:0.0", "primary", "Lejos", [{ x: -200, y: 120 }, { x: 200, y: 120 }])] };
    assert.equal(anchorScene(crash(), "vehicle_collision", far).adjustment, null);
    // La única calle cercana atraviesa un edificio: el punto del eje queda dentro → se descarta.
    const blocked: OsmContext = {
      buildings: [building("b1", rect(0, 0, 40, 40)), building("b2", rect(0, 30, 400, 20))],
      roads: [road("1:0.0", "service", null, [{ x: -200, y: 30 }, { x: 200, y: 30 }])],
    };
    assert.equal(anchorScene(crash(), "vehicle_collision", blocked).adjustment, null);
  });

  it("si las calles de la escena no existen cerca, no se ancla a otra calle: avisa", () => {
    // Escena en «Av. Departamental» (dos calzadas con bandejón); OSM solo tiene un pasaje a 34 m.
    const s = scene({
      roads: [
        { id: "R1", name: "Av. Departamental (calzada sur)", x1: -100, y1: 0, x2: 100, y2: 0, width_m: 10.5, blocked: true },
        { id: "R2", name: "Av. Departamental (calzada norte)", x1: -100, y1: 13.5, x2: 100, y2: 13.5, width_m: 10.5, blocked: false },
      ],
      vehicles: [vehicle("V1", -2, 0.5), vehicle("V2", 3, -0.5)],
    });
    const ctx: OsmContext = {
      buildings: [building("b1", rect(0, 0, 40, 40))],
      roads: [road("1:0.0", "minor", "Los Pequenes", [{ x: -200, y: -34 }, { x: 200, y: -34 }])],
    };
    const r = anchorScene(s, "vehicle_collision", ctx);
    assert.equal(r.adjustment, null);
    assert.deepEqual(r.scene.vehicles, s.vehicles);
    assert.ok(r.warning);
    assert.match(r.warning, /^Ubicación por verificar \(OpenStreetMap\): las calles de la escena \(Av\. Departamental\) no aparecen a menos de 200 m del GPS del incidente \(la calle más cercana es Los Pequenes, a 34 m\); la escena no se movió\./);
    assert.equal(anchorNotes(r.scene).length, 0);
    // Idempotente: el aviso se reemplaza, no se acumula.
    const again = anchorScene(r.scene, "vehicle_collision", ctx);
    assert.deepEqual(again.scene, r.scene);
  });

  it("una avenida ancha sin nombre conocido no va a un pasaje, y sin nombre no se mueve más de 30 m", () => {
    const wide = scene({
      roads: [{ id: "R1", name: "", x1: -100, y1: 0, x2: 100, y2: 0, width_m: 12, blocked: true }],
      vehicles: [vehicle("V1", 0, 0)],
    });
    const passage: OsmContext = { buildings: [building("b1", rect(0, 0, 30, 30))], roads: [road("1:0.0", "minor", null, [{ x: -200, y: 25 }, { x: 200, y: 25 }])] };
    assert.equal(anchorScene(wide, "vehicle_collision", passage).adjustment, null);
    const far: OsmContext = { buildings: [building("b1", rect(0, 0, 30, 30))], roads: [road("1:0.0", "primary", null, [{ x: -200, y: 40 }, { x: 200, y: 40 }])] };
    assert.equal(anchorScene(wide, "vehicle_collision", far).adjustment, null);
    const near: OsmContext = { buildings: [building("b1", rect(0, 0, 30, 30))], roads: [road("1:0.0", "primary", null, [{ x: -200, y: 25 }, { x: 200, y: 25 }])] };
    assert.equal(anchorScene(wide, "vehicle_collision", near).adjustment?.dy, 25);
  });

  it("sobre otra avenida con nombre distinto no calza: va a la calle nombrada en la escena", () => {
    // Los autos quedaron sobre «Avenida Otra» (error de GPS); «Avenida Test» está 30 m al norte.
    const ctx = blockCtx();
    ctx.buildings = [];
    ctx.roads.push(road("300:0.0", "primary", "Avenida Otra", [{ x: -200, y: 0 }, { x: 200, y: 0 }]));
    const r = anchorScene(crash(), "vehicle_collision", ctx);
    assert.equal(r.adjustment?.target, "Avenida Test");
    assert.equal(r.adjustment?.dy, 30);
  });

  it("las cámaras con GPS no se mueven y limitan el desplazamiento", () => {
    const withCam = () => {
      const s = crash();
      s.cameras = [{ media_ref: "M1", x: 8, y: -7.5, z: 1.6, facing_deg: 310, confidence: "high" }];
      return s;
    };
    // 30 m al norte con tolerancia de 40 m: se ancla, pero M1 queda en su GPS.
    const ok = anchorScene(withCam(), "vehicle_collision", blockCtx(), { fixedCameras: [{ media_ref: "M1", tolerance_m: 40 }] });
    assert.ok(ok.adjustment);
    assert.deepEqual(ok.scene.cameras[0], withCam().cameras[0]);
    assert.match(ok.adjustment.reason, /M1 se mantiene en su posición GPS\.$/);
    // Tolerancia de 18 m (GPS de 8 m): moverla 30 m contradice el GPS → no se mueve y avisa.
    const no = anchorScene(withCam(), "vehicle_collision", blockCtx(), { fixedCameras: [{ media_ref: "m1", tolerance_m: 18 }] });
    assert.equal(no.adjustment, null);
    assert.deepEqual(no.scene.vehicles, withCam().vehicles);
    assert.match(no.warning ?? "", /contradice el GPS de M1; la escena no se movió\.$/);
  });

  it("conserva la nota de ajuste si la IA mantuvo las posiciones pero borró la nota", () => {
    const first = anchorScene(crash(), "vehicle_collision", blockCtx()).scene;
    const rewritten = { ...first, uncertainty_notes: ["Otra nota de la IA."] };
    const r = anchorScene(rewritten, "vehicle_collision", blockCtx(), { previous: first });
    assert.equal(r.adjustment, null);
    assert.deepEqual(r.scene.uncertainty_notes, ["Otra nota de la IA.", anchorNotes(first)[0]]);
    // Si la IA reubicó la escena (otro punto de anclaje), la nota vieja no se arrastra.
    const moved = { ...rewritten, vehicles: rewritten.vehicles.map((v) => ({ ...v, x: v.x + 20 })) };
    assert.equal(anchorNotes(anchorScene(moved, "vehicle_collision", blockCtx(), { previous: first }).scene).length, 0);
  });

  it("detecta cruces entre polilíneas distintas de un mismo rasgo multilínea", () => {
    // Una sola feature OSM (id 7) con dos sub-líneas que se cruzan en (0, 20); la escena habla de una esquina.
    const s = scene({
      description: "Choque en la esquina",
      roads: [{ id: "R1", name: "", x1: -100, y1: 0, x2: 100, y2: 0, width_m: 8, blocked: true }],
      vehicles: [vehicle("V1", 4, 0), vehicle("V2", 8, 0)],
    });
    const ctx: OsmContext = {
      buildings: [building("b1", rect(6, 0, 20, 14))],
      roads: [
        road("7:0.0", "minor", null, [{ x: -200, y: 20 }, { x: 200, y: 20 }]),
        road("7:1.0", "minor", null, [{ x: 0, y: -200 }, { x: 0, y: 0 }, { x: 0, y: 200 }]),
      ],
    };
    const r = anchorScene(s, "vehicle_collision", ctx);
    assert.ok(r.adjustment);
    assert.deepEqual([r.adjustment.dx, r.adjustment.dy], [-6, 20]);
    assert.match(r.adjustment.reason, /hasta el cruce de/);
  });

  it("dos polilíneas empalmadas en curva no cuentan como cruce", () => {
    const s = scene({
      description: "Choque en la esquina",
      roads: [{ id: "R1", name: "", x1: -100, y1: 0, x2: 100, y2: 0, width_m: 8, blocked: true }],
      vehicles: [vehicle("V1", 4, 0), vehicle("V2", 8, 0)],
    });
    // Calle en L: tramo E–O que termina en (0, 20) y sigue hacia el norte en otra polilínea.
    const ctx: OsmContext = {
      buildings: [building("b1", rect(6, 0, 20, 14))],
      roads: [
        road("7:0.0", "minor", null, [{ x: 200, y: 20 }, { x: 0, y: 20 }]),
        road("7:1.0", "minor", null, [{ x: 0, y: 20 }, { x: 0, y: 200 }]),
      ],
    };
    const r = anchorScene(s, "vehicle_collision", ctx);
    assert.ok(r.adjustment);
    assert.match(r.adjustment.reason, /hasta el eje de/);
  });
});

describe("anchorScene · incendio estructural", () => {
  const fireScene = () =>
    scene({
      structures: [structure(), structure({ id: "S2", role: "exposure", x: 14, y: 0 })],
      fire_zones: [
        { id: "F1", structure_id: "S1", floor: 2, side: "front", x: 0, y: 2, z: 4, radius_m: 3, intensity: "heavy", confidence: "high", note: "" },
      ],
      people: [person("P1", 1, 1)],
      cameras: [{ media_ref: "M1", x: 0, y: -20, z: 1.5, facing_deg: 0, confidence: "high" }],
      vehicles: [vehicle("B1", 0, -15, 270)],
    });

  it("un incendio desplazado 20 m calza con su huella (traslación + giro ≤ 45°)", () => {
    // Huella real de 10×12 m girada 10°, 20 m al norte.
    const ctx: OsmContext = { buildings: [building("w1", rect(0, 20, 10, 12, 10)), building("lejos", rect(-45, 0, 10, 12))], roads: [] };
    const { scene: out, adjustment } = anchorScene(fireScene(), "structure_fire", ctx);
    assert.ok(adjustment);
    const s1 = out.structures[0];
    assert.ok(Math.abs(s1.x) < 0.05 && Math.abs(s1.y - 20) < 0.05, `S1 en ${s1.x},${s1.y}`);
    assert.ok(Math.abs(adjustment.rotation_deg - 10) < 0.5, `giro ${adjustment.rotation_deg}`);
    assert.ok(Math.abs(s1.rotation_deg - 190) < 0.5);
    // Sin cambiar dimensiones; la exposición se mueve con la escena (rígido).
    assert.deepEqual([s1.width_m, s1.depth_m], [10, 12]);
    const s2 = out.structures[1];
    assert.ok(Math.abs(Math.hypot(s2.x - s1.x, s2.y - s1.y) - 14) < 0.05);
    assert.equal(out.fire_zones[0].structure_id, "S1");
    assert.ok(Math.abs(out.cameras[0].facing_deg - 10) < 0.5);
    assert.equal(adjustment.target, "huella OSM w1");
    assert.match(adjustment.reason, /^Ubicación ajustada al mapa real \(OpenStreetMap\): escena desplazada 20 m al norte y girada 10° en sentido horario para calzar S1 \(Casa\) con su huella en OpenStreetMap\.$/);
    // Idempotente.
    const again = anchorScene(out, "structure_fire", ctx);
    assert.equal(again.adjustment, null);
    assert.equal(again.scene, out);
  });

  it("prefiere la huella hacia donde mira la cámara", () => {
    // Dos huellas a la misma distancia: una al norte (donde mira M1) y otra al sur.
    const ctx: OsmContext = { buildings: [building("sur", rect(0, -22, 10, 12)), building("norte", rect(0, 22, 10, 12))], roads: [] };
    const s = fireScene();
    s.cameras[0] = { ...s.cameras[0], y: 0 };
    const { adjustment } = anchorScene(s, "structure_fire", ctx);
    assert.equal(adjustment?.target, "huella OSM norte");
  });

  it("si la estructura ya está sobre su huella no cambia nada", () => {
    const ctx: OsmContext = { buildings: [building("w1", rect(0.5, 0.4, 10, 12))], roads: [] };
    const s = fireScene();
    const r = anchorScene(s, "structure_fire", ctx);
    assert.equal(r.adjustment, null);
    assert.equal(r.scene, s);
  });

  it("una cámara con GPS no se mueve; si calzar la huella la contradice, avisa sin mover", () => {
    const ctx: OsmContext = { buildings: [building("w1", rect(0, 20, 10, 12, 10))], roads: [] };
    const ok = anchorScene(fireScene(), "structure_fire", ctx, { fixedCameras: [{ media_ref: "M1", tolerance_m: 25 }] });
    assert.ok(ok.adjustment);
    assert.deepEqual(ok.scene.cameras[0], fireScene().cameras[0]);
    const no = anchorScene(fireScene(), "structure_fire", ctx, { fixedCameras: [{ media_ref: "M1", tolerance_m: 12 }] });
    assert.equal(no.adjustment, null);
    assert.deepEqual(no.scene.structures, fireScene().structures);
    assert.ok(no.scene.uncertainty_notes.some((n) => n.startsWith(ANCHOR_WARNING_PREFIX)));
  });

  it("no busca huellas a más de 50 m", () => {
    const ctx: OsmContext = { buildings: [building("w1", rect(0, 80, 10, 12))], roads: [] };
    assert.equal(anchorScene(fireScene(), "structure_fire", ctx).adjustment, null);
  });
});

describe("anchorScene · sin datos u otros tipos", () => {
  const s = scene({ vehicles: [vehicle("V1", 0, 0)], structures: [structure()] });
  it("sin contexto OSM devuelve la misma escena", () => {
    const r = anchorScene(s, "vehicle_collision", null);
    assert.equal(r.scene, s);
    assert.equal(r.adjustment, null);
  });
  it("contexto vacío o tipo sin anclaje: sin cambios", () => {
    assert.equal(anchorScene(s, "vehicle_collision", { buildings: [], roads: [] }).scene, s);
    assert.equal(anchorScene(s, "structure_fire", { buildings: [], roads: [] }).scene, s);
    assert.equal(anchorScene(s, "hazmat", blockCtx()).scene, s);
    assert.equal(anchorScene(s, "wildland_fire", blockCtx()).scene, s);
  });
  it("tipo desconocido: se deduce de la escena", () => {
    assert.equal(anchorModeFor("unknown", s), "structure");
    assert.equal(anchorModeFor("unknown", scene({ vehicles: [vehicle("V1", 0, 0)] })), "vehicles");
    assert.equal(anchorModeFor("unknown", scene()), null);
    assert.equal(anchorModeFor("rescue", s), null);
  });
  it("una escena malformada no lanza", () => {
    assert.doesNotThrow(() => anchorScene({} as SceneModel, "vehicle_collision", blockCtx()));
  });
});

describe("sameRoadName", () => {
  it("compara sin tipo de vía, tildes ni paréntesis", () => {
    assert.ok(sameRoadName("Av. Departamental (calzada sur, hacia el oriente)", "Avenida Departamental"));
    assert.ok(sameRoadName("Avenida Macul", "av macul"));
    assert.ok(sameRoadName("Dublé Almeyda", "Duble Almeyda"));
    assert.ok(!sameRoadName("Av. Macul", "Avenida Departamental"));
    assert.ok(!sameRoadName("", "Avenida Macul"));
    assert.ok(!sameRoadName("Avenida", "Avenida Macul"));
  });
});
