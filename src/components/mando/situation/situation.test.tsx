/**
 * Pruebas de render (react-dom/server) y de la lógica pura de los paneles de situación.
 *   node --import tsx --test src/components/mando/situation/situation.test.tsx
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { EMPTY_PIPELINE, type CommEntry, type Incident, type SituationReport } from "@/lib/domain";
import type { MediaView } from "@/lib/contract";
import { CriticalStrip, SituationPanel } from "./index";
import { evidenceLabel, resolveEvidence } from "./evidence";
import { briefingCopyText, byPriority, divergentType, fusionPipelineView, trappedCountText, trappedRange, uniqueLocations } from "./model";

/* ─────────────────────────── Fixtures ─────────────────────────── */

const T0 = "2026-11-21T14:00:00.000Z";

function situationFixture(over: Partial<SituationReport> = {}): SituationReport {
  return {
    headline: "Casa de 2 pisos con fuego en 2º piso; posible persona atrapada en ventana",
    incident_type: "structure_fire",
    severity: "high",
    trapped: {
      status: "probable",
      count_min: 1,
      count_max: 2,
      locations: ["Ventana 2º piso, costado Bravo"],
      basis:
        "M2 muestra una silueta haciendo señas en la ventana del 2º piso en dos fotogramas; C3 un vecino informa que vive una adulta mayor en el segundo piso.",
      evidence: [
        { ref: "M2", frame: 3, note: "Silueta en ventana del 2º piso" },
        { ref: "C3", frame: -1, note: "Vecino: vive una adulta mayor arriba" },
      ],
    },
    injured: { status: "possible", count_estimate: 1, detail: "Vecino con tos en la vereda" },
    fire: {
      present: true,
      stage: "growth",
      location: "2º piso, costado Alfa",
      spread: "Hacia el entretecho y la casa del costado Delta",
      smoke: "Negro, denso, por aleros",
    },
    structure: {
      description: "Casa pareada de 2 pisos, albañilería y segundo piso de madera",
      floors: 2,
      construction: "mixed",
      exposures: "Casa pareada del costado Delta",
    },
    vehicles: { count: 0, description: "", entrapment: "no_evidence", details: "" },
    hazards: [
      { kind: "gas_cylinder", description: "Cilindro de 15 kg junto a la puerta", severity: "medium", evidence: [{ ref: "M1", frame: 0, note: "Cilindro" }] },
      { kind: "power_lines", description: "Tendido sobre la fachada", severity: "high", evidence: [{ ref: "M9", frame: 1, note: "Cables" }] },
    ],
    access: {
      best_approach: "Por Av. Los Aromos desde el norte",
      obstructions: ["Autos estacionados en ambos lados"],
      water_supply: "Grifo en la esquina de Los Aromos con Las Rosas",
      staging_suggestion: "Esquina norte",
    },
    insights: [
      { id: "I2", category: "hazard", priority: "high", title: "Cilindro de gas expuesto", detail: "A 2 m del foco", confidence: "medium", evidence: [] },
      {
        id: "I1",
        category: "life_safety",
        priority: "critical",
        title: "Posible persona en ventana del 2º piso",
        detail: "Silueta en dos fotogramas",
        confidence: "medium",
        evidence: [{ ref: "M2", frame: 3, note: "Silueta" }],
      },
    ],
    contradictions: [{ description: "M2 muestra a alguien en la ventana; C5 dice que la casa está vacía", sources: ["M2", "C5"] }],
    unknowns: ["Si hay alguien en el primer piso"],
    recommended_actions: [
      { action: "Confirmar búsqueda primaria en 2º piso", rationale: "Indicio de persona en ventana", priority: "critical" },
    ],
    briefing: {
      spoken: "Incendio en casa de dos pisos con posible persona atrapada en la ventana del segundo piso.",
      bullets: ["Fuego en 2º piso", "Posible atrapada en ventana", "Cilindro de gas en la entrada"],
    },
    overall_confidence: "medium",
    ...over,
  };
}

