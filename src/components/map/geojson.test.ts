import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Position } from "geojson";
import type { SceneModel } from "@/lib/domain";
import { bearingDeg, distanceM, toLatLng, toLocal, type LatLng } from "@/lib/geo";
import {
  boundsOf,
  cameraConeRing,
  cameraCones,
  cameraPlacements,
  circlePolygon,
  circleRing,
  coneRangeM,
  droneOverlays,
  lineFromPoints,
  orientedRectRing,
  rangeRings,
  roadPolygon,
  sceneHasPeopleAtRisk,
  sceneOverlays,
  structureFacade,
  structureFootprint,
  type CameraMediaInput,
  type DroneMissionInput,
} from "./geojson";

const ORIGIN: LatLng = { lat: -33.4489, lng: -70.6693 };
const ll = (p: Position): LatLng => ({ lng: p[0], lat: p[1] });

/** Área con signo (fórmula del cordón) en metros locales: > 0 = antihorario. */
function signedAreaM2(ring: Position[]): number {
  const pts = ring.map((p) => toLocal(ORIGIN, ll(p)));
  let s = 0;
  for (let i = 0; i < pts.length - 1; i++) s += pts[i].x * pts[i + 1].y - pts[i + 1].x * pts[i].y;
  return s / 2;
}

function assertClosed(ring: Position[]) {
  assert.deepEqual(ring[0], ring[ring.length - 1], "el anillo debe cerrarse");
}

function extentM(ring: Position[]) {
  const pts = ring.map((p) => toLocal(ORIGIN, ll(p)));
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return { ew: Math.max(...xs) - Math.min(...xs), ns: Math.max(...ys) - Math.min(...ys) };
}

function structure(over: Partial<SceneModel["structures"][number]> = {}): SceneModel["structures"][number] {
  return {
    id: "S1",
    label: "Casa",
    kind: "house_2_story",
    role: "involved",
    x: 0,
    y: 0,
    width_m: 10,
    depth_m: 20,
    floors: 2,
    floor_height_m: 2.7,
    rotation_deg: 0,
    roof: "gable",
    construction: "wood",
    confidence: "medium",
    notes: "",
    ...over,
  };
}

