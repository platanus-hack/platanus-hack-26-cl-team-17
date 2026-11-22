import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AccessPointKindSchema,
  AnalysisEngineSchema,
  CardinalSchema,
  CommEventKindSchema,
  CommsAnalysisAISchema,
  ConfidenceSchema,
  ConstructionSchema,
  DamageSchema,
  FireStageSchema,
  HazardKindSchema,
  HazardSeveritySchema,
  IncidentStatusSchema,
  IncidentTypeSchema,
  InsightCategorySchema,
  LikelihoodSchema,
  MediaAnalysisAISchema,
  PersonStatusSchema,
  PrioritySchema,
  SceneModelAISchema,
  SeveritySchema,
  SmokeColorSchema,
  SmokeVolumeSchema,
  StructureKindSchema,
  StructureSideSchema,
  TrappedStatusSchema,
  UnitStatusSchema,
  VehicleKindSchema,
  VehicleStateSchema,
  type CommSource,
  type Incident,
  type Media,
  type MediaKind,
  type MediaSource,
  type MediaStatus,
  type MissionMode,
  type MissionPattern,
  type MissionStatus,
  type PipelineStatus,
  type TimelineKind,
  type TimelineSeverity,
  type DroneMission,
} from "@/lib/domain";
import type { MissionCommandRequest, RuntimeMode, StaffRole } from "@/lib/contract";
import * as labels from "@/lib/labels";

const TONES = new Set(["neutral", "accent", "critical", "warning", "ok", "info", "drone"]);

/**
 * Lista todos los valores de una unión de strings; no compila si falta alguno.
 * Sirve para las uniones TS que no tienen esquema zod.
 */
function allOf<T extends string>() {
  return <const A extends readonly T[]>(
    values: A & ([T] extends [A[number]] ? unknown : "falta un valor de la unión"),
  ): readonly string[] => values;
}

function assertKeys(name: string, map: Record<string, unknown>, values: readonly string[]) {
  assert.deepEqual(
    Object.keys(map).sort(),
    [...values].sort(),
    `${name}: las claves no coinciden con los valores del enum`,
  );
}

function assertLabels(name: string, map: Record<string, string>, values: readonly string[]) {
  assertKeys(name, map, values);
  for (const v of values) {
    const label = map[v];
    assert.equal(typeof label, "string", `${name}.${v} no es texto`);
    assert.ok(label.trim().length > 0, `${name}.${v} está vacío`);
  }
}

function assertTones(name: string, map: Record<string, string>, values: readonly string[]) {
  assertKeys(name, map, values);
  for (const v of values) assert.ok(TONES.has(map[v]), `${name}.${v} = "${map[v]}" no es un Tone`);
}

function assertIcons(name: string, map: Record<string, unknown>, values: readonly string[]) {
  assertKeys(name, map, values);
  for (const v of values) {
    const icon = map[v];
    // Los íconos de lucide son componentes forwardRef (objeto) o funciones.
    assert.ok(
      icon != null && (typeof icon === "object" || typeof icon === "function"),
      `${name}.${v} no es un ícono válido`,
    );
  }
}

const mediaViewpoint = MediaAnalysisAISchema.shape.viewpoint.shape;
const mediaFire = MediaAnalysisAISchema.shape.fire.shape;
const mediaVehicle = MediaAnalysisAISchema.shape.vehicles.element.shape;
const commsEvent = CommsAnalysisAISchema.shape.events.element.shape;
const commsVictims = CommsAnalysisAISchema.shape.victims.shape;
const sceneStructure = SceneModelAISchema.shape.structures.element.shape;
const sceneFireZone = SceneModelAISchema.shape.fire_zones.element.shape;

