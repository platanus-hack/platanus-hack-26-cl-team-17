import { test } from "node:test";
import assert from "node:assert/strict";
import type { MediaView } from "@/lib/contract";
import type { MediaAnalysis } from "@/lib/domain";
import {
  adjacentMedia,
  canExtractFramesInBrowser,
  mediaHasPeopleAtRisk,
  mediaLabelNumber,
  mediaStatusBusy,
  mediaTime,
  peopleAtRiskCount,
  posterUrl,
  resolveCitedFrame,
  sortMediaForStrip,
  sortedFrames,
  stageProgress,
} from "./media-utils";

function analysis(over: Partial<MediaAnalysis> = {}): MediaAnalysis {
  return {
    usable: true,
    unusable_reason: "",
    incident_type: "structure_fire",
    summary: "Casa con humo.",
    viewpoint: { position_description: "", facing: "unknown", distance_m: 0, elevation: "ground" },
    structure: {
      present: true,
      kind: "house_1_story",
      floors_visible: 1,
      construction: "wood",
      exposures: "",
      description: "",
    },
    fire: {
      present: true,
      stage: "growth",
      flames_visible: true,
      locations: [],
      smoke: { present: true, color: "black", volume: "heavy", description: "" },
      spread_risk: "high",
    },
    people: [],
    vehicles: [],
    hazards: [],
    access: { description: "", obstructions: [], water_sources: [] },
    key_frames: [],
    visible_text: [],
    uncertainties: [],
    confidence: "medium",
    ...over,
  };
}

type Person = MediaAnalysis["people"][number];
function person(status: Person["status"], count = 1): Person {
  return { status, count, location: "", floor: 0, frame_refs: [], confidence: "medium", description: "" };
}

type Vehicle = MediaAnalysis["vehicles"][number];
function vehicle(entrapment: boolean): Vehicle {
  return {
    kind: "car",
    state: "upright",
    damage: "severe",
    occupants_visible: "unknown",
    entrapment_suspected: entrapment,
    leaking_fluids: false,
    position: "",
    description: "",
    frame_refs: [],
  };
}

function media(over: Partial<MediaView> = {}): MediaView {
  return {
    id: "m1",
    incident_id: "i1",
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
    created_at: "2026-11-21T10:00:00.000Z",
    urls: { video: null, poster: null, frames: [] },
    ...over,
  };
}

const frame = (idx: number, url = `/f/${idx}.jpg`) => ({ idx, t_s: idx * 2, url, width: 640, height: 360 });

test("mediaHasPeopleAtRisk: sin análisis → false", () => {
  assert.equal(mediaHasPeopleAtRisk(media()), false);
});

test("mediaHasPeopleAtRisk: estados de riesgo", () => {
  for (const s of ["trapped", "at_window_or_balcony", "on_roof", "injured"] as const) {
    assert.equal(mediaHasPeopleAtRisk(media({ analysis: analysis({ people: [person(s)] }) })), true, s);
  }
});

test("mediaHasPeopleAtRisk: testigos, personal y evacuando no marcan", () => {
  const a = analysis({ people: [person("bystander", 5), person("responder", 3), person("evacuating", 2)] });
  assert.equal(mediaHasPeopleAtRisk(media({ analysis: a })), false);
});

test("mediaHasPeopleAtRisk: vehículo con atrapamiento sospechado marca", () => {
  assert.equal(mediaHasPeopleAtRisk(media({ analysis: analysis({ vehicles: [vehicle(true)] }) })), true);
  assert.equal(mediaHasPeopleAtRisk(media({ analysis: analysis({ vehicles: [vehicle(false)] }) })), false);
});

test("peopleAtRiskCount suma grupos y cuenta 0 como 1", () => {
  const a = analysis({ people: [person("trapped", 2), person("on_roof", 0), person("bystander", 9)] });
  assert.equal(peopleAtRiskCount(media({ analysis: a })), 3);
  assert.equal(peopleAtRiskCount(media()), 0);
});

test("posterUrl: póster, si no el primer fotograma por índice, si no null", () => {
  assert.equal(posterUrl(media({ urls: { video: null, poster: "/p.jpg", frames: [frame(0)] } })), "/p.jpg");
  assert.equal(posterUrl(media({ urls: { video: null, poster: null, frames: [frame(3), frame(1)] } })), "/f/1.jpg");
  assert.equal(posterUrl(media()), null);
});

