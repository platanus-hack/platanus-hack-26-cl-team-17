/**
 * Simulacro en vivo: ejecuta un paso del guion sobre el incidente del simulacro
 * usando el pipeline real. Cada paso es idempotente: si se reintenta, detecta lo
 * que ya creó (texto de radio, nota del medio, misión, título de evento) y no duplica.
 */
import type { ScenarioStepResponse } from "@/lib/contract";
import type { Incident, Media } from "@/lib/domain";
import { deployedTitle, planMission } from "@/lib/drone/plan";
import { secondsUntilOnStation } from "@/lib/drone/sim";
import { destination } from "@/lib/geo";
import { errors } from "@/lib/http";
import { newToken, sha256Hex } from "@/lib/ids";
import { insertDemoMedia } from "./media";
import { commEventTitle, DEMO_NOTICE, mediaReceivedTitle } from "./seed";
import type { DemoDeps, ScenarioMediaSpec, ScenarioScript } from "./types";

/** Un paso 0 repetido dentro de esta ventana reutiliza el simulacro recién creado. */
const RESTART_DEDUP_MS = 90_000;
/** El dron del simulacro despega desde el puesto de mando, cerca del incidente (no a 300 m). */
const DRILL_HOME_DISTANCE_M = 120;
const DRILL_HOME_BEARING_DEG = 200;
/** Antes del lote del dron se espera, como máximo, esto a que el dron simulado llegue a su órbita. */
const MAX_DRONE_WAIT_S = 20;
/** Margen por el intervalo del tick del mando (~2 s) y la red. */
const TICK_MARGIN_S = 3;

const STATUS_TEXT: Record<Incident["status"], string> = {
  active: "activo",
  controlled: "controlado",
  closed: "cerrado",
};

async function findFreshDrill(deps: DemoDeps, script: ScenarioScript): Promise<Incident | null> {
  const candidates = (await deps.store.listIncidents({ status: ["active"] })).filter(
    (i) =>
      i.origin === "demo" &&
      i.title === script.incident.title &&
      deps.now() - Date.parse(i.created_at) < RESTART_DEDUP_MS,
  );
  if (candidates.length === 0) return null;
  const counts = await deps.store.getIncidentCounts(candidates.map((i) => i.id));
  return candidates.find((i) => (counts[i.id]?.media ?? 0) === 0 && (counts[i.id]?.comms ?? 0) === 0) ?? null;
}

async function createDrill(deps: DemoDeps, script: ScenarioScript): Promise<Incident> {
  const inc = script.incident;
  const incident = await deps.store.createIncident({
    type: inc.type,
    title: inc.title,
    address: inc.address,
    lat: inc.lat,
    lng: inc.lng,
    description: `${inc.description}\n\nSIMULACRO — ${DEMO_NOTICE}`,
    origin: "demo",
    verified: true,
    status: "active",
  });
  await deps.store.addEvent({
    incident_id: incident.id,
    kind: "incident_created",
    severity: "info",
    title: `Simulacro iniciado — ${inc.address}`,
    detail: DEMO_NOTICE,
  });
  return incident;
}

async function loadDrill(deps: DemoDeps, incidentId: string): Promise<Incident> {
  const incident = await deps.store.getIncident(incidentId);
  if (!incident) throw errors.notFound("El simulacro no existe.");
  if (incident.origin !== "demo") throw errors.invalid("Ese incidente no es un simulacro.");
  return incident;
}

async function ensureMedia(
  deps: DemoDeps,
  incident: Incident,
  spec: ScenarioMediaSpec,
  missionId: string | null,
  missionLabel: string | null,
): Promise<Media> {
  const all = await deps.store.listMedia(incident.id);
  const existing =
    all.find((m) =>
      spec.source === "drone"
        ? m.source === "drone" && m.mission_id === missionId && m.reporter_note === spec.reporter_note
        : m.source === spec.source && m.reporter_note === spec.reporter_note,
    ) ?? null;
  const now = deps.now();
  const media = await insertDemoMedia(
    deps,
    incident,
    { ...spec, captured_at_s: 0, received_at_s: 0, analyzed_at_s: 0 },
    { capturedAtMs: now - spec.captured_ago_s * 1000, analyzedAtMs: now, missionId, finalStatus: "uploaded" },
    existing,
  );
  if (!existing) {
    await deps.store.addEvent({
      incident_id: incident.id,
      kind: "media_received",
      severity: "info",
      title: mediaReceivedTitle(media, missionLabel),
      detail: spec.reporter_note || spec.analysis.viewpoint.position_description,
      media_id: media.id,
      mission_id: missionId,
    });
  }
  return media;
}