const zodLabelMaps: [string, Record<string, string>, readonly string[]][] = [
  ["incidentTypeLabel", labels.incidentTypeLabel, IncidentTypeSchema.options],
  ["incidentStatusLabel", labels.incidentStatusLabel, IncidentStatusSchema.options],
  ["trappedStatusLabel", labels.trappedStatusLabel, TrappedStatusSchema.options],
  ["trappedStatusShort", labels.trappedStatusShort, TrappedStatusSchema.options],
  ["trappedStatusHeadline", labels.trappedStatusHeadline, TrappedStatusSchema.options],
  ["likelihoodLabel", labels.likelihoodLabel, LikelihoodSchema.options],
  ["severityLabel", labels.severityLabel, SeveritySchema.options],
  ["priorityLabel", labels.priorityLabel, PrioritySchema.options],
  ["confidenceLabel", labels.confidenceLabel, ConfidenceSchema.options],
  ["confidenceLongLabel", labels.confidenceLongLabel, ConfidenceSchema.options],
  ["structureKindLabel", labels.structureKindLabel, StructureKindSchema.options],
  ["constructionLabel", labels.constructionLabel, ConstructionSchema.options],
  ["fireStageLabel", labels.fireStageLabel, FireStageSchema.options],
  ["structureSideLabel", labels.structureSideLabel, StructureSideSchema.options],
  ["structureSideShort", labels.structureSideShort, StructureSideSchema.options],
  ["smokeColorLabel", labels.smokeColorLabel, SmokeColorSchema.options],
  ["smokeVolumeLabel", labels.smokeVolumeLabel, SmokeVolumeSchema.options],
  ["personStatusLabel", labels.personStatusLabel, PersonStatusSchema.options],
  ["vehicleKindLabel", labels.vehicleKindLabel, VehicleKindSchema.options],
  ["vehicleStateLabel", labels.vehicleStateLabel, VehicleStateSchema.options],
  ["damageLabel", labels.damageLabel, DamageSchema.options],
  ["hazardKindLabel", labels.hazardKindLabel, HazardKindSchema.options],
  ["hazardSeverityLabel", labels.hazardSeverityLabel, HazardSeveritySchema.options],
  ["unitStatusLabel", labels.unitStatusLabel, UnitStatusSchema.options],
  ["commEventKindLabel", labels.commEventKindLabel, CommEventKindSchema.options],
  ["insightCategoryLabel", labels.insightCategoryLabel, InsightCategorySchema.options],
  ["accessPointKindLabel", labels.accessPointKindLabel, AccessPointKindSchema.options],
  ["cardinalLabel", labels.cardinalLabel, CardinalSchema.options],
  ["cardinalShort", labels.cardinalShort, CardinalSchema.options],
  ["analysisEngineLabel", labels.analysisEngineLabel, AnalysisEngineSchema.options],
  ["elevationLabel", labels.elevationLabel, mediaViewpoint.elevation.options],
  ["spreadRiskLabel", labels.spreadRiskLabel, mediaFire.spread_risk.options],
  ["occupantsVisibleLabel", labels.occupantsVisibleLabel, mediaVehicle.occupants_visible.options],
  ["commPriorityLabel", labels.commPriorityLabel, commsEvent.priority.options],
  ["commsVictimsStatusLabel", labels.commsVictimsStatusLabel, commsVictims.status.options],
  ["sceneRoleLabel", labels.sceneRoleLabel, sceneStructure.role.options],
  ["roofLabel", labels.roofLabel, sceneStructure.roof.options],
  ["fireIntensityLabel", labels.fireIntensityLabel, sceneFireZone.intensity.options],
];

const MEDIA_SOURCES = allOf<MediaSource>()(["citizen", "drone", "responder"]);
const MEDIA_KINDS = allOf<MediaKind>()(["video", "photo", "frames"]);
const MEDIA_STATUSES = allOf<MediaStatus>()([
  "uploading",
  "uploaded",
  "analyzing",
  "analyzed",
  "failed",
]);
const VIDEO_STATUSES = allOf<Media["video_status"]>()(["none", "uploading", "uploaded", "failed"]);
const COMM_SOURCES = allOf<CommSource>()(["manual", "dictation", "import", "zello"]);
const MISSION_STATUSES = allOf<MissionStatus>()([
  "planned",
  "launching",
  "en_route",
  "on_station",
  "returning",
  "landed",
  "aborted",
]);
const MISSION_PATTERNS = allOf<MissionPattern>()(["orbit", "hover", "grid"]);
const MISSION_MODES = allOf<MissionMode>()(["device", "api"]);
const MISSION_COMMANDS = allOf<DroneMission["command"]>()(["continue", "recall", "abort"]);
const MISSION_ACTIONS = allOf<MissionCommandRequest["action"]>()(["recall", "abort", "resume"]);
const TIMELINE_KINDS = allOf<TimelineKind>()([
  "incident_created",
  "incident_updated",
  "media_received",
  "media_analyzed",
  "media_failed",
  "alert",
  "situation_updated",
  "scene_updated",
  "comms",
  "comms_alert",
  "drone",
  "error",
]);
const TIMELINE_SEVERITIES = allOf<TimelineSeverity>()(["info", "notice", "warning", "critical"]);
const PIPELINE_STATUSES = allOf<PipelineStatus>()(["idle", "pending", "running", "error"]);
const STAFF_ROLES = allOf<StaffRole>()(["admin", "officer", "operator"]);
const ORIGINS = allOf<Incident["origin"]>()(["command", "citizen"]);
const STORES = allOf<RuntimeMode["store"]>()(["postgres", "local"]);
const FILES = allOf<RuntimeMode["files"]>()(["gcs", "local"]);
const AUTHS = allOf<RuntimeMode["auth"]>()(["staff", "open"]);

