/**
 * Siembra de vitrinas: convierte un `ShowcaseSpec` (tiempos relativos) en datos del Store.
 */
import type { DroneMission, Incident, Media, TelemetryPoint } from "@/lib/domain";
import { deployedTitle, planMission } from "@/lib/drone/plan";
import { advance, type SimEvent } from "@/lib/drone/sim";
import { toLatLng } from "@/lib/geo";
import { newToken, sha256Hex } from "@/lib/ids";
import { insertDemoMedia } from "./media";
import type { DemoDeps, DemoMissionSpec, ShowcaseSpec } from "./types";

/** Aviso que acompaña a todo incidente de demostración. */
export const DEMO_NOTICE =
  "DATOS DE DEMOSTRACIÓN: incidente ficticio para conocer la plataforma. Imágenes, radio y análisis no son reales.";

const iso = (ms: number) => new Date(ms).toISOString();

/** Título del evento de radio, igual que la ruta de comunicaciones: "<emisor>: <inicio del texto>". */
export function commEventTitle(speaker: string, text: string): string {
  const head = text.length > 80 ? `${text.slice(0, 79).trimEnd()}…` : text;
  return speaker ? `${speaker}: ${head}` : head;
}

/** Simula el vuelo de la vitrina desde el despegue hasta `untilMs` con el mismo motor que el simulador en vivo. */
export function simulateShowcaseFlight(
  mission: DroneMission,
  center: { lat: number; lng: number },
  spec: DemoMissionSpec,
  startMs: number,
  untilMs: number,
): { mission: DroneMission; events: SimEvent[] } {
  const home = { lat: mission.home_lat, lng: mission.home_lng };
  const p0: TelemetryPoint = {
    at: iso(startMs),
    lat: home.lat,
    lng: home.lng,
    alt_m: 0,
    heading_deg: 0,
    speed_ms: 0,
    battery_pct: spec.battery_start_pct,
  };
  let m: DroneMission = {
    ...mission,
    status: "launching",
    started_at: iso(startMs),
    last: p0,
    track: [p0],
  };
  const events: SimEvent[] = [];
  for (let t = startMs + 2_000; t <= untilMs; t = Math.min(untilMs, t + 10_000)) {
    const r = advance(m, center, t);
    const last = r.points.length > 0 ? r.points[r.points.length - 1] : m.last;
    m = {
      ...m,
      status: r.status,
      started_at: r.started_at ?? m.started_at,
      ended_at: r.ended_at ?? m.ended_at,
      last,
      track: m.track.concat(r.points).slice(-300),
    };
    events.push(...r.events);
    if (m.status === "landed" || m.status === "aborted" || t === untilMs) break;
  }
  return { mission: m, events };
}

async function seedMission(
  deps: DemoDeps,
  incident: Incident,
  spec: DemoMissionSpec,
  t0: number,
): Promise<DroneMission> {
  const center = { lat: incident.lat, lng: incident.lng };
  const home = toLatLng(center, spec.home);
  const plan = planMission(center, {
    mode: "simulated",
    pattern: spec.pattern,
    radius_m: spec.radius_m,
    altitude_m: spec.altitude_m,
    speed_ms: spec.speed_ms,
    home_lat: home.lat,
    home_lng: home.lng,
  });
  const created = await deps.store.createMission({
    incident_id: incident.id,
    mode: "simulated",
    ...plan,
    // Nadie recibe este token: la misión de la vitrina solo avanza con el simulador.
    ingest_token_hash: sha256Hex(newToken()),
  });
  await deps.store.addEvent({
    incident_id: incident.id,
    at: iso(t0 + spec.created_at_s * 1000),
    kind: "drone",
    severity: "info",
    title: deployedTitle(created),
    detail: "Misión simulada: telemetría generada por la plataforma, sin cámara real.",
    mission_id: created.id,
  });
  const flight = simulateShowcaseFlight(created, center, spec, t0 + spec.started_at_s * 1000, deps.now());
  await deps.store.appendTelemetry(created.id, flight.mission.track);
  for (const e of flight.events) {
    await deps.store.addEvent({
      incident_id: incident.id,
      at: e.at,
      kind: "drone",
      severity: e.severity,
      title: e.title,
      detail: e.detail,
      mission_id: created.id,
    });
  }
  return deps.store.updateMission(created.id, {
    status: flight.mission.status,
    started_at: flight.mission.started_at,
    ended_at: flight.mission.ended_at,
  });
}

export function mediaReceivedTitle(media: Media, missionLabel: string | null): string {
  if (media.source === "drone") {
    const who = missionLabel ? `Lote de dron ${missionLabel}` : "Lote de dron";
    return `${who} — ${media.label}, ${media.frames.length} cuadros`;
  }
  return media.kind === "photo"
    ? `Fotos de vecino — ${media.label}`
    : `Video de vecino — ${media.label}`;
}

