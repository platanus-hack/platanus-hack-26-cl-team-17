import { test } from "node:test";
import assert from "node:assert/strict";
import type { CommEntry, CommsAnalysis, Media, MediaAnalysis, SceneModel } from "@/lib/domain";
import { ensureReportedPeople, postScene } from "./engine-claude";
import type { FusionInput } from "./types";

const scene: SceneModel = {
  description: "",
  ground: { street_axis_deg: 90, notes: "" },
  roads: [],
  structures: [
    {
      id: "S1",
      label: "Casa",
      kind: "house_2_story",
      role: "involved",
      x: 2,
      y: 3,
      width_m: 8,
      depth_m: 10,
      floors: 2,
      floor_height_m: 2.7,
      rotation_deg: 180,
      roof: "gable",
      construction: "wood",
      confidence: "medium",
      notes: "",
    },
  ],
  fire_zones: [],
  smoke_plumes: [],
  people: [],
  vehicles: [],
  hazards: [],
  access_points: [],
  cameras: [],
  annotations: [],
  uncertainty_notes: [],
  confidence: "low",
};

function person(status: MediaAnalysis["people"][number]["status"], count: number, floor: number) {
  return { status, count, location: "ventana 2º piso", floor, frame_refs: [0], confidence: "low" as const, description: "d" };
}

function input(people: MediaAnalysis["people"], victims: CommsAnalysis["victims"]["status"] = "unknown"): FusionInput {
  const media = { label: "M1", frames: [{ idx: 0 }] } as Media;
  const analysis = { people } as MediaAnalysis;
  const commsAnalysis = { victims: { status: victims, detail: "vecinos informan", entry_seqs: [3] } } as CommsAnalysis;
  return {
    incident: {} as FusionInput["incident"],
    media: [{ media, analysis, analysis_engine: "claude" }],
    comms: [{ seq: 3 } as CommEntry],
    commsAnalysis,
    keyFrames: [],
    previousSituation: null,
    previousScene: null,
    now: "2026-11-21T12:00:00.000Z",
  };
}

test("persona reportada que la escena omitió → un marcador en la estructura afectada, confianza baja", () => {
  const people = ensureReportedPeople(scene, input([person("at_window_or_balcony", 1, 2)], "reported"));
  assert.equal(people.length, 1, "un solo marcador aunque lo informen el medio y la radio");
  const p = people[0];
  assert.equal(p.status, "at_window_or_balcony");
  assert.equal(p.structure_id, "S1");
  assert.equal(p.floor, 2);
  assert.deepEqual([p.x, p.y], [2, 3]);
  assert.ok(Math.abs(p.z - 4.2) < 1e-9);
  assert.equal(p.confidence, "low");
  assert.deepEqual(
    p.evidence.map((e) => e.ref),
    ["M1", "C3"],
  );
});

test("solo radio con víctimas informadas también agrega marcador", () => {
  const people = ensureReportedPeople(scene, input([], "reported"));
  assert.equal(people.length, 1);
  assert.equal(people[0].status, "unknown");
  assert.equal(people[0].count, 1);
});

test("sin personas en riesgo o con la persona ya ubicada no se agrega nada", () => {
  assert.equal(ensureReportedPeople(scene, input([person("bystander", 4, 0)])).length, 0);
  const placed: SceneModel = {
    ...scene,
    people: [
      {
        id: "P1",
        status: "trapped",
        count: 1,
        structure_id: "S1",
        floor: 2,
        x: 0,
        y: 0,
        z: 4.2,
        confidence: "medium",
        note: "",
        evidence: [{ ref: "M1", frame: 0, note: "" }],
      },
    ],
  };
  const out = postScene(placed, input([person("trapped", 1, 2)], "reported"));
  assert.equal(out.people.length, 1);
  assert.equal(out.people[0].id, "P1");
});