function incidentFixture(over: Partial<Incident> = {}): Incident {
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
    rev: 7,
    situation: situationFixture(),
    situation_engine: "claude",
    situation_updated_at: T0,
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

function mediaFixture(label: string, frames: number): MediaView {
  const id = `med-${label}`;
  return {
    id,
    incident_id: "inc-1",
    label,
    source: "citizen",
    kind: "video",
    mission_id: null,
    video_path: null,
    video_status: "none",
    mime: "video/mp4",
    size_bytes: 1000,
    duration_s: 12,
    lat: null,
    lng: null,
    accuracy_m: null,
    heading_deg: null,
    captured_at: T0,
    reporter_note: "",
    status: "analyzed",
    error: null,
    analysis: null,
    analysis_engine: "claude",
    analyzed_at: T0,
    frames: [],
    created_at: T0,
    urls: {
      video: null,
      poster: `/api/files/${id}/poster.jpg`,
      frames: Array.from({ length: frames }, (_, idx) => ({
        idx,
        t_s: idx * 3,
        url: `/api/files/${id}/frame-${idx}.jpg`,
        width: 1280,
        height: 720,
      })),
    },
  };
}

function commFixture(seq: number, text: string): CommEntry {
  return { id: `c${seq}`, incident_id: "inc-1", seq, at: T0, channel: "1", speaker: "B-3", text, source: "manual", audio_path: null, created_at: T0 };
}

const MEDIA = [mediaFixture("M1", 2), mediaFixture("M2", 6)];
const COMMS = [commFixture(3, "Vecino informa adulta mayor en 2º piso"), commFixture(5, "Central: casa estaría vacía")];
const noop = () => {};

/** Texto visible sin etiquetas, con espacios normalizados. */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ");
}

const strip = (incident: Incident, mediaCount = 2) =>
  renderToStaticMarkup(<CriticalStrip incident={incident} mediaCount={mediaCount} onEvidence={noop} />);
const panel = (incident: Incident, media: MediaView[] = MEDIA, comms: CommEntry[] = COMMS) =>
  renderToStaticMarkup(
    <SituationPanel incident={incident} media={media} comms={comms} onEvidence={noop} onReanalyze={noop} />,
  );

/* ─────────────────────────── CriticalStrip ─────────────────────────── */

test("franja: situación completa (probable) muestra estado, cantidad, ubicación, gravedad y evidencia", () => {
  const html = strip(incidentFixture());
  const t = text(html);
  assert.match(html, /data-trapped="probable"/);
  assert.match(t, /PROBABLE/);
  assert.match(t, /1–2 personas/);
  assert.match(t, /Ventana 2º piso, costado Bravo/);
  assert.match(t, /Gravedad Alta/);
  assert.match(t, /Lesionados: Posible · ~1/);
  assert.match(t, /Casa de 2 pisos con fuego/);
  assert.match(t, /Confianza media/);
  assert.match(t, /M2 · cuadro 3/);
  assert.match(t, /C3/);
  assert.match(html, /animate-pulse-critical/);
  assert.doesNotMatch(t, /La IA ve:/, "mismo tipo: no se muestra el tipo detectado");
  assert.doesNotMatch(t, /SIMULADO/);
});

test("franja: sin situación y sin medios → espera el primer video, nunca un estado inventado", () => {
  const t = text(strip(incidentFixture({ situation: null, situation_engine: null, situation_updated_at: null }), 0));
  assert.match(t, /Esperando el primer video o reporte…/);
  assert.doesNotMatch(t, /PROBABLE|CONFIRMADO|POSIBLE|DESCARTADO|SIN EVIDENCIA/);
  assert.match(t, /no se descartan víctimas/);
});

test("franja: sin situación con medios → analizando las primeras imágenes", () => {
  const t = text(strip(incidentFixture({ situation: null, situation_engine: null }), 3));
  assert.match(t, /Analizando las primeras imágenes…/);
  assert.doesNotMatch(t, /Esperando el primer video/);
});

test("franja: no_evidence dice SIN EVIDENCIA — no descarta víctimas y no es verde", () => {
  const s = situationFixture({
    trapped: { status: "no_evidence", count_min: 0, count_max: 0, locations: [], basis: "Nada en los videos lo indica.", evidence: [] },
  });
  const html = strip(incidentFixture({ situation: s }));
  const t = text(html);
  assert.match(t, /SIN EVIDENCIA — no descarta víctimas/);
  assert.doesNotMatch(t, /0 personas/, "nunca '0 personas' sin evidencia");
  assert.doesNotMatch(html, /bg-ok-soft/);
});

test("franja: cleared_by_unit dice que lo informó la unidad en el lugar, en tono ok", () => {
  const s = situationFixture({
    trapped: { status: "cleared_by_unit", count_min: 0, count_max: 0, locations: [], basis: "C9: B-3 en el lugar informa sin personas atrapadas.", evidence: [{ ref: "C9", frame: -1, note: "B-3" }] },
  });
  const html = strip(incidentFixture({ situation: s }));
  const t = text(html);
  assert.match(t, /DESCARTADO — según unidad en el lugar/);
  assert.match(html, /bg-ok-soft/);
});


