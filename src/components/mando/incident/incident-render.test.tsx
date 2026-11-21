/**
 * Render (react-dom/server) de piezas de la vista de incidente: cabecera, visor de medio y tira.
 *   node --import tsx --test src/components/mando/incident/incident-render.test.tsx
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { EMPTY_PIPELINE, type Incident, type MediaAnalysis } from "@/lib/domain";
import type { MediaView, RuntimeMode } from "@/lib/contract";
import { IncidentHeader } from "./IncidentHeader";
import { MediaGrid } from "./MediaGrid";
import { MediaStrip } from "./MediaStrip";
import { MediaViewer } from "./MediaViewer";

const T0 = "2026-11-21T14:00:00.000Z";
const CLAUDE: RuntimeMode = { store: "local", files: "local", ai: "claude", auth: "open", model: "claude-opus-5-5" };
const NO_KEY: RuntimeMode = { ...CLAUDE, ai: "simulated", model: null };
const noop = () => {};

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ");
}

function incident(over: Partial<Incident> = {}): Incident {
  return {
    id: "inc-1",
    code: "VG-7K3Q",
    type: "structure_fire",
    title: "Incendio en Los Aromos 1234",
    address: "Los Aromos 1234, Ñuñoa",
    lat: -33.45,
    lng: -70.6,
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
    created_at: T0,
    updated_at: T0,
    ...over,
  };
}

const ANALYSIS: MediaAnalysis = {
  usable: true,
  unusable_reason: "",
  incident_type: "structure_fire",
  summary: "Casa de dos pisos con humo negro por ventanas del segundo piso.",
  viewpoint: { position_description: "Vereda de enfrente", facing: "N", distance_m: 25, elevation: "ground" },
  structure: { present: true, kind: "house_2_story", floors_visible: 2, construction: "mixed", exposures: "", description: "Casa pareada" },
  fire: {
    present: true,
    stage: "growth",
    flames_visible: false,
    locations: [{ floor: 2, side: "front", description: "Ventana del 2º piso" }],
    smoke: { present: true, color: "black", volume: "heavy", description: "Humo denso" },
    spread_risk: "high",
  },
  people: [
    {
      status: "at_window_or_balcony",
      count: 1,
      location: "Ventana del 2º piso",
      floor: 2,
      frame_refs: [1],
      confidence: "medium",
      description: "Silueta haciendo señas",
    },
  ],
  vehicles: [],
  hazards: [{ kind: "power_lines", description: "Tendido sobre la fachada", severity: "high", frame_refs: [0] }],
  access: { description: "Calle de doble sentido", obstructions: [], water_sources: [] },
  key_frames: [{ frame: 1, caption: "Persona en la ventana" }],
  visible_text: ["1234"],
  uncertainties: ["No se ve el costado posterior"],
  confidence: "medium",
};

function media(over: Partial<MediaView> = {}): MediaView {
  return {
    id: "med-1",
    incident_id: "inc-1",
    label: "M1",
    source: "citizen",
    kind: "video",
    mission_id: null,
    video_path: null,
    video_status: "uploading",
    mime: "video/mp4",
    size_bytes: 2_000_000,
    duration_s: 18,
    lat: -33.4501,
    lng: -70.6002,
    accuracy_m: 8,
    heading_deg: 10,
    captured_at: T0,
    reporter_note: "Hay una señora mayor en el segundo piso",
    status: "analyzed",
    error: null,
    analysis: ANALYSIS,
    analysis_engine: "claude",
    analyzed_at: T0,
    frames: [],
    created_at: T0,
    urls: {
      video: null,
      poster: "/api/files/m1/0.jpg",
      frames: [0, 1, 2].map((idx) => ({ idx, t_s: idx * 3, url: `/api/files/m1/${idx}.jpg`, width: 1280, height: 720 })),
    },
    ...over,
  };
}

test("cabecera: demo y sin verificar quedan rotulados, con código y acciones", () => {
  const html = renderToStaticMarkup(
    <IncidentHeader
      incident={incident({ origin: "demo", verified: false })}
      mode={CLAUDE}
      onShare={noop}
      onAddMedia={noop}
      onChanged={noop}
    />,
  );
  const t = text(html);
  assert.match(t, /DEMO · datos ficticios/);
  assert.match(t, /SIN VERIFICAR/);
  assert.match(t, /Verificar/);
  assert.match(t, /VG-7K3Q/);
  for (const action of ["Compartir", "Agregar video", "Reanalizar"]) assert.match(t, new RegExp(action));
  assert.match(t, /Activo/);
  assert.match(t, /Controlado/);
  assert.match(t, /Cerrado/);
});

test("visor: fotograma citado, personas en riesgo con confianza, nota del vecino sin verificar y aviso del video", () => {
  const html = renderToStaticMarkup(
    <MediaViewer
      incidentId="inc-1"
      media={[media()]}
      target={{ mediaId: "med-1", frame: 1 }}
      onClose={noop}
      onChanged={noop}
      mode={CLAUDE}
    />,
  );
  const t = text(html);
  assert.match(t, /Fotograma 1/);
  assert.match(t, /Citado como evidencia/);
  assert.match(t, /Personas en riesgo/);
  assert.match(t, /Confianza media/);
  assert.match(t, /Nota del vecino — sin verificar/);
  assert.match(t, /El video original aún no llega; se analizó con fotogramas/);
  assert.match(t, /Reanalizar este medio/);
  assert.doesNotMatch(t, /SIMULADO/);
});

test("visor: análisis sin motor informado nunca se presenta como IA; sin clave se rotula simulado", () => {
  const unknown = text(
    renderToStaticMarkup(
      <MediaViewer
        incidentId="inc-1"
        media={[media({ analysis_engine: null })]}
        target={{ mediaId: "med-1" }}
        onClose={noop}
        onChanged={noop}
        mode={CLAUDE}
      />,
    ),
  );
  assert.doesNotMatch(unknown, /IA \(Claude\)/);
  const noKey = text(
    renderToStaticMarkup(
      <MediaViewer
        incidentId="inc-1"
        media={[media({ analysis_engine: null })]}
        target={{ mediaId: "med-1" }}
        onClose={noop}
        onChanged={noop}
        mode={NO_KEY}
      />,
    ),
  );
  assert.match(noKey, /SIMULADO/);
});

test("visor: medio sin personas dice que eso no descarta víctimas; medio fallido muestra error y reintento", () => {
  const empty = text(
    renderToStaticMarkup(
      <MediaViewer
        incidentId="inc-1"
        media={[media({ analysis: { ...ANALYSIS, people: [] } })]}
        target={{ mediaId: "med-1" }}
        onClose={noop}
        onChanged={noop}
        mode={CLAUDE}
      />,
    ),
  );
  assert.match(empty, /Esto no descarta víctimas/);
  const failed = text(
    renderToStaticMarkup(
      <MediaViewer
        incidentId="inc-1"
        media={[media({ status: "failed", error: "El modelo declinó analizar este contenido", analysis: null })]}
        target={{ mediaId: "med-1" }}
        onClose={noop}
        onChanged={noop}
        mode={CLAUDE}
      />,
    ),
  );
  assert.match(failed, /Falló el procesamiento de este medio/);
  assert.match(failed, /El modelo declinó analizar este contenido/);
  assert.match(failed, /Reintentar/);
});

test("tira y grilla: marcador de riesgo con icono y texto; simulado de demo rotulado", () => {
  const strip = renderToStaticMarkup(<MediaStrip media={[media()]} onOpen={noop} />);
  assert.match(text(strip), /RIESGO/);
  assert.match(text(strip), /1 con riesgo/);
  assert.match(strip, /aria-label="Abrir M1[^"]*personas en riesgo"/);
  const grid = text(
    renderToStaticMarkup(
      <MediaGrid media={[media({ source: "demo", analysis_engine: "simulated" })]} onOpen={noop} mode={CLAUDE} demo />,
    ),
  );
  assert.match(grid, /Simulado/);
  assert.match(grid, /datos de demostración/);
  assert.match(grid, /Confianza media/);
});
