import { test } from "node:test";
import assert from "node:assert/strict";
import type { SceneModel } from "@/lib/domain";
import { destination } from "@/lib/geo";
import {
  COORD_LIMIT,
  buildSceneView,
  deriveCameras,
  deriveDrones,
  findEntity,
  frameBounds,
  hashString,
  normalizeScene,
  type MediaLike,
  type MissionLike,
} from "./model";
import { SAMPLE_SCENE } from "./sample-scene";

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);
const ORIGIN = { lat: -33.4569, lng: -70.5984 };

test("normaliza la escena de ejemplo y ubica focos y personas en su piso/costado", () => {
  const s = normalizeScene(SAMPLE_SCENE);
  assert.equal(s.structures.length, 2);
  assert.equal(s.primaryId, "S1");
  assert.equal(s.frontHeadingDeg, 180);
  assert.deepEqual(s.focus, { x: 0, y: 0 });
  const s1 = s.structures[0];
  near(s1.height, 5.4);
  assert.ok(s1.roofHeight > 0);

  // Fuego en el 2º piso, costado posterior (fachada al sur → posterior al norte).
  const f = s.fires[0];
  assert.equal(f.structureId, "S1");
  assert.equal(f.floor, 2);
  near(f.z, 1.5 * 2.7);
  near(f.y, 5.2);

  // Persona en ventana del 2º piso: apoyada en la fachada más cercana (frente, al sur).
  const p = s.people[0];
  assert.equal(p.risk, "critical");
  near(p.y, -5.5);
  near(p.z, 2.75);
  assert.equal(p.evidence[0].ref, "M1");

  assert.equal(s.smokes[0].driftDeg, 60);
  assert.equal(s.roads[1].blocked, true);
  assert.equal(s.cameras[0].mediaRef, "M1");
  assert.equal(s.uncertaintyNotes.length, 2);
});

test("null, objeto vacío o listas ausentes → escena vacía segura", () => {
  for (const input of [null, undefined, {} as SceneModel, { structures: "x", people: 3 } as unknown as SceneModel]) {
    const s = normalizeScene(input);
    assert.equal(s.structures.length, 0);
    assert.equal(s.people.length, 0);
    assert.equal(s.confidence, "low");
    assert.equal(s.primaryId, null);
    assert.deepEqual(s.focus, { x: 0, y: 0 });
  }
});

