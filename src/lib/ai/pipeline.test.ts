import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EMPTY_PIPELINE } from "@/lib/domain";
import type {
  CommEntry,
  CommsAnalysis,
  Incident,
  Media,
  MediaAnalysis,
  MediaFrame,
  SceneModel,
  SituationReport,
  TimelineEvent,
} from "@/lib/domain";
import type { FileStorage, IncidentPatch, MediaPatch, NewEvent, NewFrame, Store } from "@/lib/store/types";
import { createPipeline, rankKeyFrameCandidates, resolveImageType, viewpointBearing, type PipelineDeps } from "./pipeline";
import type { CommsAnalysisInput, Engine, FusionInput, FusionMedia, MediaAnalysisInput } from "./types";

/* ═══════════════ Fakes en memoria ═══════════════ */

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');

class FakeStore implements Store {
  readonly kind = "local" as const;
  incidents = new Map<string, Incident>();
  media = new Map<string, Media>();
  comms: CommEntry[] = [];
  events: TimelineEvent[] = [];
  locks = new Set<string>();
  private n = 0;
  constructor(private readonly nowIso: () => string) {}

  async listIncidents() {
    return [...this.incidents.values()].map((i) => structuredClone(i));
  }
  async getIncident(id: string) {
    const i = this.incidents.get(id);
    return i ? structuredClone(i) : null;
  }
  async getIncidentByCode() {
    return null;
  }
  async getIncidentRev(id: string) {
    return this.incidents.get(id)?.rev ?? null;
  }
  async createIncident(): Promise<Incident> {
    throw new Error("no se usa en la prueba");
  }
  async updateIncident(id: string, patch: IncidentPatch) {
    const i = this.incidents.get(id);
    if (!i) throw new Error(`No encontrado: ${id}`);
    const { pipeline, ...rest } = patch;
    Object.assign(i, rest);
    if (pipeline) i.pipeline = { ...i.pipeline, ...pipeline };
    i.rev += 1;
    return structuredClone(i);
  }
  async getIncidentCounts() {
    return {};
  }
  async listMedia(incidentId: string) {
    return [...this.media.values()]
      .filter((m) => m.incident_id === incidentId)
      .map((m) => structuredClone(m));
  }
  async getMedia(id: string) {
    const m = this.media.get(id);
    return m ? structuredClone(m) : null;
  }
  async createMedia(): Promise<Media> {
    throw new Error("no se usa en la prueba");
  }
  async updateMedia(id: string, patch: MediaPatch) {
    const m = this.media.get(id);
    if (!m) throw new Error(`No encontrado: ${id}`);
    Object.assign(m, patch);
    return structuredClone(m);
  }
  async addFrames(mediaId: string, frames: NewFrame[]) {
    const m = this.media.get(mediaId);
    if (!m) throw new Error(`No encontrado: ${mediaId}`);
    const created: MediaFrame[] = frames.map((f) => ({ ...f, id: f.id ?? `f${++this.n}`, media_id: mediaId }));
    m.frames.push(...created);
    return structuredClone(created);
  }
  async verifyUploadToken() {
    return false;
  }
  async getOpenDroneBatch() {
    return null;
  }
  async listComms(incidentId: string) {
    return this.comms.filter((c) => c.incident_id === incidentId).map((c) => structuredClone(c));
  }
  async addComm(): Promise<CommEntry> {
    throw new Error("no se usa en la prueba");
  }
  async listMissions() {
    return [];
  }
  async getMission() {
    return null;
  }
  async createMission(): Promise<never> {
    throw new Error("no se usa en la prueba");
  }
  async updateMission(): Promise<never> {
    throw new Error("no se usa en la prueba");
  }
  async appendTelemetry(): Promise<never> {
    throw new Error("no se usa en la prueba");
  }
  async verifyIngestToken() {
    return false;
  }
  async listEvents(incidentId: string, limit = 200) {
    return this.events
      .filter((e) => e.incident_id === incidentId)
      .map((e, order) => ({ e, order }))
      .sort((a, b) => Date.parse(b.e.at) - Date.parse(a.e.at) || b.order - a.order)
      .slice(0, limit)
      .map((x) => structuredClone(x.e));
  }
  async addEvent(input: NewEvent) {
    const ev: TimelineEvent = {
      id: `e${++this.n}`,
      incident_id: input.incident_id,
      at: input.at ?? this.nowIso(),
      kind: input.kind,
      severity: input.severity,
      title: input.title,
      detail: input.detail,
      media_id: input.media_id ?? null,
      comm_id: input.comm_id ?? null,
      mission_id: input.mission_id ?? null,
    };
    this.events.push(ev);
    return structuredClone(ev);
  }
  async acquireLock(incidentId: string, name: string) {
    const key = `${incidentId}/${name}`;
    if (this.locks.has(key)) return false;
    this.locks.add(key);
    return true;
  }
  async releaseLock(incidentId: string, name: string) {
    this.locks.delete(`${incidentId}/${name}`);
  }
}

