/**
 * Render (react-dom/server) de la banda y los paneles de la vista técnica.
 *   node --import tsx --test src/components/mando/diagnostics/DiagnosticsDetail.test.tsx
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DiagnosticsBand } from "./DiagnosticsBand";
import { DiagnosticsPanels } from "./DiagnosticsDetail";
import { CALL, diag, iso, T0, utt } from "./fixtures.test-helpers";
import { subsystems } from "./model";

const noop = () => undefined;

test("la banda muestra un rótulo por subsistema y el aviso sin conexión", () => {
  const d = diag();
  const html = renderToStaticMarkup(
    <DiagnosticsBand items={subsystems(d, T0)} offline={{ since: "(último dato hace 20 s)", message: "Sin conexión." }} open={false} onOpen={noop} onClose={noop} />,
  );
  for (const label of ["Motor", "Zello", "Claude", "Detector", "Vigía", "Errores"]) assert.match(html, new RegExp(`>${label}<`));
  assert.match(html, /conectado · latido hace 4 s/);
  assert.match(html, /Sin datos del servidor \(último dato hace 20 s\)/);
  assert.match(html, /Ver detalle/);
  const loading = renderToStaticMarkup(<DiagnosticsBand items={null} offline={null} open onOpen={noop} onClose={noop} />);
  assert.match(loading, /Revisando los sistemas/);
  assert.match(loading, /Volver a la operación/);
});

test("los paneles muestran Zello, Claude, detector, salida, errores y motor", () => {
  const base = diag();
  const d = diag({
    zello: { ...base.zello, received_at: iso(T0 - 45_000), stale: true },
    claude: {
      calls: [{ ...CALL, ok: false, status: 529, error: "OverloadedError: 529 overloaded", input_tokens: null, output_tokens: null }, CALL],
      total: 2,
      errors: 1,
      p50_ms: 2100,
      max_ms: 2100,
    },
    outbox: {
      ...base.outbox,
      waiting: [utt(4, T0 - 5_000, "en_cola")],
      recent: [utt(4, T0 - 5_000, "en_cola"), { ...utt(3, T0 - 12_000, "pantalla"), speak: false, screen_reason: "limite_20s", rules: ["ausencia"] }],
      blocked: [{ at: iso(T0 - 9_000), text: "B-3, entren por el lado C", reasons: ["orden_a_unidad"] }],
    },
    errors: [{ at: iso(T0 - 30_000), first_at: iso(T0 - 90_000), count: 3, source: "puente", message: "Zello («demo-platanus»): Zello rechazó el token", incident_id: null, incident_code: null }],
  });
  const html = renderToStaticMarkup(<DiagnosticsPanels d={d} nowMs={T0} items={subsystems(d, T0)} />);
  assert.match(html, /Sin latido/);
  assert.match(html, /hace 45 s/);
  assert.match(html, /demo-platanus/);
  assert.match(html, /HTTP 529/);
  assert.match(html, /OverloadedError/);
  assert.match(html, /En cola para la radio \(1\)/);
  assert.match(html, /límite de 20 s/);
  assert.match(html, /«no hay nadie» → «no veo»/);
  assert.match(html, /orden a una unidad/);
  assert.match(html, /×3/);
  assert.match(html, /Zello rechazó el token/);
  assert.match(html, /Claude real/);
  // Ningún dato del motor trae credenciales.
  assert.doesNotMatch(html, /sk-ant/);

  const sim = diag({ engine: { ...base.engine, ai: "simulated", has_credential: false } });
  assert.match(renderToStaticMarkup(<DiagnosticsPanels d={sim} nowMs={T0} items={subsystems(sim, T0)} />), /MOTOR SIMULADO/);
});