test("franja: error de pipeline muestra fusion_error; running y pending sus textos", () => {
  const err = text(
    strip(incidentFixture({ pipeline: { ...EMPTY_PIPELINE, fusion_status: "error", fusion_error: "Se agotó el tiempo de espera del modelo" } })),
  );
  assert.match(err, /Error del análisis: Se agotó el tiempo de espera del modelo/);
  const run = text(strip(incidentFixture({ pipeline: { ...EMPTY_PIPELINE, fusion_status: "running" } })));
  assert.match(run, /Actualizando análisis…/);
  const pend = text(strip(incidentFixture({ pipeline: { ...EMPTY_PIPELINE, fusion_status: "pending" } })));
  assert.match(pend, /En cola/);
  const noSit = text(
    strip(incidentFixture({ situation: null, pipeline: { ...EMPTY_PIPELINE, fusion_status: "error", fusion_error: "Falla X" } }), 2),
  );
  assert.match(noSit, /No hay informe de situación/);
  assert.match(noSit, /Falla X/);
  assert.doesNotMatch(noSit, /Analizando las primeras/);
});

test("franja: tipo distinto → 'La IA ve'; count_max < count_min tolerado", () => {
  const s = situationFixture({
    incident_type: "vehicle_collision",
    trapped: { status: "confirmed", count_min: 3, count_max: 1, locations: [], basis: "", evidence: [] },
  });
  const t = text(strip(incidentFixture({ situation: s })));
  assert.match(t, /La IA ve: accidente de tránsito/);
  assert.match(t, /3 personas/);
  assert.doesNotMatch(t, /3–1/);
});

