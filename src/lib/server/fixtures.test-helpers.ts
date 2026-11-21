/** Datos de prueba de snapshot.ts y briefing.ts (solo para las pruebas de esta carpeta). */
import type { EvidenceRef, Media, MediaAnalysis, MediaFrame, SituationReport } from "@/lib/domain";

export const ev = (ref: string, frame: number, note = ""): EvidenceRef => ({ ref, frame, note });

/** Análisis de medio completo con los fotogramas clave indicados. */
export function analysis(keyFrames: { frame: number; caption: string }[] = [], summary = "Resumen"): MediaAnalysis {
  return {
    usable: true,
    unusable_reason: "",
    incident_type: "structure_fire",
    summary,
    viewpoint: { position_description: "", facing: "unknown", distance_m: 0, elevation: "ground" },
    structure: { present: true, kind: "house_2_story", floors_visible: 2, construction: "masonry", exposures: "", description: "" },
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
    key_frames: keyFrames,
    visible_text: [],
    uncertainties: [],
    confidence: "medium",
  };
}

type SituationOver = {
  trapped?: Partial<SituationReport["trapped"]>;
  insights?: SituationReport["insights"];
  hazards?: SituationReport["hazards"];
  headline?: string;
  severity?: SituationReport["severity"];
};

/** Informe de situación completo; por defecto sin evidencia de atrapados. */
export function situation(over: SituationOver = {}): SituationReport {
  return {
    headline: over.headline ?? "Casa de 2 pisos con fuego en 2º piso",
    incident_type: "structure_fire",
    severity: over.severity ?? "high",
    trapped: {
      status: "no_evidence",
      count_min: 0,
      count_max: 0,
      locations: [],
      basis: "",
      evidence: [],
      ...over.trapped,
    },
    injured: { status: "no_evidence", count_estimate: 0, detail: "" },
    fire: { present: true, stage: "growth", location: "", spread: "", smoke: "" },
    structure: { description: "", floors: 2, construction: "masonry", exposures: "" },
    vehicles: { count: 0, description: "", entrapment: "no_evidence", details: "" },
    hazards: over.hazards ?? [],
    access: { best_approach: "", obstructions: [], water_supply: "", staging_suggestion: "" },
    insights: over.insights ?? [],
    contradictions: [],
    unknowns: [],
    recommended_actions: [],
    briefing: { spoken: "", bullets: [] },
    overall_confidence: "medium",
  };
}

export function frame(mediaId: string, idx: number, path = `incidents/i/media/${mediaId}/frames/${String(idx).padStart(3, "0")}.jpg`): MediaFrame {
  return {
    id: `${mediaId}-f${idx}`,
    media_id: mediaId,
    idx,
    t_s: idx,
    storage_path: path,
    width: 1280,
    height: 720,
    lat: null,
    lng: null,
    alt_m: null,
    heading_deg: null,
  };
}

/** Medio en memoria (para funciones puras). */
export function media(over: Partial<Media> & { id: string; label: string; frameCount?: number }): Media {
  const { frameCount = 3, ...rest } = over;
  return {
    incident_id: "11111111-1111-4111-8111-111111111111",
    source: "citizen",
    kind: "video",
    mission_id: null,
    video_path: null,
    video_status: "none",
    mime: "video/mp4",
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
    frames: Array.from({ length: frameCount }, (_, i) => frame(over.id, i)),
    created_at: "2026-11-21T12:00:00.000Z",
    ...rest,
  };
}