class FakeFiles implements FileStorage {
  readonly kind = "local" as const;
  blobs = new Map<string, { bytes: Uint8Array; contentType: string }>();
  downloads: string[] = [];
  async createUploadTarget(): Promise<never> {
    throw new Error("no se usa en la prueba");
  }
  async upload(p: string, bytes: Uint8Array, contentType: string) {
    this.blobs.set(p, { bytes, contentType });
  }
  async download(p: string) {
    this.downloads.push(p);
    const b = this.blobs.get(p);
    if (!b) throw new Error(`No existe ${p}`);
    return b;
  }
  async exists(p: string) {
    return this.blobs.has(p);
  }
  async getSignedReadUrl() {
    return null;
  }
  async remove(paths: string[]) {
    for (const p of paths) this.blobs.delete(p);
  }
}

/* ═══════════════ Datos de prueba ═══════════════ */

const INC = "11111111-1111-1111-1111-111111111111";

function makeIncident(): Incident {
  return {
    id: INC,
    code: "VG-TEST",
    type: "structure_fire",
    title: "Incendio en casa",
    address: "Pasaje Los Aromos 123",
    lat: -33.45,
    lng: -70.66,
    status: "active",
    description: "",
    origin: "command",
    verified: true,
    share_key: "k",
    rev: 1,
    situation: null,
    situation_engine: null,
    situation_updated_at: null,
    scene: null,
    scene_engine: null,
    scene_updated_at: null,
    comms_analysis: null,
    comms_engine: null,
    comms_analysis_updated_at: null,
    pipeline: { ...EMPTY_PIPELINE },
    created_at: "2026-11-21T11:00:00.000Z",
    updated_at: "2026-11-21T11:00:00.000Z",
  };
}

function frame(mediaId: string, idx: number, ext = "jpg"): MediaFrame {
  return {
    id: `${mediaId}-f${idx}`,
    media_id: mediaId,
    idx,
    t_s: idx * 2,
    storage_path: `incidents/${INC}/media/${mediaId}/frames/${String(idx).padStart(3, "0")}.${ext}`,
    width: 640,
    height: 360,
    lat: null,
    lng: null,
    alt_m: null,
    heading_deg: null,
  };
}

function makeMedia(id: string, n: number, over: Partial<Media> = {}): Media {
  return {
    id,
    incident_id: INC,
    label: `M${n}`,
    source: "citizen",
    kind: "video",
    mission_id: null,
    video_path: null,
    video_status: "none",
    mime: "video/mp4",
    size_bytes: 1000,
    duration_s: 10,
    lat: null,
    lng: null,
    accuracy_m: null,
    heading_deg: null,
    captured_at: null,
    reporter_note: "",
    status: "uploaded",
    error: null,
    analysis: null,
    analysis_engine: null,
    analyzed_at: null,
    frames: [],
    created_at: "2026-11-21T11:01:00.000Z",
    ...over,
  };
}

