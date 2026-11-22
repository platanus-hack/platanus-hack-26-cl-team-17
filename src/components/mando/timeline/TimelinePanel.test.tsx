import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { TimelinePanel } from "./index";
import { droneTick, ev, mediaView } from "./fixtures.test-helpers";

const noop = () => {};

function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

test("sin eventos: explica qué aparecerá, sin inventar estado", () => {
  const html = renderToStaticMarkup(<TimelinePanel events={[]} media={[]} />);
  // Sin barra de título propia (la pestaña de afuera ya la nombra): el nombre queda accesible.
  assert.match(html, /<section[^>]*aria-label="Línea de tiempo"/);
  assert.doesNotMatch(html, /<h2/);
  assert.match(html, /Todavía no hay eventos/);
  assert.match(html, /role="tablist"/);
  assert.doesNotMatch(html, /<li/);
  // Filtros vacíos ocultos: solo "Todo".
  assert.match(html, />Todo</);
  assert.doesNotMatch(html, />Radio<|>Dron<|>Alertas<|>Videos</);
});

test("feed realista: iconos, severidad con texto, referencias como botones y ráfaga plegada", () => {
  const m2 = mediaView();
  const events = [
    ev({ kind: "alert", severity: "critical", title: "Posible persona atrapada en el segundo piso", detail: "Silueta en ventana lado B (M2 · cuadro 3).", media_id: m2.id }),
    ev({ kind: "comms_alert", severity: "warning", title: "MAYDAY reportado por radio", comm_id: "com_7" }),
    droneTick("mis_1"),
    droneTick("mis_1"),
    droneTick("mis_1"),
    droneTick("mis_1"),
    ev({ kind: "media_received", title: "Video M9 recibido", media_id: "med_desconocido" }),
    ev({ kind: "situation_updated", severity: "notice", title: "Informe de situación actualizado" }),
    ev({ kind: "error", severity: "warning", title: "Falló el análisis de M3", detail: "Se reintentará." }),
  ];
  const html = renderToStaticMarkup(
    <TimelinePanel events={events} media={[m2]} onOpenMedia={noop} onOpenComm={noop} onOpenMission={noop} />,
  );

  // Pestañas con conteos y alerta crítica.
  for (const label of ["Todo", "Alertas", "Videos", "Radio", "Dron"]) assert.match(html, new RegExp(`>${label}<`));
  assert.match(html, /requiere atención/);
  assert.match(html, /aria-label="Línea de tiempo · 9 eventos"/);

  // Severidad con color + icono + texto.
  assert.match(html, /Crítico/);
  assert.match(html, /Advertencia/);
  assert.match(html, /bg-critical-soft/);

  // Referencias: medio conocido como botón, radio como botón, medio inexistente atenuado sin acción.
  assert.match(html, /<button[^>]*aria-label="Abrir Video M2"/);
  assert.match(html, /<button[^>]*aria-label="Abrir la comunicación radial"/);
  assert.match(html, /Medio no disponible/);

  // Cuatro ticks del dron → una fila plegada con aria-expanded.
  assert.match(html, /4 eventos de rutina del dron/);
  assert.match(html, /aria-expanded="false"/);
  assert.equal(count(html, "Dron D1: punto de ruta alcanzado"), 1, "solo se muestra el último dentro de la fila plegada");

  // Hora mono y relativo (TimeAgo muestra la hora absoluta antes de hidratar).
  assert.match(html, /font-mono tabular/);
  assert.match(html, /<time/);

  // Primera carga: nada marcado como nuevo.
  assert.doesNotMatch(html, /data-fresh/);
  assert.doesNotMatch(html, />Nuevo</);
});

test("sin manejadores: las referencias se ven pero no son botones", () => {
  const m2 = mediaView();
  const events = [
    ev({ kind: "media_analyzed", title: "M2 analizado", media_id: m2.id }),
    ev({ kind: "comms", title: "Nueva entrada de radio", comm_id: "com_1" }),
    droneTick("mis_1", { severity: "notice", title: "Dron D1 desplegado" }),
  ];
  const html = renderToStaticMarkup(<TimelinePanel events={events} media={[m2]} />);
  assert.doesNotMatch(html, /aria-label="Abrir/);
  assert.match(html, />M2</);
  assert.match(html, />Radio</);
  assert.match(html, />Misión</);
});

test("200 eventos: se renderiza paginado y con ráfagas agrupadas", () => {
  const events = Array.from({ length: 200 }, (_, i) =>
    i % 2 === 0 ? ev({ kind: "comms", title: `Radio ${i}`, comm_id: `c${i}` }) : ev({ kind: "media_received", title: `Medio ${i}` }),
  );
  const started = performance.now();
  const html = renderToStaticMarkup(<TimelinePanel events={events} media={[]} onOpenComm={noop} />);
  const ms = performance.now() - started;
  assert.equal(count(html, "data-event-id="), 80);
  assert.match(html, /Mostrar 80 más \(120 ocultos\)/);
  assert.match(html, /aria-label="Línea de tiempo · 200 eventos"/);
  assert.ok(ms < 2000, `render de 200 eventos tardó ${ms.toFixed(0)} ms`);
});

test("texto compacto: título y detalle en 2 líneas", () => {
  const events = [
    ev({ kind: "scene_updated", title: "Reconstrucción de la escena actualizada", detail: "Casa de 1 piso al centro." }),
    ev({ kind: "situation_updated", severity: "warning", title: "Situación: posible persona atrapada", detail: "Personas atrapadas: posible. Indicio sin corroborar" }),
    ev({ kind: "media_received", severity: "notice", title: "Nuevo video de vecino — M7", detail: "Nota: hay personas adentro" }),
  ];
  const html = renderToStaticMarkup(<TimelinePanel events={events} media={[]} />);
  assert.equal(count(html, "line-clamp-2"), 6);
  // La advertencia se lee con texto, pero sin caja ni fondo tintado en la fila.
  assert.match(html, /Advertencia/);
  assert.doesNotMatch(html, /bg-warning-soft/);
});
