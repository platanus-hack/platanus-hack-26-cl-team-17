import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { SceneModelAISchema, type Media, type MediaFrame, type SceneModel } from "@/lib/domain";
import { toLocal } from "@/lib/geo";
import { SCENE_BOUNDS, sanitizeScene, type SceneSanitizeContext } from "./scene-post";

const INCIDENT = { lat: -33.45, lng: -70.65 };

function makeMedia(over: Partial<Media> = {}): Media {
  return {
    id: "media-1",
    incident_id: "inc-1",
    label: "M1",
    source: "citizen",
    kind: "video",
    mission_id: null,
    video_path: null,
    video_status: "none",
    mime: null,
    size_bytes: null,
    duration_s: null,
    lat: null,
    lng: null,
    accuracy_m: null,
    heading_deg: null,
    captured_at: null,
    reporter_note: "",
    status: "analyzed",
    error: null,
    analysis: null,
    analysis_engine: null,
    analyzed_at: null,
    frames: [],
    created_at: "2026-11-21T12:00:00.000Z",
    ...over,
  };
}

function makeFrame(over: Partial<MediaFrame>): MediaFrame {
  return {
    id: "f",
    media_id: "media-d",
    idx: 0,
    t_s: 0,
    storage_path: "x.jpg",
    width: 1280,
    height: 720,
    lat: null,
    lng: null,
    alt_m: null,
    heading_deg: null,
    ...over,
  };
}

function emptyScene(over: Partial<SceneModel> = {}): SceneModel {
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
    uncertainty_notes: [],
    confidence: "medium",
    ...over,
  };
}

const structure = (over: Partial<SceneModel["structures"][number]> = {}): SceneModel["structures"][number] => ({
  id: "S1",
  label: "Casa",
  kind: "house_2_story",
  role: "involved",
  x: 0,
  y: 0,
  width_m: 8,
  depth_m: 10,
  floors: 2,
  floor_height_m: 2.7,
  rotation_deg: 0,
  roof: "gable",
  construction: "wood",
  confidence: "medium",
  notes: "",
  ...over,
});

const ctx = (media: Media[] = []): SceneSanitizeContext => ({ incident: INCIDENT, media });

/** Escena con valores problemáticos (no pasa por el tipo a propósito). */
const raw = (v: unknown) => v as SceneModel;