export async function runScenarioStepWith(
  deps: DemoDeps,
  script: ScenarioScript,
  incidentId: string | null,
  step: number,
): Promise<ScenarioStepResponse> {
  const total = script.steps.length;
  if (!Number.isInteger(step) || step < 0 || step >= total) {
    throw errors.invalid(`Paso de simulacro fuera de rango (0 a ${total - 1}).`);
  }
  let incident: Incident;
  if (incidentId === null) {
    if (step !== 0) throw errors.invalid("Para iniciar un simulacro pide el paso 0.");
    incident = (await findFreshDrill(deps, script)) ?? (await createDrill(deps, script));
  } else {
    incident = await loadDrill(deps, incidentId);
  }

  const { store } = deps;
  const spec = script.steps[step];
  const toProcess: string[] = [];
  let commsAdded = false;

  if (spec.comms?.length) {
    const existing = new Set((await store.listComms(incident.id)).map((c) => c.text));
    for (const c of spec.comms) {
      if (existing.has(c.text)) continue;
      const entry = await store.addComm({
        incident_id: incident.id,
        text: c.text,
        speaker: c.speaker,
        channel: c.channel,
        source: "simulated",
      });
      await store.addEvent({
        incident_id: incident.id,
        at: entry.at,
        kind: "comms",
        severity: "info",
        title: commEventTitle(c.speaker, c.text),
        detail: c.channel ? `Canal ${c.channel} · C${entry.seq}` : `C${entry.seq}`,
        comm_id: entry.id,
      });
      commsAdded = true;
    }
  }

  let missions = await store.listMissions(incident.id);
  if (spec.mission && missions.length === 0) {
    const center = { lat: incident.lat, lng: incident.lng };
    const home = destination(center, DRILL_HOME_BEARING_DEG, DRILL_HOME_DISTANCE_M);
    const plan = planMission(center, { mode: "simulated", ...spec.mission, home_lat: home.lat, home_lng: home.lng });
    const mission = await store.createMission({
      incident_id: incident.id,
      mode: "simulated",
      ...plan,
      ingest_token_hash: sha256Hex(newToken()),
    });
    await store.addEvent({
      incident_id: incident.id,
      kind: "drone",
      severity: "info",
      title: deployedTitle(mission),
      detail: "Misión simulada: telemetría generada por la plataforma, sin cámara real.",
      mission_id: mission.id,
    });
    missions = [mission];
  }

  if (spec.media) {
    const m = await ensureMedia(deps, incident, spec.media, null, null);
    if (m.status === "uploaded") toProcess.push(m.id);
  }
  if (spec.drone_media) {
    const mission = missions[0];
    if (!mission) throw errors.conflict("El guion pide un lote de dron sin misión desplegada.");
    const m = await ensureMedia(deps, incident, spec.drone_media, mission.id, mission.label);
    const fromDrone = (await store.listMedia(incident.id))
      .filter((x) => x.mission_id === mission.id)
      .reduce((n, x) => n + x.frames.length, 0);
    if (fromDrone !== mission.frames_received) {
      await store.updateMission(mission.id, { frames_received: fromDrone });
    }
    if (m.status === "uploaded") toProcess.push(m.id);
  }

  if (spec.events?.length) {
    const titles = new Set((await store.listEvents(incident.id, 500)).map((e) => e.title));
    for (const e of spec.events) {
      if (titles.has(e.title)) continue;
      await store.addEvent({ incident_id: incident.id, ...e });
    }
  }

  if (spec.status && incident.status !== spec.status) {
    await store.updateIncident(incident.id, { status: spec.status });
    await store.addEvent({
      incident_id: incident.id,
      kind: "incident_updated",
      severity: "notice",
      title: `Estado del incidente: ${STATUS_TEXT[spec.status]}`,
      detail: "Cambio de estado del simulacro.",
    });
  }

  const pipeline = deps.pipeline;
  const id = incident.id;
  for (const mediaId of toProcess) deps.defer(() => pipeline.processMedia(mediaId));
  if (commsAdded) deps.defer(() => pipeline.requestCommsAnalysis(id));

  // Si el próximo paso trae cuadros del dron, se da tiempo a que el dron simulado llegue a su
  // órbita: así la vista aérea no aparece con el dron todavía en camino.
  let waitS = spec.wait_s;
  const nextSpec = script.steps[step + 1];
  const drone = missions[0];
  if (nextSpec?.drone_media && drone) {
    const fresh = (await store.getMission(drone.id)) ?? drone;
    const eta = secondsUntilOnStation(fresh, { lat: incident.lat, lng: incident.lng }, deps.now());
    if (eta !== null && eta > 0) waitS = Math.min(MAX_DRONE_WAIT_S, Math.max(waitS, Math.ceil(eta) + TICK_MARGIN_S));
  }

  const done = step === total - 1;
  return {
    incident_id: incident.id,
    done,
    next_step: step + 1,
    wait_s: waitS,
    label: spec.label,
    total_steps: total,
  };
}
