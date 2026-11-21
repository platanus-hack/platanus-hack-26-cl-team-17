/** Datos de prueba de la línea de tiempo (solo para las pruebas de esta carpeta). */
import type { TimelineEvent } from "@/lib/domain";
import type { MediaView } from "@/lib/contract";

export const INCIDENT_ID = "inc_test";
const T0 = Date.parse("2026-11-21T17:00:00.000Z");

let seq = 0;

/** Evento con valores por defecto; `minute` fija la hora relativa a T0. */
export function ev(over: Partial<TimelineEvent> & { minute?: number } = {}): TimelineEvent {
  seq += 1;
  const { minute, ...rest } = over;
  return {
    id: `ev_${seq}`,
    incident_id: INCIDENT_ID,
    at: new Date(T0 + (minute ?? seq) * 60_000).toISOString(),
    kind: "incident_updated",
    severity: "info",
    title: `Evento ${seq}`,
    detail: "",
    media_id: null,
    comm_id: null,
    mission_id: null,
    ...rest,
  };
}

export function droneTick(missionId = "mis_1", over: Partial<TimelineEvent> = {}): TimelineEvent {
  return ev({ kind: "drone", severity: "info", title: "Dron D1: punto de ruta alcanzado", mission_id: missionId, ...over });
}

export function mediaView(over: Partial<MediaView> = {}): MediaView {
  return {
    id: "med_2",
    incident_id: INCIDENT_ID,
    label: "M2",
    source: "citizen",
    kind: "video",
    mission_id: null,
    video_path: "incidents/inc_test/media/med_2/video.mp4",
    video_status: "uploaded",
    mime: "video/mp4",
    size_bytes: 4_200_000,
    duration_s: 18,
    lat: -33.4489,
    lng: -70.6693,
    accuracy_m: 12,
    heading_deg: 90,
    captured_at: new Date(T0).toISOString(),
    reporter_note: "Se ve humo negro saliendo del segundo piso",
    status: "analyzed",
    error: null,
    analysis: null,
    analysis_engine: "simulated",
    analyzed_at: new Date(T0 + 120_000).toISOString(),
    frames: [],
    created_at: new Date(T0).toISOString(),
    urls: { video: "/api/files/x/video.mp4", poster: null, frames: [] },
    ...over,
  };
}