const unionLabelMaps: [string, Record<string, string>, readonly string[]][] = [
  ["mediaSourceLabel", labels.mediaSourceLabel, MEDIA_SOURCES],
  ["mediaKindLabel", labels.mediaKindLabel, MEDIA_KINDS],
  ["mediaStatusLabel", labels.mediaStatusLabel, MEDIA_STATUSES],
  ["videoStatusLabel", labels.videoStatusLabel, VIDEO_STATUSES],
  ["commSourceLabel", labels.commSourceLabel, COMM_SOURCES],
  ["missionStatusLabel", labels.missionStatusLabel, MISSION_STATUSES],
  ["missionPatternLabel", labels.missionPatternLabel, MISSION_PATTERNS],
  ["missionModeLabel", labels.missionModeLabel, MISSION_MODES],
  ["missionCommandLabel", labels.missionCommandLabel, MISSION_COMMANDS],
  ["missionActionLabel", labels.missionActionLabel, MISSION_ACTIONS],
  ["timelineKindLabel", labels.timelineKindLabel, TIMELINE_KINDS],
  ["timelineSeverityLabel", labels.timelineSeverityLabel, TIMELINE_SEVERITIES],
  ["pipelineStatusLabel", labels.pipelineStatusLabel, PIPELINE_STATUSES],
  ["staffRoleLabel", labels.staffRoleLabel, STAFF_ROLES],
  ["incidentOriginLabel", labels.incidentOriginLabel, ORIGINS],
  ["runtimeStoreLabel", labels.runtimeStoreLabel, STORES],
  ["runtimeFilesLabel", labels.runtimeFilesLabel, FILES],
  ["runtimeAuthLabel", labels.runtimeAuthLabel, AUTHS],
];

const toneMaps: [string, Record<string, string>, readonly string[]][] = [
  ["trappedTone", labels.trappedTone, TrappedStatusSchema.options],
  ["likelihoodTone", labels.likelihoodTone, LikelihoodSchema.options],
  ["severityTone", labels.severityTone, SeveritySchema.options],
  ["priorityTone", labels.priorityTone, PrioritySchema.options],
  ["confidenceTone", labels.confidenceTone, ConfidenceSchema.options],
  ["hazardSeverityTone", labels.hazardSeverityTone, HazardSeveritySchema.options],
  ["incidentStatusTone", labels.incidentStatusTone, IncidentStatusSchema.options],
  ["personStatusTone", labels.personStatusTone, PersonStatusSchema.options],
  ["unitStatusTone", labels.unitStatusTone, UnitStatusSchema.options],
  ["spreadRiskTone", labels.spreadRiskTone, mediaFire.spread_risk.options],
  ["fireIntensityTone", labels.fireIntensityTone, sceneFireZone.intensity.options],
  ["commPriorityTone", labels.commPriorityTone, commsEvent.priority.options],
  ["commsVictimsStatusTone", labels.commsVictimsStatusTone, commsVictims.status.options],
  ["analysisEngineTone", labels.analysisEngineTone, AnalysisEngineSchema.options],
  ["missionStatusTone", labels.missionStatusTone, MISSION_STATUSES],
  ["mediaStatusTone", labels.mediaStatusTone, MEDIA_STATUSES],
  ["timelineSeverityTone", labels.timelineSeverityTone, TIMELINE_SEVERITIES],
  ["pipelineStatusTone", labels.pipelineStatusTone, PIPELINE_STATUSES],
];

const iconMaps: [string, Record<string, unknown>, readonly string[]][] = [
  ["incidentTypeIcon", labels.incidentTypeIcon, IncidentTypeSchema.options],
  ["hazardKindIcon", labels.hazardKindIcon, HazardKindSchema.options],
  ["mediaSourceIcon", labels.mediaSourceIcon, MEDIA_SOURCES],
  ["timelineKindIcon", labels.timelineKindIcon, TIMELINE_KINDS],
  ["insightCategoryIcon", labels.insightCategoryIcon, InsightCategorySchema.options],
  ["accessPointKindIcon", labels.accessPointKindIcon, AccessPointKindSchema.options],
  ["commEventKindIcon", labels.commEventKindIcon, CommEventKindSchema.options],
  ["missionStatusIcon", labels.missionStatusIcon, MISSION_STATUSES],
];

test("etiquetas exhaustivas para cada enum zod (incluidos los anidados)", () => {
  for (const [name, map, values] of zodLabelMaps) assertLabels(name, map, values);
});

test("etiquetas exhaustivas para las uniones TS", () => {
  for (const [name, map, values] of unionLabelMaps) assertLabels(name, map, values);
});