test("franja compacta: lugar repetido una vez, 3 chips + '+N', fundamento plegado y lesionados 'no descarta'", () => {
  const refs = ["M1", "M2", "M3", "M6", "M7"];
  const s = situationFixture({
    trapped: {
      status: "possible",
      count_min: 0,
      count_max: 1,
      locations: refs.map((r) => `2º piso (nota ${r})`),
      basis: refs.map((r) => `nota del informante en ${r}: «Hay personas adentro» (sin corroborar)`).join("; "),
      evidence: refs.map((ref) => ({ ref, frame: -1, note: "Nota del informante" })),
    },
    injured: { status: "no_evidence", count_estimate: 0, detail: "" },
    headline: "Incendio estructural; posible persona atrapada (sin confirmar)",
    overall_confidence: "low",
  });
  const html = strip(incidentFixture({ situation: s }));
  const t = text(html);
  assert.match(t, /POSIBLE/);
  assert.match(t, /Hasta 1 persona/);
  assert.equal(t.split("2º piso").length - 1, 1, "el lugar se lee una sola vez");
  assert.doesNotMatch(t, /\(nota M1\)/);
  // Tres chips visibles y el resto plegado.
  for (const r of ["M1", "M2", "M3"]) assert.match(html, new RegExp(`aria-label="${r}:`));
  assert.doesNotMatch(html, /aria-label="M6:/);
  assert.match(html, /aria-label="Ver 2 evidencias más"/);
  // El fundamento existe pero queda oculto tras "Por qué".
  assert.match(html, /aria-expanded="false"[^>]*>Por qué/);
  assert.match(html, /<p[^>]*hidden=""[^>]*>nota del informante en M1/);
  // Gravedad suave (sin relleno sólido) y lesionados sin evidencia, que no descarta.
  assert.doesNotMatch(html, /bg-critical text-on-solid|text-on-solid bg-critical/);
  assert.match(t, /Lesionados: Sin evidencia \(no descarta\)/);
  // La confianza sigue visible.
  assert.match(t, /Confianza baja/);
});

test("uniqueLocations agrupa el mismo lugar citado por varias fuentes", () => {
  assert.deepEqual(uniqueLocations(["2º piso (nota M1)", "2º piso (M2)", " 2º PISO ", "Patio (nota C3)"]), ["2º piso", "Patio"]);
  // Un paréntesis sin referencia es parte del lugar.
  assert.deepEqual(uniqueLocations(["Ventana (costado B)", "", "(M4)"]), ["Ventana (costado B)"]);
});

/* ─────────────────────────── SituationPanel ─────────────────────────── */

test("panel: situación completa con las 8 secciones, aviso táctico, briefing y pie", () => {
  const html = panel(incidentFixture());
  const t = text(html);
  for (const title of [
    "Hallazgos",
    "Peligros",
    "Fuego y estructura",
    "Acceso y agua",
    "Consideraciones tácticas",
    "Contradicciones",
    "Lo que no se sabe",
    "Briefing",
  ]) {
    assert.ok(t.includes(title), `falta la sección ${title}`);
  }
  assert.doesNotMatch(t, /Fuego, estructura y vehículos/, "sin vehículos en un incendio estructural");
  assert.match(t, /Sugerencias de apoyo — la decisión es del oficial a cargo/);
  assert.match(t, /Leer en voz alta/);
  assert.match(t, /Copiar/);
  assert.match(t, /Reanalizar/);
  assert.match(t, /IA \(Claude\)/);
  // Secciones plegables accesibles.
  assert.equal((html.match(/aria-expanded="true"/g) ?? []).length, 8);
  // Hallazgo crítico primero aunque la IA lo puso segundo.
  assert.ok(t.indexOf("Posible persona en ventana") < t.indexOf("Cilindro de gas expuesto"));
  // Peligro alto (tendido) antes que el medio (cilindro).
  assert.ok(t.indexOf("Tendido sobre la fachada") < t.indexOf("Cilindro de 15 kg"));
  // Evidencia existente: botón con miniatura del cuadro; inexistente (M9): atenuada y sin botón.
  assert.match(html, /<button[^>]*data-evidence-state="available"[^>]*>.*?frame-3\.jpg/);
  assert.match(html, /<span[^>]*data-evidence-state="missing"[^>]*>(?:(?!<\/span>).)*M9 · cuadro 1/);
  assert.doesNotMatch(html, /<button[^>]*>(?:(?!<\/button>).)*M9 · cuadro 1/);
  // Contradicción con sus fuentes como chips (C5 existe).
  assert.match(t, /C5/);
  assert.doesNotMatch(t, /SIMULADO/);
});

test("panel: sin situación y sin medios → espera; con medios → analizando", () => {
  const none = text(panel(incidentFixture({ situation: null, situation_engine: null, situation_updated_at: null }), [], []));
  assert.match(none, /Esperando el primer video o reporte…/);
  assert.match(none, /Sin informe/);
  assert.doesNotMatch(none, /Hallazgos/);
  const html = panel(incidentFixture({ situation: null, situation_engine: null }), MEDIA, []);
  assert.match(text(html), /Sin informe todavía/);
  assert.doesNotMatch(text(html), /Analizando las primeras imágenes…/, "la franja de arriba ya lo dice");
  // Sin fuentes, Reanalizar queda deshabilitado; con medios, habilitado.
  const disabledNoSources = /<button(?=[^>]*disabled="")(?=[^>]*title="Aún no hay medios)/;
  assert.match(panel(incidentFixture({ situation: null }), [], []), disabledNoSources);
  assert.doesNotMatch(html, /<button[^>]*title="Aún no hay medios/);
});


test("panel: hallazgo con detalle largo se pliega a 2 líneas, sin rótulo de categoría y con su confianza", () => {
  const long = "Indicio sin corroborar: nota del informante en M1, M2, M3, M6 y M7 indica personas adentro; nada en las imágenes lo confirma todavía.";
  const s = situationFixture({
    insights: [{ id: "I1", category: "life_safety", priority: "high", title: "Posible persona atrapada", detail: long, confidence: "low", evidence: [] }],
  });
  const html = panel(incidentFixture({ situation: s }));
  const t = text(html);
  assert.match(html, /<button[^>]*aria-expanded="false"[^>]*><span class="line-clamp-2">Indicio sin corroborar/);
  assert.doesNotMatch(t, /Vidas en riesgo/, "la categoría repetía el título");
  assert.match(t, /Posible persona atrapadaAlta/);
  assert.match(t, /Confianza baja/);
  // Sin aviso grande: la franja ya rotula el informe.
  assert.doesNotMatch(t, /SIMULADO/);
});

test("panel: error de pipeline visible con su mensaje", () => {
  const t = text(panel(incidentFixture({ pipeline: { ...EMPTY_PIPELINE, fusion_status: "error", fusion_error: "El modelo declinó analizar este contenido" } })));
  assert.match(t, /Error del análisis: El modelo declinó analizar este contenido/);
});

test("panel: colisión muestra vehículos con atrapamiento y 'sin evidencia (no descarta)'", () => {
  const s = situationFixture({
    incident_type: "vehicle_collision",
    fire: { present: false, stage: "none", location: "", spread: "", smoke: "" },
    structure: { description: "", floors: 0, construction: "unknown", exposures: "" },
    vehicles: { count: 2, description: "Choque frontal", entrapment: "no_evidence", details: "" },
    hazards: [],
    contradictions: [],
    unknowns: [],
  });
  const t = text(panel(incidentFixture({ type: "vehicle_collision", situation: s })));
  assert.match(t, /Vehículos/);
  assert.doesNotMatch(t, /Fuego y estructura/);
  assert.match(t, /Sin evidencia \(no descarta\)/);
  assert.match(t, /No se identificaron peligros en las fuentes. Eso no los descarta/);
  assert.match(t, /No se detectaron contradicciones/);
});

/* ─────────────────────────── Lógica pura ─────────────────────────── */

test("trappedRange / trappedCountText toleran rangos invertidos y valores raros", () => {
  const base = situationFixture().trapped;
  assert.deepEqual(trappedRange({ ...base, count_min: 3, count_max: 1 }), { min: 3, max: 3 });
  assert.deepEqual(trappedRange({ ...base, count_min: Number.NaN, count_max: -2 }), { min: 0, max: 0 });
  assert.equal(trappedCountText({ ...base, status: "confirmed", count_min: 1, count_max: 1 }), "1 persona");
  assert.equal(trappedCountText({ ...base, status: "possible", count_min: 0, count_max: 2 }), "Hasta 2 personas");
  assert.equal(trappedCountText({ ...base, status: "probable", count_min: 0, count_max: 0 }), "Cantidad sin determinar");
  assert.equal(trappedCountText({ ...base, status: "no_evidence", count_min: 0, count_max: 0 }), null);
  assert.equal(trappedCountText({ ...base, status: "cleared_by_unit", count_min: 0, count_max: 0 }), null);
});

test("resolveEvidence: medio/cuadro, radio, inexistentes y sin verificar", () => {
  assert.equal(evidenceLabel({ ref: "m2", frame: 3, note: "" }), "M2 · cuadro 3");
  assert.equal(evidenceLabel({ ref: "C7", frame: -1, note: "" }), "C7");
  const frame = resolveEvidence({ ref: "M2", frame: 3, note: "x" }, { media: MEDIA, comms: COMMS });
  assert.equal(frame.state, "available");
  assert.equal(frame.thumbUrl, "/api/files/med-M2/frame-3.jpg");
  const poster = resolveEvidence({ ref: "M1", frame: -1, note: "" }, { media: MEDIA });
  assert.equal(poster.thumbUrl, "/api/files/med-M1/poster.jpg");
  const noFrame = resolveEvidence({ ref: "M1", frame: 9, note: "" }, { media: MEDIA });
  assert.equal(noFrame.state, "available");
  assert.equal(noFrame.thumbUrl, null);
  assert.equal(resolveEvidence({ ref: "M9", frame: 0, note: "" }, { media: MEDIA }).state, "missing");
  assert.equal(resolveEvidence({ ref: "C3", frame: -1, note: "" }, { comms: COMMS }).state, "available");
  assert.equal(resolveEvidence({ ref: "C99", frame: -1, note: "" }, { comms: COMMS }).state, "missing");
  assert.equal(resolveEvidence({ ref: "foto", frame: -1, note: "" }, { media: MEDIA }).state, "missing");
  assert.equal(resolveEvidence({ ref: "M2", frame: 0, note: "" }).state, "unchecked");
});

test("fusionPipelineView, divergentType, byPriority y briefingCopyText", () => {
  assert.equal(fusionPipelineView(EMPTY_PIPELINE), null);
  assert.equal(fusionPipelineView({ ...EMPTY_PIPELINE, fusion_status: "error", fusion_error: null })?.text, "El análisis falló sin detalle.");
  assert.equal(divergentType({ type: "structure_fire" }, { incident_type: "unknown" }), null);
  assert.equal(divergentType({ type: "structure_fire" }, { incident_type: "vehicle_fire" }), "vehicle_fire");
  assert.deepEqual(
    byPriority([
      { priority: "low", n: 1 },
      { priority: "critical", n: 2 },
      { priority: "low", n: 3 },
    ] as const).map((x) => x.n),
    [2, 1, 3],
  );
  assert.equal(briefingCopyText({ spoken: " Hola. ", bullets: ["a", " ", "b"] }), "Hola.\n\n• a\n• b");
});