describe("sanitizeScene · números", () => {
  test("no finitos → valores por defecto y todo acotado", () => {
    const out = sanitizeScene(
      emptyScene({
        structures: [
          structure({
            x: Number.NaN,
            y: 9999,
            width_m: Number.POSITIVE_INFINITY,
            depth_m: 0.1,
            floors: 0,
            floor_height_m: Number.NaN,
          }),
        ],
        fire_zones: [
          {
            id: "F1",
            structure_id: "S1",
            floor: 2,
            side: "front",
            x: -9999,
            y: 0,
            z: -5,
            radius_m: 0,
            intensity: "heavy",
            confidence: "high",
            note: "",
          },
        ],
        hazards: [
          { id: "Z1", kind: "gas_cylinder", x: 0, y: 0, z: 900, radius_m: 1e6, severity: "high", note: "" },
        ],
        vehicles: [
          {
            id: "V1",
            kind: "car",
            state: "upright",
            x: 0,
            y: 0,
            rotation_deg: Number.NaN,
            length_m: 100,
            width_m: 0.1,
            entrapment_suspected: false,
            burning: false,
            note: "",
          },
        ],
        roads: [{ id: "R1", name: "", x1: -1e9, y1: 0, x2: 1e9, y2: 0, width_m: Number.NaN, blocked: false }],
      }),
      ctx(),
    );
    const s = out.structures[0];
    assert.equal(s.x, 0);
    assert.equal(s.y, SCENE_BOUNDS.POS_M);
    assert.equal(s.width_m, 8);
    assert.equal(s.depth_m, SCENE_BOUNDS.STRUCTURE_SIDE_MIN);
    assert.equal(s.floors, 1);
    assert.equal(s.floor_height_m, 2.7);

    const f = out.fire_zones[0];
    assert.equal(f.x, -SCENE_BOUNDS.POS_M);
    assert.equal(f.z, 0);
    assert.equal(f.radius_m, SCENE_BOUNDS.RADIUS_MIN);

    assert.equal(out.hazards[0].z, SCENE_BOUNDS.Z_MAX);
    assert.equal(out.hazards[0].radius_m, SCENE_BOUNDS.RADIUS_MAX);

    const v = out.vehicles[0];
    assert.equal(v.rotation_deg, 0);
    assert.equal(v.length_m, SCENE_BOUNDS.VEHICLE_LENGTH_MAX);
    assert.equal(v.width_m, SCENE_BOUNDS.VEHICLE_WIDTH_MIN);

    assert.equal(out.roads[0].x1, -500);
    assert.equal(out.roads[0].x2, 500);
    assert.equal(out.roads[0].width_m, 7);
  });

  test("pisos enteros entre 1 y 60, altura de piso entre 2 y 6", () => {
    const out = sanitizeScene(
      emptyScene({
        structures: [
          structure({ id: "A", floors: 3.6, floor_height_m: 10 }),
          structure({ id: "B", floors: 200, floor_height_m: 1 }),
        ],
      }),
      ctx(),
    );
    assert.equal(out.structures[0].floors, 4);
    assert.equal(out.structures[0].floor_height_m, 6);
    assert.equal(out.structures[1].floors, 60);
    assert.equal(out.structures[1].floor_height_m, 2);
  });

  test("rumbos normalizados; -1 se conserva donde es centinela", () => {
    const out = sanitizeScene(
      emptyScene({
        ground: { street_axis_deg: 270, notes: "  calle  " },
        structures: [structure({ rotation_deg: -90 })],
        smoke_plumes: [
          { id: "H1", x: 0, y: 0, z: 10, drift_deg: 725, volume: "heavy", color: "black" },
          { id: "H2", x: 0, y: 0, z: 10, drift_deg: -1, volume: "light", color: "white" },
          { id: "H3", x: 0, y: 0, z: 10, drift_deg: Number.NaN, volume: "light", color: "white" },
        ],
        cameras: [{ media_ref: "M1", x: 1, y: 2, z: 1.5, facing_deg: -1, confidence: "low" }],
      }),
      ctx([makeMedia()]),
    );
    assert.equal(out.ground.street_axis_deg, 90);
    assert.equal(out.ground.notes, "calle");
    assert.equal(out.structures[0].rotation_deg, 270);
    assert.deepEqual(
      out.smoke_plumes.map((p) => p.drift_deg),
      [5, -1, -1],
    );
    assert.equal(out.cameras[0].facing_deg, -1);

    const axis = (d: number) => sanitizeScene(emptyScene({ ground: { street_axis_deg: d, notes: "" } }), ctx()).ground;
    assert.equal(axis(-1).street_axis_deg, -1);
    assert.equal(axis(180).street_axis_deg, 0);
    assert.equal(axis(-45).street_axis_deg, 135);
    assert.equal(axis(Number.NaN).street_axis_deg, -1);
  });

  test("cantidad de personas: entero ≥ 1", () => {
    const person = (count: number, id: string): SceneModel["people"][number] => ({
      id,
      status: "trapped",
      count,
      structure_id: "",
      floor: 0,
      x: 0,
      y: 0,
      z: 0,
      confidence: "medium",
      note: "",
      evidence: [{ ref: " M1 ", frame: 2.4, note: " ventana " }],
    });
    const out = sanitizeScene(
      emptyScene({ people: [person(0, "P1"), person(2.6, "P2"), person(Number.NaN, "P3"), person(-3, "P4")] }),
      ctx(),
    );
    assert.deepEqual(
      out.people.map((p) => p.count),
      [1, 3, 1, 1],
    );
    assert.deepEqual(out.people[0].evidence, [{ ref: "M1", frame: 2, note: "ventana" }]);
  });
});

describe("sanitizeScene · ids y referencias", () => {
  test("ids vacíos o repetidos reciben ids estables y únicos", () => {
    const out = sanitizeScene(
      emptyScene({
        structures: [structure({ id: "" }), structure({ id: "S1" }), structure({ id: "S1" }), structure({ id: " " })],
      }),
      ctx(),
    );
    assert.deepEqual(
      out.structures.map((s) => s.id),
      ["S2", "S1", "S3", "S4"],
    );
  });

  test("structure_id inexistente → vacío; existente se conserva", () => {
    const fire = (structure_id: string): SceneModel["fire_zones"][number] => ({
      id: "",
      structure_id,
      floor: 1,
      side: "front",
      x: 0,
      y: 0,
      z: 1,
      radius_m: 2,
      intensity: "moderate",
      confidence: "medium",
      note: "",
    });
    const out = sanitizeScene(
      emptyScene({
        structures: [structure({ id: "S1" })],
        fire_zones: [fire("S1"), fire("S9"), fire(" S1 ")],
        people: [
          {
            id: "P1",
            status: "at_window_or_balcony",
            count: 1,
            structure_id: "S7",
            floor: 2,
            x: 0,
            y: 0,
            z: 4,
            confidence: "medium",
            note: "",
            evidence: [],
          },
        ],
      }),
      ctx(),
    );
    assert.deepEqual(
      out.fire_zones.map((f) => f.structure_id),
      ["S1", "", "S1"],
    );
    assert.deepEqual(
      out.fire_zones.map((f) => f.id),
      ["F1", "F2", "F3"],
    );
    assert.equal(out.people[0].structure_id, "");
    // La persona y su estado se conservan: nunca se descarta una víctima.
    assert.equal(out.people[0].status, "at_window_or_balcony");
  });
});