test("mapas de tono exhaustivos y con tonos válidos", () => {
  for (const [name, map, values] of toneMaps) assertTones(name, map, values);
});

test("mapas de íconos exhaustivos y con componentes válidos", () => {
  for (const [name, map, values] of iconMaps) assertIcons(name, map, values);
});

test("atrapados: textos exactos exigidos por el mando", () => {
  assert.deepEqual(labels.trappedStatusLabel, {
    confirmed: "CONFIRMADO",
    probable: "PROBABLE",
    possible: "POSIBLE",
    no_evidence: "SIN EVIDENCIA (no descarta)",
    cleared_by_unit: "DESCARTADO POR UNIDAD EN EL LUGAR",
  });
  assert.equal(labels.trappedStatusHeadline.confirmed, "Personas atrapadas: CONFIRMADO");
  assert.equal(labels.trappedStatusShort.no_evidence, "SIN EVIDENCIA");
});

test("atrapados: la falta de evidencia nunca se ve segura", () => {
  assert.equal(labels.trappedTone.confirmed, "critical");
  assert.equal(labels.trappedTone.probable, "critical");
  assert.equal(labels.trappedTone.possible, "warning");
  assert.equal(labels.trappedTone.cleared_by_unit, "ok");
  assert.notEqual(labels.trappedTone.no_evidence, "ok");
  assert.notEqual(labels.likelihoodTone.no_evidence, "ok");
  for (const v of TrappedStatusSchema.options) {
    if (v !== "cleared_by_unit") assert.notEqual(labels.trappedTone[v], "ok", v);
  }
  assert.match(labels.trappedStatusLabel.no_evidence, /no descarta/);
});

test("confianza: tonos pedidos", () => {
  assert.deepEqual(labels.confidenceTone, { low: "warning", medium: "info", high: "ok" });
});

test("isTrappedAlarm", () => {
  assert.equal(labels.isTrappedAlarm("confirmed"), true);
  assert.equal(labels.isTrappedAlarm("probable"), true);
  assert.equal(labels.isTrappedAlarm("possible"), false);
  assert.equal(labels.isTrappedAlarm("no_evidence"), false);
  assert.equal(labels.isTrappedAlarm("cleared_by_unit"), false);
  assert.equal(labels.isTrappedAlarm(null), false);
  assert.equal(labels.isTrappedAlarm(undefined), false);
});

test("severityRank", () => {
  assert.equal(labels.severityRank("critical"), 3);
  assert.equal(labels.severityRank("high"), 2);
  assert.equal(labels.severityRank("moderate"), 1);
  assert.equal(labels.severityRank("low"), 0);
  assert.equal(labels.severityRank(null), -1);
  assert.equal(labels.severityRank(undefined), -1);
  const sorted = [...SeveritySchema.options].sort(
    (a, b) => labels.severityRank(b) - labels.severityRank(a),
  );
  assert.deepEqual(sorted, ["critical", "high", "moderate", "low"]);
});

test("trappedRank: sin dato no ordena como seguro", () => {
  assert.equal(labels.trappedRank("confirmed"), 4);
  assert.equal(labels.trappedRank("probable"), 3);
  assert.equal(labels.trappedRank("possible"), 2);
  assert.equal(labels.trappedRank("no_evidence"), 1);
  assert.equal(labels.trappedRank("cleared_by_unit"), 0);
  assert.equal(labels.trappedRank(null), 1);
  assert.equal(labels.trappedRank(undefined), 1);
  assert.ok(labels.trappedRank(null) > labels.trappedRank("cleared_by_unit"));
});

test("labelOr: valores ausentes o desconocidos usan el respaldo", () => {
  assert.equal(labels.labelOr(labels.severityLabel, "high"), "Alta");
  assert.equal(labels.labelOr(labels.severityLabel, null), "—");
  assert.equal(labels.labelOr(labels.severityLabel, undefined, "Sin dato"), "Sin dato");
  // Datos externos (IA, versiones antiguas) pueden traer valores fuera del enum.
  const unknownValue = "extreme" as unknown as "high";
  assert.equal(labels.labelOr(labels.severityLabel, unknownValue), "—");
  const inherited = "toString" as unknown as "high";
  assert.equal(labels.labelOr(labels.severityLabel, inherited), "—");
});

test("lados de la estructura siguen la convención A/B/C/D", () => {
  assert.match(labels.structureSideLabel.front, /^Lado A/);
  assert.match(labels.structureSideLabel.left, /^Lado B/);
  assert.match(labels.structureSideLabel.rear, /^Lado C/);
  assert.match(labels.structureSideLabel.right, /^Lado D/);
});