test("datos imperfectos: ids, pisos 0, dimensiones ≤ 0, NaN, coordenadas enormes, enums inválidos", () => {
  const bad = {
    structures: [
      { id: "", kind: "castle", floors: 0, width_m: -3, depth_m: 0, floor_height_m: -1, x: 1e9, y: Number.NaN, rotation_deg: 725, roof: "dome", role: "???" },
      { id: "S1", kind: "house_2_story", floors: 0, width_m: 9, depth_m: 11, x: 5, y: -1e12, role: "exposure" },
      { id: "S1", kind: "apartment_building", floors: 300, width_m: 1e6, depth_m: 20 },
    ],
    fire_zones: [
      { id: "F1", structure_id: "S1", floor: 99, side: "left", x: Number.NaN, y: 0, z: -5, radius_m: 0, intensity: "inferno" },
      { id: "F1", structure_id: "NOPE", floor: 2, side: "front", x: 3, y: 3, z: 1e9, radius_m: 1e6, intensity: "light" },
    ],
    people: [
      { id: "P1", status: "trapped", count: 0, structure_id: "S9", floor: -2, x: 2, y: 2, z: 1e5, evidence: [{ ref: "", frame: 1 }, { ref: "M2", frame: "x" }] },
      { status: "levitating", count: 2.6 },
    ],
    vehicles: [{ id: "V1", kind: "spaceship", state: "upright", length_m: -1, width_m: 0, rotation_deg: Number.POSITIVE_INFINITY }],
    hazards: [{ id: "Z1", kind: "power_lines", severity: "extreme", radius_m: -10 }],
    roads: [{ id: "R1", x1: 0, y1: 0, x2: 0, y2: 0 }, { id: "R2", x1: -1e7, y1: 0, x2: 50, y2: 0, width_m: 0 }],
    smoke_plumes: [{ id: "H1", volume: "none" }, { id: "H2", volume: "heavy", color: "none", drift_deg: -1 }],
    cameras: [{ media_ref: "" }, { media_ref: "M1", facing_deg: -1 }, { media_ref: "M1", facing_deg: 90 }],
    annotations: [{ text: "" }, { text: "Ojo", x: 1e8 }],
    uncertainty_notes: ["", 4, "Supuesto"],
    confidence: "very high",
  } as unknown as SceneModel;
  const s = normalizeScene(bad);

  const ids = s.structures.map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length, "ids únicos");
  assert.ok(ids.every((id) => id.length > 0), "ids no vacíos");
  const [a, b, c] = s.structures;
  assert.equal(a.kind, "unknown");
  assert.equal(a.floors, 1);
  assert.ok(a.assumed.floors && a.assumed.size && a.assumed.floorHeight);
  assert.ok(a.width > 0 && a.depth > 0 && a.floorHeight === 2.7);
  assert.equal(a.x, COORD_LIMIT);
  assert.equal(a.y, 0);
  assert.equal(a.rotationDeg, 5);
  assert.equal(a.roof, "unknown");
  assert.equal(a.role, "reference");
  assert.equal(b.floors, 2, "pisos 0 → valor típico del tipo");
  assert.equal(b.y, -COORD_LIMIT);
  assert.equal(c.floors, 60);
  assert.equal(c.width, 300);

  const [f1, f2] = s.fires;
  assert.notEqual(f1.id, f2.id);
  assert.equal(f1.structureId, "S1");
  assert.equal(f1.intensity, "moderate");
  assert.equal(f1.floor, 2, "piso acotado a los pisos de la estructura");
  assert.ok(f1.radius > 0);
  assert.equal(f2.structureId, null, "structure_id inexistente → exterior");
  assert.ok(f2.z <= 400 && f2.radius <= 25);
  assert.equal(b.role, "exposure", "un rol válido no se reemplaza");

  const [p1, p2] = s.people;
  assert.equal(p1.structureId, null);
  assert.equal(p1.count, 0, "0 = cantidad no determinada");
  assert.equal(p1.risk, "critical");
  assert.ok(p1.z <= 400);
  assert.equal(p1.evidence.length, 1);
  assert.equal(p1.evidence[0].frame, -1);
  assert.equal(p2.status, "unknown");
  assert.equal(p2.count, 3);
  assert.ok(p2.id.length > 0);

  assert.equal(s.vehicles[0].kind, "other");
  assert.ok(s.vehicles[0].length > 0 && s.vehicles[0].width > 0);
  assert.ok(Number.isFinite(s.vehicles[0].rotationDeg));
  assert.equal(s.hazards[0].severity, "medium");
  assert.ok(s.hazards[0].radius > 0);
  assert.equal(s.roads.length, 1, "calle de largo 0 descartada");
  assert.equal(s.roads[0].x1, -COORD_LIMIT);
  assert.equal(s.roads[0].width, 7);
  assert.equal(s.smokes.length, 1);
  assert.equal(s.smokes[0].color, "gray");
  assert.equal(s.smokes[0].driftDeg, null);
  assert.equal(s.cameras.length, 1);
  assert.equal(s.cameras[0].facingDeg, null);
  assert.equal(s.annotations.length, 1);
  assert.deepEqual(s.uncertaintyNotes, ["Supuesto"]);
  assert.equal(s.confidence, "low");

  const view = buildSceneView(s, [], [], ORIGIN);
  for (const v of Object.values(view.frame)) assert.ok(Number.isFinite(v));
});

test("rol ausente con fuego asociado → estructura afectada", () => {
  const s = normalizeScene({
    structures: [{ id: "S1", x: 0, y: 0 }],
    fire_zones: [{ id: "F1", structure_id: "S1", floor: 1, side: "front", intensity: "heavy" }],
  } as unknown as SceneModel);
  assert.equal(s.structures[0].role, "involved");
  assert.equal(s.primaryId, "S1");
});

function media(partial: Partial<MediaLike> & { label: string }): MediaLike {
  return {
    id: `id-${partial.label}`,
    source: "citizen",
    kind: "video",
    lat: null,
    lng: null,
    heading_deg: null,
    accuracy_m: null,
    frames: [],
    urls: { poster: `/api/files/${partial.label}.jpg` },
    ...partial,
  };
}