describe("sanitizeScene · cámaras", () => {
  test("cámara de vecino con GPS: posición desde toLocal, z 1,5, rumbo del teléfono, confianza alta", () => {
    const m = makeMedia({ label: "M1", lat: -33.4495, lng: -70.6505, heading_deg: 400 });
    const out = sanitizeScene(
      emptyScene({ cameras: [{ media_ref: "M1", x: 99, y: 99, z: 9, facing_deg: 10, confidence: "low" }] }),
      ctx([m]),
    );
    const expected = toLocal(INCIDENT, { lat: -33.4495, lng: -70.6505 });
    assert.equal(out.cameras.length, 1);
    const c = out.cameras[0];
    assert.equal(c.media_ref, "M1");
    assert.ok(Math.abs(c.x - expected.x) < 1e-9);
    assert.ok(Math.abs(c.y - expected.y) < 1e-9);
    assert.equal(c.z, 1.5);
    assert.equal(c.facing_deg, 40);
    assert.equal(c.confidence, "high");
  });

  test("sin rumbo del teléfono conserva el rumbo estimado por el modelo", () => {
    const m = makeMedia({ lat: -33.4495, lng: -70.6505 });
    const out = sanitizeScene(
      emptyScene({ cameras: [{ media_ref: "M1", x: 0, y: 0, z: 1, facing_deg: 200, confidence: "low" }] }),
      ctx([m]),
    );
    assert.equal(out.cameras[0].facing_deg, 200);
  });

  test("dron: usa el cuadro más reciente con GPS (x, y, altura y rumbo)", () => {
    const p1 = { lat: -33.4496, lng: -70.6501 };
    const p2 = { lat: -33.4502, lng: -70.6498 };
    const m = makeMedia({
      id: "media-d",
      label: "M2",
      source: "drone",
      kind: "frames",
      lat: -33.44,
      lng: -70.64,
      frames: [
        makeFrame({ idx: 0, t_s: 0, ...p1, alt_m: 40, heading_deg: 10 }),
        makeFrame({ idx: 1, t_s: 5, ...p2, alt_m: 55, heading_deg: 190 }),
        makeFrame({ idx: 2, t_s: 9 }), // sin GPS
      ],
    });
    const out = sanitizeScene(
      emptyScene({ cameras: [{ media_ref: "m2", x: 0, y: 0, z: 0, facing_deg: -1, confidence: "low" }] }),
      ctx([m]),
    );
    const expected = toLocal(INCIDENT, p2);
    const c = out.cameras[0];
    assert.equal(c.media_ref, "M2");
    assert.ok(Math.abs(c.x - expected.x) < 1e-9);
    assert.ok(Math.abs(c.y - expected.y) < 1e-9);
    assert.equal(c.z, 55);
    assert.equal(c.facing_deg, 190);
    assert.equal(c.confidence, "high");
  });

  test("cámara de un medio inexistente se elimina; duplicadas se reducen a una", () => {
    const out = sanitizeScene(
      emptyScene({
        cameras: [
          { media_ref: "M9", x: 0, y: 0, z: 1.5, facing_deg: 0, confidence: "high" },
          { media_ref: "M1", x: 3, y: 4, z: 1.5, facing_deg: 0, confidence: "medium" },
          { media_ref: "M1", x: 7, y: 8, z: 1.5, facing_deg: 0, confidence: "medium" },
        ],
      }),
      ctx([makeMedia()]),
    );
    assert.equal(out.cameras.length, 1);
    assert.equal(out.cameras[0].media_ref, "M1");
    assert.equal(out.cameras[0].x, 3);
    assert.equal(out.cameras[0].confidence, "medium");
  });

  test("agrega cámaras de medios con GPS que el modelo omitió", () => {
    const withGps = makeMedia({ id: "b", label: "M2", lat: -33.4501, lng: -70.6502, heading_deg: 90 });
    const noGps = makeMedia({ id: "c", label: "M3" });
    const out = sanitizeScene(emptyScene(), ctx([withGps, noGps]));
    assert.equal(out.cameras.length, 1);
    assert.equal(out.cameras[0].media_ref, "M2");
    assert.equal(out.cameras[0].facing_deg, 90);
    assert.equal(out.cameras[0].z, 1.5);
    assert.equal(out.cameras[0].confidence, "high");
  });

  test("GPS fuera del área se acerca al borde conservando el rumbo y baja la confianza", () => {
    const far = makeMedia({ lat: -33.45, lng: -70.6 }); // ~4,6 km al Este
    const out = sanitizeScene(emptyScene(), ctx([far]));
    const c = out.cameras[0];
    assert.equal(c.x, SCENE_BOUNDS.POS_M);
    assert.ok(Math.abs(c.y) < 1e-6);
    assert.equal(c.confidence, "low");
  });

  test("incidente sin coordenadas válidas: no se usa el GPS", () => {
    const m = makeMedia({ lat: -33.4495, lng: -70.6505 });
    const out = sanitizeScene(
      emptyScene({ cameras: [{ media_ref: "M1", x: 3, y: 4, z: 2, facing_deg: 0, confidence: "low" }] }),
      { incident: { lat: Number.NaN, lng: 0 }, media: [m] },
    );
    assert.deepEqual(out.cameras, [{ media_ref: "M1", x: 3, y: 4, z: 2, facing_deg: 0, confidence: "low" }]);
  });
});