function emptyScene(over: Partial<SceneModel> = {}): SceneModel {
  return {
    description: "",
    ground: { street_axis_deg: -1, notes: "" },
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

describe("círculo en metros", () => {
  it("todos los vértices quedan al radio pedido, anillo cerrado y antihorario", () => {
    const ring = circleRing(ORIGIN, 100, 64);
    assert.equal(ring.length, 65);
    assertClosed(ring);
    for (const p of ring) assert.ok(Math.abs(distanceM(ORIGIN, ll(p)) - 100) < 0.5);
    assert.ok(signedAreaM2(ring) > 0, "debe ser antihorario (RFC 7946)");
    const area = signedAreaM2(ring);
    assert.ok(Math.abs(area - Math.PI * 100 * 100) / (Math.PI * 100 * 100) < 0.01);
  });

  it("circlePolygon envuelve el anillo con sus propiedades", () => {
    const f = circlePolygon(ORIGIN, 25, { id: "H1" }, 32);
    assert.equal(f.geometry.type, "Polygon");
    assert.equal(f.geometry.coordinates[0].length, 33);
    assert.deepEqual(f.properties, { id: "H1" });
  });

  it("rangeRings genera los anillos de 50/100/200 m", () => {
    const fc = rangeRings(ORIGIN);
    assert.deepEqual(
      fc.features.map((f) => f.properties.radius_m),
      [50, 100, 200],
    );
    const r200 = fc.features[2].geometry.coordinates;
    assert.ok(Math.abs(distanceM(ORIGIN, ll(r200[10])) - 200) < 1);
  });
});

describe("cono de cámara", () => {
  it("parte y termina en la cámara, con el arco al alcance y centrado en el rumbo", () => {
    const ring = cameraConeRing(ORIGIN, 45, 80, 60, 12);
    assert.deepEqual(ring[0], [ORIGIN.lng, ORIGIN.lat]);
    assertClosed(ring);
    const arc = ring.slice(1, -1);
    assert.equal(arc.length, 13);
    for (const p of arc) assert.ok(Math.abs(distanceM(ORIGIN, ll(p)) - 80) < 0.5);
    // Bordes en rumbo ± 30° y el punto medio en el rumbo.
    assert.ok(Math.abs(bearingDeg(ORIGIN, ll(arc[0])) - 75) < 0.5);
    assert.ok(Math.abs(bearingDeg(ORIGIN, ll(arc[arc.length - 1])) - 15) < 0.5);
    assert.ok(Math.abs(bearingDeg(ORIGIN, ll(arc[6])) - 45) < 0.5);
    assert.ok(signedAreaM2(ring) > 0, "debe ser antihorario");
  });

  it("funciona al cruzar el norte (rumbo 350°)", () => {
    const ring = cameraConeRing(ORIGIN, 350, 50);
    const mid = ring[1 + 6];
    assert.ok(Math.abs(bearingDeg(ORIGIN, ll(mid)) - 350) < 0.5);
    assert.ok(signedAreaM2(ring) > 0);
  });

  it("alcance proporcional a la distancia, acotado", () => {
    assert.equal(coneRangeM(0), 60);
    assert.equal(coneRangeM(10), 40);
    assert.equal(coneRangeM(100), 120);
    assert.equal(coneRangeM(5000), 250);
    assert.equal(coneRangeM(Number.NaN), 60);
  });
});

describe("polígono de estructura rotada", () => {
  it("rotation 0: fachada de 10 m de Este a Oeste, fondo de 20 m Norte-Sur", () => {
    const f = structureFootprint(ORIGIN, structure());
    assert.ok(f);
    const ring = f.geometry.coordinates[0];
    assert.equal(ring.length, 5);
    assertClosed(ring);
    const { ew, ns } = extentM(ring);
    assert.ok(Math.abs(ew - 10) < 0.05, `ew=${ew}`);
    assert.ok(Math.abs(ns - 20) < 0.05, `ns=${ns}`);
    assert.ok(signedAreaM2(ring) > 0);
    assert.ok(Math.abs(signedAreaM2(ring) - 200) < 0.5);
  });

  it("rotation 90: la fachada mira al Este, así que el fondo corre Este-Oeste", () => {
    const f = structureFootprint(ORIGIN, structure({ rotation_deg: 90 }));
    assert.ok(f);
    const { ew, ns } = extentM(f.geometry.coordinates[0]);
    assert.ok(Math.abs(ew - 20) < 0.05);
    assert.ok(Math.abs(ns - 10) < 0.05);
    const facade = structureFacade(ORIGIN, structure({ rotation_deg: 90 }));
    assert.ok(facade);
    const [a, b] = facade.geometry.coordinates.map((p) => toLocal(ORIGIN, ll(p)));
    // La fachada queda 10 m (medio fondo) al Este del centro y mide 10 m.
    assert.ok(Math.abs(a.x - 10) < 0.05 && Math.abs(b.x - 10) < 0.05);
    assert.ok(Math.abs(Math.hypot(a.x - b.x, a.y - b.y) - 10) < 0.05);
  });

  it("rotation 45 desplazada: esquinas a la distancia correcta del centro", () => {
    const s = structure({ x: 30, y: -12, rotation_deg: 45 });
    const f = structureFootprint(ORIGIN, s);
    assert.ok(f);
    const ring = f.geometry.coordinates[0].slice(0, 4).map((p) => toLocal(ORIGIN, ll(p)));
    for (const c of ring) assert.ok(Math.abs(Math.hypot(c.x - 30, c.y + 12) - Math.hypot(5, 10)) < 0.05);
    assert.ok(signedAreaM2(f.geometry.coordinates[0]) > 0);
  });

  it("descarta coordenadas absurdas y acota dimensiones inválidas", () => {
    assert.equal(structureFootprint(ORIGIN, structure({ x: Number.NaN })), null);
    assert.equal(structureFootprint(ORIGIN, structure({ y: 99_999 })), null);
    const f = structureFootprint(ORIGIN, structure({ width_m: -3, depth_m: 0, rotation_deg: -1 }));
    assert.ok(f);
    const { ew, ns } = extentM(f.geometry.coordinates[0]);
    assert.ok(Math.abs(ew - 10) < 0.05 && Math.abs(ns - 10) < 0.05);
  });

  it("orientedRectRing es antihorario para cualquier rumbo", () => {
    for (const h of [0, 33, 90, 180, 271]) {
      assert.ok(signedAreaM2(orientedRectRing(ORIGIN, { x: 5, y: 5 }, 8, 3, h)) > 0, `rumbo ${h}`);
    }
  });

  it("vías: rectángulo a lo largo del segmento con su ancho", () => {
    const f = roadPolygon(ORIGIN, { id: "R1", name: "", x1: -50, y1: 0, x2: 50, y2: 0, width_m: 8, blocked: true });
    assert.ok(f);
    const { ew, ns } = extentM(f.geometry.coordinates[0]);
    assert.ok(Math.abs(ew - 100) < 0.05 && Math.abs(ns - 8) < 0.05);
    assert.equal(f.properties.blocked, true);
    assert.equal(roadPolygon(ORIGIN, { id: "R2", name: "", x1: 1, y1: 1, x2: 1, y2: 1, width_m: 8, blocked: false }), null);
  });
});

describe("traza", () => {
  it("descarta puntos inválidos y repetidos consecutivos", () => {
    const line = lineFromPoints([
      { lat: -33.1, lng: -70.1 },
      { lat: -33.1, lng: -70.1 },
      { lat: Number.NaN, lng: -70.2 },
      { lat: 0, lng: 0 },
      { lat: -33.2, lng: -70.2 },
    ]);
    assert.deepEqual(line, [
      [-70.1, -33.1],
      [-70.2, -33.2],
    ]);
  });

  it("null con menos de dos puntos válidos; cerrada si se pide", () => {
    assert.equal(lineFromPoints([{ lat: -33.1, lng: -70.1 }]), null);
    const closed = lineFromPoints(
      [
        { lat: -33.1, lng: -70.1 },
        { lat: -33.2, lng: -70.1 },
        { lat: -33.2, lng: -70.2 },
      ],
      true,
    );
    assert.ok(closed);
    assert.equal(closed.length, 4);
    assert.deepEqual(closed[0], closed[3]);
  });

  it("droneOverlays: traza con la posición actual, ruta de órbita cerrada y waypoints", () => {
    const at = "2026-11-21T10:00:00.000Z";
    const point = (lat: number, lng: number) => ({ at, lat, lng, alt_m: 40, heading_deg: 0, speed_ms: 5, battery_pct: 80 });
    const mission: DroneMissionInput = {
      id: "m1",
      label: "D1",
      status: "on_station",
      pattern: "orbit",
      home_lat: -33.45,
      home_lng: -70.67,
      waypoints: [
        { lat: -33.4485, lng: -70.6693, alt_m: 40 },
        { lat: -33.4489, lng: -70.6688, alt_m: 40 },
        { lat: -33.4493, lng: -70.6693, alt_m: 40 },
      ],
      track: [point(-33.45, -70.67), point(-33.4495, -70.6695)],
      last: point(-33.4490, -70.6690),
    };
    const o = droneOverlays([mission, { ...mission, id: "m2", label: "D2", status: "landed", track: [], last: null, waypoints: [] }]);
    assert.equal(o.tracks.features.length, 1);
    assert.equal(o.tracks.features[0].geometry.coordinates.length, 3);
    assert.equal(o.tracks.features[0].properties.active, true);
    assert.equal(o.routes.features[0].geometry.coordinates.length, 4);
    assert.equal(o.waypoints.features.length, 3);
  });
});

describe("cámaras de los medios", () => {
  const media = (over: Partial<CameraMediaInput>): CameraMediaInput => ({
    id: "id",
    label: "M1",
    source: "citizen",
    kind: "video",
    lat: null,
    lng: null,
    heading_deg: null,
    frames: [],
    ...over,
  });

  it("GPS del medio > cuadro con posición > estimación de la escena; ordenadas por número", () => {
    const scene = emptyScene({
      cameras: [
        { media_ref: "M2", x: 0, y: -40, z: 1.5, facing_deg: 0, confidence: "low" },
        { media_ref: "M10", x: 20, y: 0, z: 1.5, facing_deg: -1, confidence: "low" },
      ],
    });
    const placements = cameraPlacements(
      ORIGIN,
      [
        media({ id: "a", label: "M10" }),
        media({ id: "b", label: "M2" }),
        media({ id: "c", label: "M1", lat: -33.4492, lng: -70.6693, heading_deg: 10 }),
        media({ id: "d", label: "M3", source: "drone", frames: [{ lat: -33.4489, lng: -70.6699, heading_deg: 90 }] }),
        media({ id: "e", label: "M4" }),
      ],
      scene,
    );
    assert.deepEqual(
      placements.map((p) => p.label),
      ["M1", "M2", "M3", "M10"],
    );
    const [m1, m2, m3, m10] = placements;
    assert.equal(m1.estimatedPosition, false);
    assert.equal(m1.heading, 10);
    assert.ok(Math.abs(m1.distanceM - 33.4) < 1);
    assert.equal(m2.estimatedPosition, true);
    assert.equal(m2.heading, 0);
    assert.equal(m2.estimatedHeading, true);
    assert.equal(m3.heading, 90);
    assert.equal(m3.estimatedPosition, false);
    assert.equal(m10.heading, null);
    const cones = cameraCones(placements);
    assert.deepEqual(
      cones.features.map((f) => [f.properties.label, f.properties.estimated]),
      [
        ["M1", false],
        ["M2", true],
        ["M3", false],
      ],
    );
  });
});

describe("escena", () => {
  it("personas en riesgo: atrapadas, en ventana o en el techo", () => {
    const person = (status: SceneModel["people"][number]["status"]) => ({
      id: "P1",
      status,
      count: 1,
      structure_id: "",
      floor: 0,
      x: 0,
      y: 0,
      z: 0,
      confidence: "low" as const,
      note: "",
      evidence: [],
    });
    assert.equal(sceneHasPeopleAtRisk(null), false);
    assert.equal(sceneHasPeopleAtRisk(emptyScene({ people: [person("bystander")] })), false);
    assert.equal(sceneHasPeopleAtRisk(emptyScene({ people: [person("on_roof")] })), true);
    assert.equal(sceneHasPeopleAtRisk(emptyScene({ people: [person("at_window_or_balcony")] })), true);
  });

  it("sceneOverlays convierte cada tipo de elemento y omite los inválidos", () => {
    const o = sceneOverlays(
      ORIGIN,
      emptyScene({
        structures: [structure(), structure({ id: "S2", x: Number.POSITIVE_INFINITY })],
        fire_zones: [
          { id: "F1", structure_id: "S1", floor: 2, side: "front", x: 0, y: 5, z: 4, radius_m: 3, intensity: "heavy", confidence: "medium", note: "" },
        ],
        hazards: [{ id: "H1", kind: "gas_cylinder", x: 8, y: 0, z: 0, radius_m: 30, severity: "high", note: "" }],
        vehicles: [
          { id: "V1", kind: "car", state: "on_side", x: 10, y: 10, rotation_deg: 90, length_m: 4, width_m: 2, entrapment_suspected: true, burning: false, note: "" },
        ],
      }),
    );
    assert.equal(o.structures.features.length, 1);
    assert.equal(o.facades.features.length, 1);
    assert.equal(o.fires.features[0].properties.intensity, "heavy");
    const hz = o.hazards.features[0].geometry.coordinates[0];
    const hazardCenter = toLatLng(ORIGIN, { x: 8, y: 0 });
    for (const p of hz) assert.ok(Math.abs(distanceM(hazardCenter, ll(p)) - 30) < 0.2);
    assert.equal(o.vehicles.features[0].properties.tone, "critical");
    const v = extentM(o.vehicles.features[0].geometry.coordinates[0]);
    assert.ok(Math.abs(v.ew - 4) < 0.05 && Math.abs(v.ns - 2) < 0.05);
    const none = sceneOverlays(ORIGIN, null);
    assert.equal(none.structures.features.length, 0);
  });

  it("boundsOf ignora puntos inválidos", () => {
    assert.equal(boundsOf([]), null);
    assert.deepEqual(
      boundsOf([
        { lat: -33.1, lng: -70.3 },
        { lat: 0, lng: 0 },
        { lat: -33.4, lng: -70.1 },
      ]),
      [
        [-70.3, -33.4],
        [-70.1, -33.1],
      ],
    );
  });
});