test("cámaras: la escena manda; medios con GPS agregan su cámara real", () => {
  const s = normalizeScene(SAMPLE_SCENE);
  const p2 = destination(ORIGIN, 90, 30);
  const far = destination(ORIGIN, 0, 5000);
  const list: MediaLike[] = [
    media({ label: "M1", lat: ORIGIN.lat, lng: ORIGIN.lng }),
    media({ label: "M2", lat: p2.lat, lng: p2.lng, heading_deg: 270, accuracy_m: 8 }),
    media({ label: "M3", lat: far.lat, lng: far.lng }),
    media({ label: "M4" }),
  ];
  const cams = deriveCameras(s, list, ORIGIN);
  assert.deepEqual(
    cams.map((c) => c.mediaRef),
    ["M1", "M2"],
  );
  const m1 = cams[0];
  assert.equal(m1.origin, "scene");
  assert.equal(m1.mediaId, "id-M1");
  assert.equal(m1.posterUrl, "/api/files/M1.jpg");
  near(m1.y, -25);
  const m2 = cams[1];
  assert.equal(m2.origin, "gps");
  near(m2.x, 30, 0.05);
  near(m2.y, 0, 0.05);
  assert.equal(m2.facingDeg, 270);
  assert.equal(m2.confidence, "high");
  // Sin origen válido no se convierte nada.
  assert.equal(deriveCameras(s, list, { lat: 0, lng: 0 }).length, 1);
});

test("drones: traza y posición actual en coordenadas locales", () => {
  const p = destination(ORIGIN, 0, 60);
  const track = Array.from({ length: 500 }, (_, i) => {
    const q = destination(ORIGIN, (i * 360) / 500, 60);
    return { at: new Date(1_700_000_000_000 + i * 1000).toISOString(), lat: q.lat, lng: q.lng, alt_m: 45, heading_deg: 90, speed_ms: 8, battery_pct: 80 };
  });
  const missions: MissionLike[] = [
    { id: "m1", label: "D1", status: "on_station", mode: "device", last: { ...track[0], lat: p.lat, lng: p.lng }, track },
    { id: "m2", label: "D2", status: "planned", mode: "api", last: null, track: [] },
  ];
  const drones = deriveDrones(missions, ORIGIN);
  assert.equal(drones.length, 1);
  const d = drones[0];
  near(d.y, 60, 0.05);
  near(d.x, 0, 0.05);
  assert.equal(d.z, 45);
  assert.equal(d.headingDeg, 90);
  assert.equal(d.mode, "device");
  assert.ok(d.track.length <= 241 && d.track.length > 100);
  assert.deepEqual(deriveDrones(missions, { lat: Number.NaN, lng: 0 }), []);
});

test("encuadre: incluye el contenido y descarta valores atípicos lejanos", () => {
  const s = normalizeScene(SAMPLE_SCENE);
  const base = frameBounds(s, s.cameras, []);
  assert.ok(base.minX <= -35 && base.maxX >= 15, "incluye grifo, puesto de mando y estructura vecina");
  assert.ok(base.minY <= -25, "incluye la cámara M1");
  assert.ok(base.maxZ >= 5.4);
  const withOutlier = normalizeScene({
    ...SAMPLE_SCENE,
    access_points: [...SAMPLE_SCENE.access_points, { id: "A9", kind: "other", x: 900, y: 900, label: "", note: "" }],
  });
  const fb = frameBounds(withOutlier, withOutlier.cameras, []);
  assert.ok(fb.maxX < 200 && fb.maxY < 200, "el punto a 900 m no aleja la cámara");
  const empty = frameBounds(normalizeScene(null), [], []);
  assert.ok(empty.maxX - empty.minX >= 30, "semiextensión mínima de 15 m");
});

test("findEntity y hashString", () => {
  const view = buildSceneView(normalizeScene(SAMPLE_SCENE), [], [], ORIGIN);
  assert.equal(findEntity(view, { kind: "person", id: "P1" })?.kind, "person");
  assert.equal(findEntity(view, { kind: "camera", id: "M1" })?.kind, "camera");
  assert.equal(findEntity(view, { kind: "structure", id: "NOPE" }), null);
  assert.equal(findEntity(view, null), null);
  assert.equal(hashString("abc"), hashString("abc"));
  assert.notEqual(hashString("abc"), hashString("abd"));
});
