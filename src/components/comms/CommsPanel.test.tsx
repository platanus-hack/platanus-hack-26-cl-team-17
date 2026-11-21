import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { CommsPanel } from "./index";
import type { CommsPanelProps } from "./types";
import { ANALYSIS, COMMS, INCIDENT_ID, PIPELINE_IDLE } from "./fixtures.test-helpers";

function render(overrides: Partial<CommsPanelProps> = {}): string {
  const props: CommsPanelProps = {
    incidentId: INCIDENT_ID,
    comms: COMMS,
    analysis: ANALYSIS,
    engine: "claude",
    analysisUpdatedAt: "2026-11-21T00:25:00.000Z",
    pipeline: PIPELINE_IDLE,
    onChanged: () => {},
    highlightSeq: null,
    ...overrides,
  };
  return renderToStaticMarkup(<CommsPanel {...props} />);
}

/** Texto visible aproximado (sin etiquetas), para buscar frases que cruzan elementos. */
function text(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");
}

test("con análisis completo: MAYDAY, víctimas, unidades, mando, recursos, preguntas y claves", () => {
  const html = render();
  const t = text(html);
  assert.match(t, /MAYDAY activo — bombero en peligro/);
  assert.match(html, /role="alert"/);
  assert.match(t, /Radio informa víctimas/);
  assert.match(t, /Posible adulta mayor en el segundo piso/);
  assert.match(t, /Trabajando/, "estado de unidad B-3");
  assert.match(t, /OBAC/);
  assert.match(t, /Esquina Matta con Lira/);
  assert.match(t, /Recursos solicitados pendientes/);
  assert.match(t, /Segunda alarma/);
  assert.match(t, /Escalera comprometida/);
  assert.match(t, /Conviene preguntar por radio/);
  assert.match(t, /¿Cuántas personas viven en la casa\?/);
  assert.match(t, /Confianza baja/);
  assert.match(t, /verificar/);
  assert.match(t, /Actualizado/);
  assert.doesNotMatch(t, /Análisis por reglas/, "con Claude no aparece el aviso de simulación");
  // Plegable accesible.
  assert.match(html, /aria-expanded="true"/);
});

test("bitácora: C<seq>, emisor, canal, origen y etiquetas de eventos", () => {
  const t = text(render());
  for (const seq of [1, 2, 3, 4, 5]) assert.match(t, new RegExp(`C${seq}\\b`));
  assert.match(t, /Canal 1/);
  assert.match(t, /\bmanual\b/);
  assert.match(t, /\bdictado\b/);
  assert.match(t, /\bimportado\b/);
  assert.match(t, /\bsimulado\b/);
  assert.match(t, /Víctima reportada/);
  assert.match(t, /Solicitud de recursos/);
  assert.match(t, /Bombero de B-3 atrapado/);
  assert.match(t, /Escuchar radio/);
  assert.match(t, /Importar/);
  assert.match(t, /Enter envía · Shift\+Enter salto de línea/);
});

test("motor simulado muestra el aviso de análisis por reglas", () => {
  const t = text(render({ engine: "simulated" }));
  assert.match(t, /Análisis por reglas — sin modelo/);
  assert.match(t, /Simulado/);
});

test("sin análisis ni entradas: vacío con las tres vías y sin estados inventados", () => {
  const t = text(render({ comms: [], analysis: null, engine: null, analysisUpdatedAt: null }));
  assert.match(t, /Sin comunicaciones registradas/);
  assert.match(t, /Escribe/);
  assert.match(t, /Dicta/);
  assert.match(t, /Importa/);
  assert.match(t, /El análisis aparece cuando haya entradas de radio/);
  assert.doesNotMatch(t, /MAYDAY/);
  assert.doesNotMatch(t, /no hay atrapados/);
  assert.doesNotMatch(t, /Actualizado/);
});

test("sin análisis con entradas y pipeline corriendo o con error", () => {
  const running = text(render({ analysis: null, engine: null, pipeline: { ...PIPELINE_IDLE, comms_status: "running" } }));
  assert.match(running, /Analizando la radio…/);
  assert.match(running, /se está procesando la radio/);

  const failed = text(
    render({
      analysis: null,
      engine: null,
      pipeline: { ...PIPELINE_IDLE, comms_status: "error", comms_error: "Tiempo de espera agotado" },
    }),
  );
  assert.match(failed, /No se pudo analizar la radio/);
  assert.match(failed, /Tiempo de espera agotado/);
});

test("víctimas: negadas por unidad en el lugar y sin información (no descarta)", () => {
  const denied = text(
    render({
      analysis: { ...ANALYSIS, mayday: { active: false, detail: "" }, victims: { status: "denied_by_unit", detail: "", entry_seqs: [2] } },
    }),
  );
  assert.match(denied, /Unidad en el lugar informa que no hay atrapados/);
  assert.doesNotMatch(denied, /MAYDAY activo — bombero en peligro/);

  const unknown = text(
    render({ analysis: { ...ANALYSIS, victims: { status: "unknown", detail: "", entry_seqs: [] } } }),
  );
  assert.match(unknown, /no descarta víctimas/);
});

test("referencias a entradas inexistentes quedan atenuadas (sin botón)", () => {
  const html = render({ analysis: { ...ANALYSIS, victims: { ...ANALYSIS.victims, entry_seqs: [99] } } });
  assert.match(html, /title="C99 no está en la bitácora"/);
  assert.doesNotMatch(html, /title="Ver C99 en la bitácora"/);
  assert.match(html, /title="Ver C5 en la bitácora"|>C5</);
});

test("highlightSeq inicial no rompe el render", () => {
  const t = text(render({ highlightSeq: 3 }));
  assert.match(t, /C3/);
});
