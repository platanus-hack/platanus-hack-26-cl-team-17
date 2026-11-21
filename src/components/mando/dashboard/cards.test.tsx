/**
 * Pruebas de render (react-dom/server) de las tarjetas del tablero.
 *   node --import tsx --test src/components/mando/dashboard/cards.test.tsx
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import type { IncidentSummary } from "@/lib/contract";
import { CitizenReportCard } from "./CitizenReportCard";
import { IncidentCard } from "./IncidentCard";

const T0 = "2026-11-21T14:00:00.000Z";

function summary(over: Partial<IncidentSummary> = {}): IncidentSummary {
  return {
    id: "inc-1",
    code: "VG-7K3Q",
    type: "structure_fire",
    title: "Incendio en Los Aromos 1234",
    address: "Los Aromos 1234, Ñuñoa",
    lat: -33.45,
    lng: -70.6,
    status: "active",
    origin: "command",
    verified: true,
    created_at: T0,
    updated_at: T0,
    rev: 3,
    headline: "Casa de 2 pisos con fuego en 2º piso; posible persona en ventana",
    severity: "high",
    trapped_status: "probable",
    situation_engine: "claude",
    situation_confidence: "medium",
    media_count: 2,
    comms_count: 5,
    active_missions: 1,
    ...over,
  };
}

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ");
}

const noop = () => {};

test("tarjeta: atrapados con icono y texto, gravedad y confianza del informe", () => {
  const html = renderToStaticMarkup(<IncidentCard incident={summary()} />);
  const t = text(html);
  assert.match(t, /Atrapados: PROBABLE/);
  assert.match(html, /<svg/, "la insignia lleva icono");
  assert.match(t, /Gravedad alta/);
  assert.match(t, /Confianza media/);
  assert.doesNotMatch(t, /Simulado/);
  assert.match(html, /href="\/mando\/inc-1"/);
});

test("tarjeta: informe simulado fuera de la demo queda rotulado", () => {
  const t = text(renderToStaticMarkup(<IncidentCard incident={summary({ situation_engine: "simulated" })} />));
  assert.match(t, /Simulado/);
  // En la demo ya se rotula "Demo" (datos ficticios): no se duplica.
  const demo = text(
    renderToStaticMarkup(<IncidentCard incident={summary({ situation_engine: "simulated", origin: "demo" })} />),
  );
  assert.match(demo, /Demo/);
  assert.doesNotMatch(demo, /Simulado/);
});

test("tarjeta: sin informe nunca se lee como seguro", () => {
  const t = text(
    renderToStaticMarkup(
      <IncidentCard
        incident={summary({ trapped_status: null, severity: null, headline: null, situation_engine: null, situation_confidence: null })}
      />,
    ),
  );
  assert.match(t, /sin análisis aún/);
  assert.doesNotMatch(t, /Confianza/);
});

test("reporte ciudadano sin verificar: muestra lo que ve la IA (atrapados, titular) y las acciones", () => {
  const i = summary({ origin: "citizen", verified: false, trapped_status: "possible", situation_confidence: "low" });
  const t = text(renderToStaticMarkup(<CitizenReportCard incident={i} onChanged={noop} />));
  assert.match(t, /Reporte ciudadano sin verificar/);
  assert.match(t, /Atrapados: POSIBLE/);
  assert.match(t, /Confianza baja/);
  assert.match(t, /posible persona en ventana/);
  assert.match(t, /Verificar/);
  assert.match(t, /Descartar/);
});