describe("sanitizeScene · robustez", () => {
  test("textos recortados y notas vacías eliminadas", () => {
    const out = sanitizeScene(
      emptyScene({
        description: "  Casa de dos pisos  ",
        structures: [structure({ label: "  Casa  ", notes: " n " })],
        annotations: [{ x: 0, y: 0, z: Number.NaN, text: "  acceso  " }],
        uncertainty_notes: ["  medidas supuestas ", "   "],
      }),
      ctx(),
    );
    assert.equal(out.description, "Casa de dos pisos");
    assert.equal(out.structures[0].label, "Casa");
    assert.equal(out.structures[0].notes, "n");
    assert.deepEqual(out.annotations, [{ x: 0, y: 0, z: 3, text: "acceso" }]);
    assert.deepEqual(out.uncertainty_notes, ["medidas supuestas"]);
  });

  test("devuelve un objeto nuevo y no modifica la entrada", () => {
    const input = emptyScene({ structures: [structure({ x: Number.NaN })] });
    const copy = structuredClone(input);
    const out = sanitizeScene(input, ctx());
    assert.notEqual(out, input);
    assert.notEqual(out.structures[0], input.structures[0]);
    assert.deepEqual(input, copy);
  });

  test("entrada malformada no lanza y produce una escena válida para el esquema", () => {
    const bad = raw({
      description: 5,
      ground: null,
      roads: "x",
      structures: [null, 3, { kind: "castillo", role: "x", floors: "dos" }],
      fire_zones: [{ structure_id: 7, intensity: "infierno" }],
      people: [{ status: "inventado", evidence: [{ ref: "" }, { ref: "M1", frame: "a" }] }],
      cameras: [{}],
      uncertainty_notes: [1, " ok "],
      confidence: "total",
    });
    const out = sanitizeScene(bad, ctx([makeMedia()]));
    assert.ok(SceneModelAISchema.safeParse(out).success);
    assert.equal(out.structures.length, 1);
    assert.equal(out.structures[0].kind, "unknown");
    assert.equal(out.structures[0].id, "S1");
    assert.equal(out.fire_zones[0].intensity, "moderate");
    assert.equal(out.people[0].status, "unknown");
    assert.equal(out.people[0].count, 1);
    assert.deepEqual(out.people[0].evidence, [{ ref: "M1", frame: -1, note: "" }]);
    assert.deepEqual(out.cameras, []);
    assert.deepEqual(out.uncertainty_notes, ["ok"]);
    assert.equal(out.confidence, "low");
    assert.equal(out.ground.street_axis_deg, -1);

    assert.doesNotThrow(() => sanitizeScene(raw(null), { incident: null, media: null } as unknown as SceneSanitizeContext));
    assert.ok(SceneModelAISchema.safeParse(sanitizeScene(raw(undefined), ctx())).success);
  });

  test("una escena ya correcta no cambia", () => {
    const good = emptyScene({
      structures: [structure()],
      fire_zones: [
        {
          id: "F1",
          structure_id: "S1",
          floor: 2,
          side: "front",
          x: 1,
          y: -4,
          z: 4,
          radius_m: 2,
          intensity: "heavy",
          confidence: "high",
          note: "Llamas en ventana",
        },
      ],
      cameras: [{ media_ref: "M1", x: -10, y: -20, z: 1.5, facing_deg: 30, confidence: "medium" }],
    });
    assert.deepEqual(sanitizeScene(good, ctx([makeMedia()])), good);
  });
});