function makeAnalysis(over: Partial<MediaAnalysis> = {}): MediaAnalysis {
  return {
    usable: true,
    unusable_reason: "",
    incident_type: "structure_fire",
    summary: "Casa de 2 pisos con humo negro en el 2º piso.",
    viewpoint: { position_description: "vereda de enfrente", facing: "unknown", distance_m: 20, elevation: "ground" },
    structure: {
      present: true,
      kind: "house_2_story",
      floors_visible: 2,
      construction: "wood",
      exposures: "",
      description: "",
    },
    fire: {
      present: true,
      stage: "growth",
      flames_visible: false,
      locations: [],
      smoke: { present: true, color: "black", volume: "heavy", description: "" },
      spread_risk: "moderate",
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

function makeSituation(over: Partial<SituationReport> = {}): SituationReport {
  return {
    headline: "Casa con humo; posible persona atrapada",
    incident_type: "structure_fire",
    severity: "high",
    trapped: { status: "possible", count_min: 1, count_max: 1, locations: [], basis: "M1", evidence: [] },
    injured: { status: "no_evidence", count_estimate: 0, detail: "" },
    fire: { present: true, stage: "growth", location: "", spread: "", smoke: "" },
    structure: { description: "", floors: 2, construction: "wood", exposures: "" },
    vehicles: { count: 0, description: "", entrapment: "no_evidence", details: "" },
    hazards: [],
    access: { best_approach: "", obstructions: [], water_supply: "", staging_suggestion: "" },
    insights: [],
    contradictions: [],
    unknowns: [],
    recommended_actions: [],
    briefing: { spoken: "", bullets: [] },
    overall_confidence: "medium",
    ...over,
  };
}

function makeScene(): SceneModel {
  return {
    description: "Casa al norte de la calle",
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
    confidence: "low",
  };
}

function makeCommsAnalysis(over: Partial<CommsAnalysis> = {}): CommsAnalysis {
  return {
    summary: "B-3 en el lugar.",
    units: [],
    events: [],
    victims: { status: "unknown", detail: "", entry_seqs: [] },
    mayday: { active: false, detail: "" },
    resource_requests: [],
    hazards: [],
    command: { established: false, commander: "", post_location: "" },
    codes_interpreted: [],
    open_questions: [],
    ...over,
  };
}

interface EngineCalls {
  media: MediaAnalysisInput[];
  comms: CommsAnalysisInput[];
  situation: FusionInput[];
  scene: FusionInput[];
}

function fakeEngine(kind: Engine["kind"], impl: Partial<Engine> = {}): Engine & { calls: EngineCalls } {
  const calls: EngineCalls = { media: [], comms: [], situation: [], scene: [] };
  return {
    kind,
    calls,
    async analyzeMedia(input) {
      calls.media.push(input);
      return impl.analyzeMedia ? impl.analyzeMedia(input) : makeAnalysis();
    },
    async analyzeComms(input) {
      calls.comms.push(input);
      return impl.analyzeComms ? impl.analyzeComms(input) : makeCommsAnalysis();
    },
    async fuseSituation(input) {
      calls.situation.push(input);
      return impl.fuseSituation ? impl.fuseSituation(input) : makeSituation();
    },
    async fuseScene(input) {
      calls.scene.push(input);
      return impl.fuseScene ? impl.fuseScene(input) : makeScene();
    },
  };
}

function setup(
  opts: { engine?: Engine & { calls: EngineCalls }; extractFrames?: PipelineDeps["extractFrames"]; rulesOnly?: PipelineDeps["rulesOnly"] } = {},
) {
  let t = Date.parse("2026-11-21T12:00:00.000Z");
  const now = () => new Date((t += 1000));
  const nowIso = () => now().toISOString();
  const store = new FakeStore(nowIso);
  const files = new FakeFiles();
  store.incidents.set(INC, makeIncident());
  const engine = opts.engine ?? fakeEngine("claude");
  const fallback = fakeEngine("simulated");
  let sanitizeCalls = 0;
  const pipeline = createPipeline({
    store,
    files,
    engine,
    fallbackEngine: fallback,
    rulesOnly: opts.rulesOnly,
    extractFrames:
      opts.extractFrames ??
      (async () => {
        throw new Error("sin ffmpeg en la prueba");
      }),
    now,
    sanitizeScene: (scene) => {
      sanitizeCalls += 1;
      return { ...scene, description: `${scene.description} [saneada]` };
    },
  });
  return { store, files, engine, fallback, pipeline, sanitizeCalls: () => sanitizeCalls };
}

function addMediaWithFrames(
  ctx: ReturnType<typeof setup>,
  id: string,
  n: number,
  idxs: number[],
  over: Partial<Media> = {},
  ext = "jpg",
) {
  const frames = idxs.map((i) => frame(id, i, ext));
  for (const f of frames) {
    ctx.files.blobs.set(f.storage_path, ext === "svg" ? { bytes: SVG, contentType: "image/svg+xml" } : { bytes: JPEG, contentType: "image/jpeg" });
  }
  const m = makeMedia(id, n, { frames, ...over });
  ctx.store.media.set(id, m);
  return m;
}

/* ═══════════════ Pruebas ═══════════════ */

// El pipeline registra cada falla con console.error; en las pruebas de fallas es ruido.
const realConsoleError = console.error;
before(() => {
  console.error = () => {};
});
after(() => {
  console.error = realConsoleError;
});

test("processMedia: descarga fotogramas, guarda análisis, alerta de persona atrapada sin duplicar", async () => {
  const analysis = makeAnalysis({
    people: [
      {
        status: "trapped",
        count: 1,
        location: "ventana del 2º piso",
        floor: 2,
        frame_refs: [1],
        confidence: "medium",
        description: "Persona haciendo señas.",
      },
      {
        status: "at_window_or_balcony",
        count: 1,
        location: "balcón lado izquierdo",
        floor: 2,
        frame_refs: [2],
        confidence: "low",
        description: "Silueta poco clara.",
      },
    ],
    hazards: [{ kind: "gas_cylinder", description: "Cilindro junto a la puerta.", severity: "high", frame_refs: [0] }],
  });
  const engine = fakeEngine("claude", { analyzeMedia: async () => analysis });
  const ctx = setup({ engine });
  addMediaWithFrames(ctx, "m1", 1, [2, 0, 1]);

  await ctx.pipeline.processMedia("m1");

  assert.equal(engine.calls.media.length, 1);
  const input = engine.calls.media[0];
  assert.deepEqual(input.frames.map((f) => f.idx), [0, 1, 2]);
  assert.ok(input.frames.every((f) => f.media_type === "image/jpeg" && f.base64 === Buffer.from(JPEG).toString("base64")));
  assert.equal(input.incident.id, INC);
  assert.match(input.now, /^2026-11-21T12:/);

  const m = ctx.store.media.get("m1")!;
  assert.equal(m.status, "analyzed");
  assert.equal(m.analysis_engine, "claude");
  assert.deepEqual(m.analysis, analysis);
  assert.ok(m.analyzed_at);

  const analyzed = ctx.store.events.filter((e) => e.kind === "media_analyzed");
  assert.equal(analyzed.length, 1);
  assert.equal(analyzed[0].title, "M1 analizado");
  assert.equal(analyzed[0].detail, analysis.summary);

  const alerts = ctx.store.events.filter((e) => e.kind === "alert");
  const trapped = alerts.filter((e) => e.severity === "critical");
  assert.equal(trapped.length, 1, "la de confianza baja no alerta");
  assert.equal(trapped[0].title, "Posible persona atrapada — M1: ventana del 2º piso");
  assert.equal(trapped[0].media_id, "m1");
  const hazard = alerts.filter((e) => e.severity === "warning");
  assert.equal(hazard.length, 1);
  assert.equal(hazard[0].title, "Peligro: Cilindro de gas — M1");

  // Luego pidió la fusión.
  assert.equal(engine.calls.situation.length, 1);
  assert.ok(ctx.store.incidents.get(INC)!.situation);

  await ctx.pipeline.processMedia("m1", { force: true });
  assert.equal(engine.calls.media.length, 2);
  assert.equal(ctx.store.events.filter((e) => e.kind === "alert").length, 2, "sin alertas duplicadas");
  assert.equal(ctx.store.locks.size, 0);
});

test("processMedia: medio demo con análisis no se reanaliza pero sí pide fusión", async () => {
  const ctx = setup();
  addMediaWithFrames(ctx, "m1", 1, [0], { source: "demo", analysis: makeAnalysis(), analysis_engine: "simulated", status: "analyzed" }, "svg");
  await ctx.pipeline.processMedia("m1");
  assert.equal(ctx.engine.calls.media.length, 0);
  assert.equal(ctx.engine.calls.situation.length, 1);
  assert.equal(ctx.engine.calls.situation[0].keyFrames.length, 0, "nunca fotogramas de demo");
  assert.equal(ctx.store.media.get("m1")!.status, "analyzed");
});

test("processMedia: medio precargado del simulacro alerta, queda analizado y no duplica alertas", async () => {
  const ctx = setup();
  const analysis = makeAnalysis({
    people: [
      {
        status: "at_window_or_balcony",
        count: 1,
        location: "balcón del 3er piso",
        floor: 3,
        frame_refs: [0],
        confidence: "high",
        description: "Persona pidiendo ayuda.",
      },
    ],
    hazards: [{ kind: "gas_cylinder", description: "Cilindro expuesto.", severity: "high", frame_refs: [0] }],
  });
  addMediaWithFrames(
    ctx,
    "m2",
    2,
    [0],
    { source: "demo", analysis, analysis_engine: "simulated", status: "uploaded", analyzed_at: null },
    "svg",
  );

  await ctx.pipeline.processMedia("m2");

  assert.equal(ctx.engine.calls.media.length, 0, "no se reanaliza");
  const m = ctx.store.media.get("m2")!;
  assert.equal(m.status, "analyzed");
  assert.ok(m.analyzed_at);
  const alerts = ctx.store.events.filter((e) => e.kind === "alert" && e.media_id === "m2");
  assert.deepEqual(
    alerts.map((e) => [e.severity, e.title]),
    [
      ["critical", "Posible persona atrapada — M2: balcón del 3er piso"],
      ["warning", "Peligro: Cilindro de gas — M2"],
    ],
  );
  assert.equal(ctx.engine.calls.situation.length, 1, "pidió la fusión");

  await ctx.pipeline.processMedia("m2");
  assert.equal(ctx.store.events.filter((e) => e.kind === "alert").length, 2, "sin alertas duplicadas");
});

test("rankKeyFrameCandidates: maximiza puntos de vista — dron primero, un cuadro por medio, ángulos ≥ 60° antes que repetidos", () => {
  const origin = { lat: -33.45, lng: -70.66 };
  const trapped = {
    people: [
      {
        status: "trapped" as const,
        count: 1,
        location: "2º piso",
        floor: 2,
        frame_refs: [0],
        confidence: "high" as const,
        description: "",
      },
    ],
  };
  const kfs = (...idx: number[]) => idx.map((i) => ({ frame: i, caption: `cuadro ${i}` }));
  const fm = (m: Media): FusionMedia => ({ media: m, analysis: m.analysis, analysis_engine: m.analysis_engine });
  const mk = (id: string, n: number, over: Partial<Media>, a: Partial<MediaAnalysis>) =>
    fm(makeMedia(id, n, { frames: [frame(id, 0), frame(id, 1)], analysis: makeAnalysis({ key_frames: kfs(0, 1), ...a }), analysis_engine: "claude", ...over }));

  const media: FusionMedia[] = [
    // Tres vistas desde el sur (rumbo ~0 → cámara al sur), con lo más importante.
    mk("s1", 1, { heading_deg: 0 }, trapped),
    mk("s2", 2, { heading_deg: 10 }, trapped),
    mk("s3", 3, { heading_deg: 350 }, trapped),
    // Lado este (mira al oeste) con llamas; lado norte por GPS; uno sin orientación.
    mk("e1", 4, { heading_deg: 270 }, { fire: { ...makeAnalysis().fire, flames_visible: true } }),
    mk("n1", 5, { lat: origin.lat + 0.0005, lng: origin.lng }, {}),
    mk("w1", 6, {}, {}),
    // Dron: siempre entra, aunque su contenido pese menos.
    mk("d1", 7, { source: "drone", kind: "frames" }, { viewpoint: { ...makeAnalysis().viewpoint, elevation: "aerial" } }),
    // Demo: nunca.
    mk("x1", 8, { source: "demo" }, trapped),
  ];

  const ranked = rankKeyFrameCandidates(media, origin);
  const first6 = ranked.slice(0, 6).map((c) => `${c.media.label}#${c.frame.idx}`);
  assert.deepEqual(first6, ["M7#0", "M1#0", "M4#0", "M5#0", "M6#0", "M2#0"]);
  assert.ok(!ranked.some((c) => c.media.source === "demo"));
  // Después del primer cuadro de cada medio vienen los segundos key_frames, alternando.
  assert.equal(new Set(ranked.slice(0, 7).map((c) => c.media.id)).size, 7, "un cuadro por medio antes de repetir");
  assert.equal(ranked.length, 14);

  assert.equal(viewpointBearing(media[0], origin), 180, "rumbo 0 → cámara al sur");
  assert.ok(Math.abs((viewpointBearing(media[4], origin) ?? -1) - 0) < 1e-6, "GPS al norte");
  assert.equal(viewpointBearing(media[5], origin), null);
});

test("processMedia: omite fotogramas SVG; si solo hay SVG y nota, analiza la nota", async () => {
  const ctx = setup();
  const m = addMediaWithFrames(ctx, "m1", 1, [1]);
  const svg = frame("m1", 0, "svg");
  ctx.files.blobs.set(svg.storage_path, { bytes: SVG, contentType: "image/svg+xml" });
  m.frames.unshift(svg);
  await ctx.pipeline.processMedia("m1");
  assert.deepEqual(ctx.engine.calls.media[0].frames.map((f) => f.idx), [1]);

  addMediaWithFrames(ctx, "m2", 2, [0, 1], { reporter_note: "hay gente adentro" }, "svg");
  await ctx.pipeline.processMedia("m2");
  assert.equal(ctx.engine.calls.media[1].frames.length, 0);
  assert.equal(ctx.store.media.get("m2")!.status, "analyzed");

  assert.equal(resolveImageType(SVG, "image/svg+xml"), null);
  assert.equal(resolveImageType(JPEG, "application/octet-stream"), "image/jpeg");
});

test("processMedia: sin fotogramas usa la extracción del servidor", async () => {
  const ctx = setup({
    extractFrames: async (media: Media): Promise<MediaFrame[]> => {
      const f = frame(media.id, 0);
      ctx.files.blobs.set(f.storage_path, { bytes: JPEG, contentType: "image/jpeg" });
      return ctx.store.addFrames(media.id, [{ ...f }]);
    },
  });
  ctx.store.media.set("m1", makeMedia("m1", 1, { video_path: "incidents/x/video.mp4", video_status: "uploaded" }));
  await ctx.pipeline.processMedia("m1");
  assert.equal(ctx.engine.calls.media[0].frames.length, 1);
  assert.equal(ctx.store.media.get("m1")!.status, "analyzed");
});

test("processMedia: extracción falla y no hay nota → medio fallido", async () => {
  const ctx = setup();
  ctx.store.media.set("m1", makeMedia("m1", 1, { video_path: "v.mp4", video_status: "uploaded" }));
  await ctx.pipeline.processMedia("m1");
  const m = ctx.store.media.get("m1")!;
  assert.equal(m.status, "failed");
  assert.match(m.error ?? "", /sin ffmpeg/);
  assert.equal(ctx.engine.calls.media.length, 0);
});

test("processMedia: falla del motor → failed + evento, sin respaldo por reglas", async () => {
  const engine = fakeEngine("claude", {
    analyzeMedia: async () => {
      throw new Error("El modelo no respondió a tiempo.");
    },
  });
  const ctx = setup({ engine });
  addMediaWithFrames(ctx, "m1", 1, [0]);
  await ctx.pipeline.processMedia("m1");
  const m = ctx.store.media.get("m1")!;
  assert.equal(m.status, "failed");
  assert.match(m.error ?? "", /El modelo no respondió a tiempo/);
  assert.equal(m.analysis, null);
  assert.equal(ctx.fallback.calls.media.length, 0);
  const failed = ctx.store.events.filter((e) => e.kind === "media_failed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0].media_id, "m1");
});

test("requestFusion: si Claude falla, cae al motor de reglas y lo deja dicho", async () => {
  const engine = fakeEngine("claude", {
    fuseSituation: async () => {
      throw new Error("Servicio sobrecargado.");
    },
    fuseScene: async () => {
      throw new Error("Servicio sobrecargado.");
    },
  });
  const ctx = setup({ engine });
  addMediaWithFrames(ctx, "m1", 1, [0], { analysis: makeAnalysis(), analysis_engine: "claude", status: "analyzed" });
  await ctx.pipeline.requestFusion(INC);

  const inc = ctx.store.incidents.get(INC)!;
  assert.equal(inc.situation_engine, "simulated");
  assert.equal(inc.scene_engine, "simulated");
  assert.ok(inc.situation);
  assert.equal(inc.scene?.description, "Casa al norte de la calle [saneada]");
  assert.equal(ctx.sanitizeCalls(), 1);
  assert.equal(ctx.fallback.calls.situation.length, 1);
  assert.equal(ctx.fallback.calls.scene.length, 1);
  assert.match(inc.pipeline.fusion_error ?? "", /sobrecargado/);
  assert.equal(inc.pipeline.fusion_status, "idle");
  assert.ok(inc.pipeline.fusion_finished_at);

  const ruled = ctx.store.events.filter((e) => e.title.startsWith("Informe generado por reglas: el modelo no respondió"));
  assert.equal(ruled.length, 2);
  assert.ok(ruled.every((e) => /NO viene del modelo/.test(e.detail)));
  assert.equal(ctx.store.events.filter((e) => e.kind === "error").length, 2);
  assert.equal(ctx.store.locks.size, 0);
});

test("requestFusion: si también falla el respaldo queda en error", async () => {
  const boom = async (): Promise<never> => {
    throw new Error("falla");
  };
  const engine = fakeEngine("claude", { fuseSituation: boom });
  const ctx = setup({ engine });
  ctx.fallback.fuseSituation = boom;
  addMediaWithFrames(ctx, "m1", 1, [0], { analysis: makeAnalysis(), status: "analyzed" });
  await ctx.pipeline.requestFusion(INC);
  const inc = ctx.store.incidents.get(INC)!;
  assert.equal(inc.pipeline.fusion_status, "error");
  assert.equal(inc.situation, null);
  assert.equal(inc.scene_engine, "claude");
  assert.equal(ctx.store.locks.size, 0);
});

test("requestFusion: con el candado tomado no corre; el bucle repite si llega un pedido nuevo", async () => {
  const ctx = setup();
  addMediaWithFrames(ctx, "m1", 1, [0], { analysis: makeAnalysis(), status: "analyzed" });

  ctx.store.locks.add(`${INC}/fusion`);
  await ctx.pipeline.requestFusion(INC);
  assert.equal(ctx.engine.calls.situation.length, 0);
  let inc = ctx.store.incidents.get(INC)!;
  assert.equal(inc.pipeline.fusion_status, "pending");
  assert.ok(inc.pipeline.fusion_requested_at);
  ctx.store.locks.clear();

  let first = true;
  ctx.engine.fuseSituation = async (input) => {
    ctx.engine.calls.situation.push(input);
    if (first) {
      first = false;
      // Llega información nueva mientras corre la primera vuelta.
      await ctx.pipeline.requestFusion(INC);
    }
    return makeSituation();
  };
  await ctx.pipeline.requestFusion(INC);
  assert.equal(ctx.engine.calls.situation.length, 2);
  assert.equal(ctx.engine.calls.scene.length, 2);
  inc = ctx.store.incidents.get(INC)!;
  assert.equal(inc.pipeline.fusion_status, "idle");
  assert.equal(ctx.store.locks.size, 0);
});

test("requestFusion: contradicciones nuevas generan alerta una sola vez", async () => {
  const situation = makeSituation({
    contradictions: [{ description: "M1 muestra persona en ventana; C2 dice sin atrapados.", sources: ["M1", "C2"] }],
  });
  const engine = fakeEngine("claude", { fuseSituation: async () => situation });
  const ctx = setup({ engine });
  addMediaWithFrames(ctx, "m1", 1, [0], { analysis: makeAnalysis(), status: "analyzed" });
  await ctx.pipeline.requestFusion(INC);
  await ctx.pipeline.requestFusion(INC, { force: true });
  const c = ctx.store.events.filter((e) => e.kind === "alert" && e.title.startsWith("Contradicción"));
  assert.equal(c.length, 1);
  assert.equal(c[0].severity, "warning");
  assert.equal(c[0].title, "Contradicción entre fuentes: M1 · C2");
  const upd = ctx.store.events.filter((e) => e.kind === "situation_updated");
  assert.equal(upd.length, 2);
  assert.equal(upd[0].severity, "warning", "posible → warning");
});

test("fusión: fotogramas clave ≤ 6, nunca de demo, primero los medios con personas", async () => {
  const ctx = setup();
  const kf = (n: number) => Array.from({ length: n }, (_, i) => ({ frame: i, caption: `cuadro ${i}` }));
  addMediaWithFrames(ctx, "m1", 1, [0, 1, 2, 3], { analysis: makeAnalysis({ key_frames: kf(4) }), status: "analyzed" });
  addMediaWithFrames(ctx, "m2", 2, [0, 1, 2, 3], {
    analysis: makeAnalysis({
      key_frames: kf(4),
      people: [
        { status: "trapped", count: 1, location: "techo", floor: 2, frame_refs: [0], confidence: "high", description: "" },
      ],
    }),
    status: "analyzed",
  });
  addMediaWithFrames(ctx, "m3", 3, [0, 1, 2, 3], { analysis: makeAnalysis({ key_frames: kf(4) }), status: "analyzed" });
  addMediaWithFrames(ctx, "m4", 4, [0, 1, 2, 3], { source: "demo", analysis: makeAnalysis({ key_frames: kf(4) }), status: "analyzed" });

  await ctx.pipeline.requestFusion(INC);
  const input = ctx.engine.calls.situation[0];
  assert.equal(input.keyFrames.length, 6);
  assert.ok(input.keyFrames.every((k) => k.media_label !== "M4"));
  assert.equal(input.keyFrames[0].media_label, "M2");
  assert.equal(input.keyFrames[0].caption, "cuadro 0");
  assert.deepEqual(input.media.map((m) => m.media.label), ["M1", "M2", "M3", "M4"]);
  assert.ok(!ctx.files.downloads.some((p) => p.includes("/m4/")));

  const fm: FusionMedia[] = input.media;
  assert.ok(rankKeyFrameCandidates(fm).every((c) => c.media.source !== "demo"));
});

test("requestCommsAnalysis: MAYDAY y víctimas reportadas generan alerta crítica una vez", async () => {
  const analysis = makeCommsAnalysis({
    events: [{ entry_seq: 2, kind: "mayday", text: "Mayday B-3", priority: "critical" }],
    mayday: { active: true, detail: "Bombero de B-3 atrapado en 2º piso" },
    victims: { status: "reported", detail: "Vecina informa niño en el 2º piso", entry_seqs: [1] },
  });
  const engine = fakeEngine("claude", { analyzeComms: async () => analysis });
  const ctx = setup({ engine });
  const comm = (seq: number, text: string): CommEntry => ({
    id: `c${seq}`,
    incident_id: INC,
    seq,
    at: "2026-11-21T11:30:00.000Z",
    channel: "",
    speaker: "B-3",
    text,
    source: "manual",
    audio_path: null,
    created_at: "2026-11-21T11:30:00.000Z",
  });
  ctx.store.comms.push(comm(1, "Central, vecina informa niño en el segundo piso"), comm(2, "Mayday mayday, B-3"));

  await ctx.pipeline.requestCommsAnalysis(INC);
  const inc = ctx.store.incidents.get(INC)!;
  assert.deepEqual(inc.comms_analysis, analysis);
  assert.equal(inc.comms_engine, "claude");
  assert.equal(inc.pipeline.comms_status, "idle");
  const alerts = ctx.store.events.filter((e) => e.kind === "comms_alert");
  assert.equal(alerts.length, 2);
  const mayday = alerts.find((e) => e.title.startsWith("MAYDAY — "));
  assert.ok(mayday);
  assert.equal(mayday.severity, "critical");
  assert.equal(mayday.comm_id, "c2");
  const victims = alerts.find((e) => e.title.startsWith("Radio: se informan víctimas"));
  assert.equal(victims?.severity, "critical");
  assert.equal(victims?.comm_id, "c1");
  // Luego pidió la fusión con el análisis de radio.
  assert.equal(engine.calls.situation.length, 1);
  assert.deepEqual(engine.calls.situation[0].commsAnalysis, analysis);

  await ctx.pipeline.requestCommsAnalysis(INC);
  assert.equal(ctx.store.events.filter((e) => e.kind === "comms_alert").length, 2);
  assert.equal(ctx.store.locks.size, 0);
});

test("requestCommsAnalysis: si Claude falla usa reglas y lo dice", async () => {
  const engine = fakeEngine("claude", {
    analyzeComms: async () => {
      throw new Error("Sin conexión con el modelo.");
    },
  });
  const ctx = setup({ engine });
  ctx.store.comms.push({
    id: "c1",
    incident_id: INC,
    seq: 1,
    at: "2026-11-21T11:30:00.000Z",
    channel: "",
    speaker: "B-3",
    text: "B-3 en el lugar",
    source: "manual",
    audio_path: null,
    created_at: "2026-11-21T11:30:00.000Z",
  });
  await ctx.pipeline.requestCommsAnalysis(INC);
  const inc = ctx.store.incidents.get(INC)!;
  assert.equal(inc.comms_engine, "simulated");
  assert.match(inc.pipeline.comms_error ?? "", /Sin conexión/);
  assert.equal(inc.pipeline.comms_status, "idle");
  assert.ok(ctx.store.events.some((e) => e.title === "Análisis de radio generado por reglas: el modelo no respondió"));
});

test("las funciones nunca lanzan aunque el store falle", async () => {
  const ctx = setup();
  const broken = async (): Promise<never> => {
    throw new Error("store caído");
  };
  ctx.store.getMedia = broken;
  ctx.store.getIncident = broken;
  await ctx.pipeline.processMedia("m1");
  await ctx.pipeline.requestFusion(INC);
  await ctx.pipeline.requestCommsAnalysis(INC);
});

test("funciones de nivel superior nunca lanzan", async () => {
  process.env.VIGIA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vigia-pipeline-"));
  const mod = await import("./pipeline");
  await mod.processMedia("no-existe");
  await mod.requestFusion("no-existe");
  await mod.requestCommsAnalysis("no-existe");
});

const radioLine = (seq: number, text: string): CommEntry => ({
  id: `c${seq}`,
  incident_id: INC,
  seq,
  at: "2026-11-21T11:30:00.000Z",
  channel: "",
  speaker: "B-3",
  text,
  source: "manual",
  audio_path: null,
  created_at: "2026-11-21T11:30:00.000Z",
});

test("«Vigía sin IA» en la emergencia: la fusión y la radio van directo por reglas, sin esperar al modelo", async () => {
  const ctx = setup({ rulesOnly: async (id) => id === INC });
  addMediaWithFrames(ctx, "m1", 1, [0], { analysis: makeAnalysis(), status: "analyzed" });
  ctx.store.comms.push(radioLine(1, "Central, B-3 en el lugar"));
  await ctx.pipeline.requestFusion(INC);
  await ctx.pipeline.requestCommsAnalysis(INC);
  assert.equal(ctx.engine.calls.situation.length, 0, "no llama al modelo");
  assert.equal(ctx.engine.calls.scene.length, 0);
  assert.equal(ctx.engine.calls.comms.length, 0);
  // La radio vuelve a pedir la fusión al guardar su análisis: el respaldo puede correr más de una vez.
  assert.ok(ctx.fallback.calls.situation.length >= 1);
  assert.equal(ctx.fallback.calls.comms.length, 1);
  const inc = ctx.store.incidents.get(INC)!;
  assert.equal(inc.situation_engine, "simulated");
  assert.equal(inc.scene_engine, "simulated");
  assert.equal(inc.comms_engine, "simulated");
  // Si no se puede saber (error al leer la memoria de Vigía), se usa el modelo como siempre.
  const other = setup({ rulesOnly: async () => { throw new Error("sin store"); } });
  addMediaWithFrames(other, "m1", 1, [0], { analysis: makeAnalysis(), status: "analyzed" });
  await other.pipeline.requestFusion(INC);
  assert.equal(other.engine.calls.situation.length, 1);
});