/** Siembra una vitrina completa. El informe se escribe al final: un incidente sin `situation` quedó a medias. */
export async function seedShowcase(deps: DemoDeps, spec: ShowcaseSpec): Promise<Incident> {
  const { store } = deps;
  const t0 = deps.now() - spec.started_min_ago * 60_000;
  const at = (s: number) => iso(t0 + s * 1000);

  const incident = await store.createIncident({
    type: spec.type,
    title: spec.title,
    address: spec.address,
    lat: spec.lat,
    lng: spec.lng,
    description: `${spec.description}\n\n${DEMO_NOTICE}`,
    origin: "demo",
    verified: true,
    status: "active",
  });
  await store.addEvent({
    incident_id: incident.id,
    at: at(0),
    kind: "incident_created",
    severity: "info",
    title: `Incidente creado — ${spec.address}`,
    detail: DEMO_NOTICE,
  });

  // Un evento "comms" de la vitrina con comm_seq reemplaza al automático de esa entrada (título más claro).
  const commOverrides = new Map(
    spec.events.filter((e) => e.kind === "comms" && e.comm_seq !== undefined).map((e) => [e.comm_seq, e]),
  );
  const comms = [];
  for (const c of spec.comms) {
    const entry = await store.addComm({
      incident_id: incident.id,
      text: c.text,
      speaker: c.speaker,
      channel: c.channel,
      source: "simulated",
      at: at(c.at_s),
    });
    comms.push(entry);
    const override = commOverrides.get(entry.seq);
    await store.addEvent({
      incident_id: incident.id,
      at: entry.at,
      kind: "comms",
      severity: override?.severity ?? "info",
      title: override?.title ?? commEventTitle(c.speaker, c.text),
      detail: override?.detail ?? (c.channel ? `Canal ${c.channel} · C${entry.seq}` : `C${entry.seq}`),
      comm_id: entry.id,
    });
  }

  const mission = spec.mission ? await seedMission(deps, incident, spec.mission, t0) : null;

  const media: Media[] = [];
  for (const m of spec.media) {
    const missionId = m.source === "drone" ? (mission?.id ?? null) : null;
    const inserted = await insertDemoMedia(deps, incident, m, {
      capturedAtMs: t0 + m.captured_at_s * 1000,
      analyzedAtMs: t0 + m.analyzed_at_s * 1000,
      missionId,
      finalStatus: "analyzed",
    });
    media.push(inserted);
    await store.addEvent({
      incident_id: incident.id,
      at: at(m.received_at_s),
      kind: "media_received",
      severity: "info",
      title: mediaReceivedTitle(inserted, mission?.label ?? null),
      detail: m.reporter_note || m.analysis.viewpoint.position_description,
      media_id: inserted.id,
      mission_id: missionId,
    });
    await store.addEvent({
      incident_id: incident.id,
      at: at(m.analyzed_at_s),
      kind: "media_analyzed",
      severity: "info",
      title: `${inserted.label} analizado`,
      detail: m.analysis.summary,
      media_id: inserted.id,
      mission_id: missionId,
    });
  }
  if (mission) {
    const droneFrames = media
      .filter((m) => m.mission_id === mission.id)
      .reduce((n, m) => n + m.frames.length, 0);
    if (droneFrames > 0) await store.updateMission(mission.id, { frames_received: droneFrames });
  }

  // Los eventos "comms" ya se registraron uno por entrada de radio (con su reemplazo, si había).
  for (const e of spec.events.filter((x) => x.kind !== "comms")) {
    const mediaRef = e.media !== undefined ? media[e.media] : undefined;
    const commRef = e.comm_seq !== undefined ? comms.find((c) => c.seq === e.comm_seq) : undefined;
    await store.addEvent({
      incident_id: incident.id,
      at: at(e.at_s),
      kind: e.kind,
      severity: e.severity,
      title: e.title,
      detail: e.detail,
      media_id: mediaRef?.id ?? null,
      comm_id: commRef?.id ?? null,
      mission_id: e.mission && mission ? mission.id : null,
    });
  }

  const lastComm = spec.comms.length ? spec.comms[spec.comms.length - 1].at_s : 0;
  const lastMedia = spec.media.reduce((s, m) => Math.max(s, m.analyzed_at_s), 0);
  const fusedAt = at(Math.max(lastComm, lastMedia) + 20);
  return store.updateIncident(incident.id, {
    status: spec.status,
    comms_analysis: spec.comms_analysis,
    comms_engine: "simulated",
    comms_analysis_updated_at: at(lastComm + 8),
    scene: spec.scene,
    scene_engine: "simulated",
    scene_updated_at: fusedAt,
    situation: spec.situation,
    situation_engine: "simulated",
    situation_updated_at: fusedAt,
    pipeline: {
      fusion_status: "idle",
      fusion_error: null,
      fusion_requested_at: fusedAt,
      fusion_started_at: fusedAt,
      fusion_finished_at: fusedAt,
      comms_status: "idle",
      comms_error: null,
      comms_requested_at: at(lastComm),
      comms_finished_at: at(lastComm + 8),
    },
  });
}
