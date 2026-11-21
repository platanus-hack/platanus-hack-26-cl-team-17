/**
 * Render (react-dom/server) de los paneles del mando con los datos de las vitrinas de demostración:
 * comprueba que la información crítica se lea completa y rotulada (simulado, confianza, evidencia).
 *   node --import tsx --test src/components/mando/situation/demo-render.test.tsx
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { EMPTY_PIPELINE, type CommEntry, type Incident } from "@/lib/domain";
import type { MediaView, RuntimeMode } from "@/lib/contract";
import { SHOWCASE_A } from "@/lib/demo/data-showcase-a";
import { SHOWCASE_B } from "@/lib/demo/data-showcase-b";
import type { ShowcaseSpec } from "@/lib/demo/types";
import { CommsPanel } from "@/components/comms";
import { CriticalStrip, SituationPanel } from "./index";
import { resolveEvidence } from "./evidence";

const T0 = "2026-11-21T14:00:00.000Z";
const MODE: RuntimeMode = { store: "local", files: "local", ai: "claude", auth: "open", model: "claude-opus-5-5" };
const noop = () => {};

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ");
}

function incidentOf(spec: ShowcaseSpec): Incident {
  return {
    id: "demo-1",
    code: "VG-DEMO",
    type: spec.type,
    title: spec.title,
    address: spec.address,
    lat: spec.lat,
    lng: spec.lng,
    status: spec.status,
    description: spec.description,
    origin: "demo",
    verified: true,
    share_key: "k",
    rev: 1,
    situation: spec.situation,
    situation_engine: "simulated",
    situation_updated_at: T0,
    scene: spec.scene,
    scene_engine: "simulated",
    scene_updated_at: T0,
    comms_analysis: spec.comms_analysis,
    comms_engine: "simulated",
    comms_analysis_updated_at: T0,
    pipeline: { ...EMPTY_PIPELINE },
    created_at: T0,
    updated_at: T0,
  };
}

function mediaOf(spec: ShowcaseSpec): MediaView[] {
  return spec.media.map((m, i) => {
    const id = `med-${i + 1}`;
    return {
      id,
      incident_id: "demo-1",
      label: `M${i + 1}`,
      source: m.source,
      kind: m.kind,
      mission_id: null,
      video_path: null,
      video_status: "none",
      mime: null,
      size_bytes: null,
      duration_s: m.duration_s,
      lat: null,
      lng: null,
      accuracy_m: m.accuracy_m,
      heading_deg: m.heading_deg,
      captured_at: T0,
      reporter_note: m.reporter_note,
      status: "analyzed",
      error: null,
      analysis: m.analysis,
      analysis_engine: "simulated",
      analyzed_at: T0,
      frames: [],
      created_at: T0,
      urls: {
        video: null,
        poster: `/api/files/${id}/000.svg`,
        frames: m.frames.map((_, idx) => ({ idx, t_s: idx * 2, url: `/api/files/${id}/${idx}.svg`, width: 1280, height: 720 })),
      },
    };
  });
}

function commsOf(spec: ShowcaseSpec): CommEntry[] {
  return spec.comms.map((c, i) => ({
    id: `c${i + 1}`,
    incident_id: "demo-1",
    seq: i + 1,
    at: T0,
    channel: c.channel,
    speaker: c.speaker,
    text: c.text,
    source: "simulated",
    audio_path: null,
    created_at: T0,
  }));
}

for (const [name, spec] of [
  ["vitrina A (incendio estructural)", SHOWCASE_A],
  ["vitrina B (colisión múltiple)", SHOWCASE_B],
] as const) {
  test(`${name}: franja crítica con estado de atrapados, icono, confianza y aviso de demostración`, () => {
    const incident = incidentOf(spec);
    const html = renderToStaticMarkup(<CriticalStrip incident={incident} mediaCount={spec.media.length} mode={MODE} />);
    const t = text(html);
    assert.match(html, new RegExp(`data-trapped="${spec.situation.trapped.status}"`));
    assert.match(t, /Personas atrapadas/);
    assert.match(html, /<svg/, "el estado lleva icono");
    assert.match(t, /Confianza (baja|media|alta)/);
    assert.match(t, /SIMULADO/);
    assert.match(t, /datos de demostración/);
    assert.doesNotMatch(t, /ANTHROPIC_API_KEY/, "con IA configurada no se pide la clave");
  });

  test(`${name}: panel de situación completo, evidencias resueltas y rótulo de apoyo a la decisión`, () => {
    const incident = incidentOf(spec);
    const media = mediaOf(spec);
    const comms = commsOf(spec);
    const html = renderToStaticMarkup(
      <SituationPanel incident={incident} media={media} comms={comms} onEvidence={noop} onReanalyze={noop} mode={MODE} />,
    );
    const t = text(html);
    for (const section of ["Hallazgos", "Peligros", "Acceso y agua", "Consideraciones tácticas", "Contradicciones", "Lo que no se sabe", "Briefing"]) {
      assert.match(t, new RegExp(section), `falta la sección ${section}`);
    }
    assert.match(t, /la decisión es del oficial a cargo/);
    // Rótulo visible de simulado en el pie, con la explicación de demostración.
    assert.match(t, /Simulado/);
    assert.match(html, /data-engine="simulated"[^>]*title="[^"]*datos de demostración/);
    // Cada hallazgo muestra su confianza.
    assert.equal((t.match(/Confianza (baja|media|alta)/g) ?? []).length, spec.situation.insights.length + 1);
    // Toda evidencia citada por la demo apunta a un medio o comunicación existente.
    const refs = [
      ...spec.situation.trapped.evidence,
      ...spec.situation.insights.flatMap((i) => i.evidence),
      ...spec.situation.hazards.flatMap((h) => h.evidence),
    ];
    for (const ref of refs) {
      assert.equal(resolveEvidence(ref, { media, comms }).state, "available", `${ref.ref} (${ref.frame}) no resuelve`);
    }
  });

  test(`${name}: panel de radio con su bitácora y el aviso de análisis por reglas`, () => {
    const comms = commsOf(spec);
    const t = text(
      renderToStaticMarkup(
        <CommsPanel
          incidentId="demo-1"
          comms={comms}
          analysis={spec.comms_analysis}
          engine="simulated"
          analysisUpdatedAt={T0}
          pipeline={{ ...EMPTY_PIPELINE }}
          onChanged={noop}
        />,
      ),
    );
    assert.match(t, new RegExp(`C${comms.length}`));
    assert.match(t, /Análisis por reglas/);
    assert.match(t, /Reanalizar radio/);
    assert.match(t, /simulado/, "las entradas del simulacro quedan rotuladas");
  });
}