test("sortedFrames no muta y ordena por idx", () => {
  const frames = [frame(2), frame(0), frame(1)];
  const m = media({ urls: { video: null, poster: null, frames } });
  assert.deepEqual(
    sortedFrames(m).map((f) => f.idx),
    [0, 1, 2],
  );
  assert.deepEqual(
    frames.map((f) => f.idx),
    [2, 0, 1],
  );
});

test("mediaLabelNumber", () => {
  assert.equal(mediaLabelNumber("M12"), 12);
  assert.equal(mediaLabelNumber(" m3 "), 3);
  assert.equal(mediaLabelNumber("C4"), null);
  assert.equal(mediaLabelNumber(""), null);
});

test("sortMediaForStrip: M1..Mn aunque llegue desordenado y sin mutar", () => {
  const list = [
    media({ id: "c", label: "M10", created_at: "2026-11-21T10:00:03Z" }),
    media({ id: "a", label: "M2", created_at: "2026-11-21T10:00:01Z" }),
    media({ id: "b", label: "M1", created_at: "2026-11-21T10:00:02Z" }),
  ];
  assert.deepEqual(
    sortMediaForStrip(list).map((m) => m.label),
    ["M1", "M2", "M10"],
  );
  assert.deepEqual(
    list.map((m) => m.id),
    ["c", "a", "b"],
  );
});

test("sortMediaForStrip: sin etiqueta numérica usa hora de registro y luego id", () => {
  const list = [
    media({ id: "z", label: "X", created_at: "2026-11-21T10:00:05Z" }),
    media({ id: "y", label: "X", created_at: "2026-11-21T10:00:01Z" }),
    media({ id: "b", label: "X", created_at: "bad" }),
    media({ id: "a", label: "X", created_at: "bad" }),
    media({ id: "m", label: "M1", created_at: "2026-11-21T11:00:00Z" }),
  ];
  assert.deepEqual(
    sortMediaForStrip(list).map((m) => m.id),
    ["m", "y", "z", "a", "b"],
  );
});

test("mediaStatusBusy", () => {
  assert.equal(mediaStatusBusy("uploading"), true);
  assert.equal(mediaStatusBusy("uploaded"), true);
  assert.equal(mediaStatusBusy("analyzing"), true);
  assert.equal(mediaStatusBusy("analyzed"), false);
  assert.equal(mediaStatusBusy("failed"), false);
});

test("mediaTime prefiere la hora de captura", () => {
  assert.equal(mediaTime(media({ captured_at: "2026-11-21T09:59:00Z" })), "2026-11-21T09:59:00Z");
  assert.equal(mediaTime(media()), "2026-11-21T10:00:00.000Z");
});

test("canExtractFramesInBrowser: solo con video y sin fotogramas", () => {
  assert.equal(canExtractFramesInBrowser(media({ urls: { video: "/v.mp4", poster: null, frames: [] } })), true);
  assert.equal(canExtractFramesInBrowser(media()), false);
  assert.equal(canExtractFramesInBrowser(media({ urls: { video: "/v.mp4", poster: null, frames: [frame(0)] } })), false);
});

test("resolveCitedFrame: solo índices que existen", () => {
  const m = media({ urls: { video: null, poster: null, frames: [frame(0), frame(4)] } });
  assert.equal(resolveCitedFrame(m, 4), 4);
  assert.equal(resolveCitedFrame(m, 2), null);
  assert.equal(resolveCitedFrame(m, -1), null);
  assert.equal(resolveCitedFrame(m, null), null);
  assert.equal(resolveCitedFrame(m, undefined), null);
  assert.equal(resolveCitedFrame(m, 1.5), null);
});

test("adjacentMedia sigue el orden de la tira", () => {
  const list = [media({ id: "b", label: "M2" }), media({ id: "a", label: "M1" }), media({ id: "c", label: "M3" })];
  assert.equal(adjacentMedia(list, "b", 1)?.id, "c");
  assert.equal(adjacentMedia(list, "b", -1)?.id, "a");
  assert.equal(adjacentMedia(list, "a", -1), null);
  assert.equal(adjacentMedia(list, "c", 1), null);
  assert.equal(adjacentMedia(list, "nope", 1), null);
});

test("stageProgress acota y reparte", () => {
  assert.equal(stageProgress(0.2, 0.6, 0.5), 0.4);
  assert.equal(stageProgress(0.2, 0.6, 2), 0.6);
  assert.equal(stageProgress(0.2, 0.6, Number.NaN), 0.2);
});
