import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import type { SceneModel } from "@/lib/domain";
import { ScenePlan2D } from "./plan2d";
import { SAMPLE_SCENE } from "./sample-scene";
import { EMPTY_TEXT, LEGEND_TEXT } from "./labels";
import type { Scene3DProps } from "./types";

const incident: Scene3DProps["incident"] = {
  id: "inc-1",
  lat: -33.4569,
  lng: -70.5984,
  type: "structure_fire",
  title: "Incendio en vivienda",
};

const base: Scene3DProps = {
  scene: SAMPLE_SCENE,
  incident,
  media: [],
  missions: [],
  updatedAt: "2026-11-21T12:00:00.000Z",
};

/** Texto visible aproximado (sin etiquetas), para buscar frases que cruzan <tspan>. */
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

test("planta 2D de un incidente estructural: estructura, persona en ventana, fuego, humo, grifo y cámara", () => {
  const html = renderToStaticMarkup(<ScenePlan2D {...base} />);
  const t = text(html);
  assert.ok(html.includes("<svg"), "dibuja un SVG");
  assert.ok(t.includes(LEGEND_TEXT), "leyenda fija de honestidad");
  assert.ok(t.includes("Confianza media"), "confianza global");
  assert.ok(t.includes("Casa afectada"), "rótulo de la estructura");
  assert.ok(t.includes("2 pisos · albañilería"), "pisos y material");
  assert.ok(t.includes("1 persona · ventana 2º piso"), "persona en ventana");
  assert.ok(html.includes('aria-label="1 persona · ventana 2º piso, confianza media"'), "persona accesible por teclado");
  assert.ok(t.includes("Fuego intenso · 2º piso · posterior"), "foco en su piso y costado");
  assert.ok(html.includes('aria-label="Columna de humo"'), "humo");
  assert.ok(t.includes("Grifo esquina"), "grifo con etiqueta");
  assert.ok(t.includes("Puesto de mando"), "puesto de mando");
  assert.ok(html.includes("Cámara del medio M1"), "cámara M1");
  assert.ok(t.includes(" M1 "), "etiqueta M1 visible");
  assert.ok(t.includes("Av. Los Aromos"), "calle con nombre");
  assert.ok(t.includes("Pasaje 3 · bloqueada"), "calle bloqueada");
  assert.ok(t.includes("Cilindros de gas"), "peligro");
  assert.ok(t.includes("Supuestos (2)"), "botón de supuestos con conteo");
  assert.ok(/<polygon[^>]*points="-4,5 4,5 4,-5 -4,-5"/.test(html), "planta de S1 con el frente al sur (y SVG hacia abajo)");
});

test("actualizando: indicador de estado", () => {
  const html = renderToStaticMarkup(<ScenePlan2D {...base} updating />);
  assert.ok(html.includes('role="status"'), "indicador de actualización");
});

test("scene null: estado vacío informativo, sin dibujo", () => {
  const html = renderToStaticMarkup(<ScenePlan2D {...base} scene={null} updatedAt={null} />);
  const t = text(html);
  assert.ok(t.includes(EMPTY_TEXT));
  assert.ok(t.includes(LEGEND_TEXT));
  assert.ok(!html.includes("<polygon"));
  assert.ok(!t.includes("Confianza"));
});

test("selección controlada resalta la entidad; modo compacto no muestra capas ni inspector", () => {
  const html = renderToStaticMarkup(<ScenePlan2D {...base} selection={{ kind: "person", id: "P1" }} />);
  assert.ok(html.includes('aria-pressed="true"'), "la persona queda marcada");
  assert.ok(text(html).includes("Persona en riesgo"), "inspector abierto");
  assert.ok(text(html).includes("M1 · fotograma 4"), "evidencia como chip (fotograma en base 1)");
  const compact = renderToStaticMarkup(<ScenePlan2D {...base} compact selection={{ kind: "person", id: "P1" }} />);
  assert.ok(!text(compact).includes("Persona en riesgo"), "sin inspector en compacto");
  assert.ok(!compact.includes(">Capas<"), "sin panel de capas en compacto");
});

test("datos imperfectos del modelo no rompen el render", () => {
  const broken = {
    structures: [{ id: "", floors: 0, width_m: -1, x: 1e12 }],
    people: [{ status: "trapped", count: 0, structure_id: "X" }],
    fire_zones: [{ structure_id: "nope", radius_m: Number.NaN }],
    cameras: [{ media_ref: "M7", facing_deg: -1 }],
  } as unknown as SceneModel;
  const html = renderToStaticMarkup(<ScenePlan2D {...base} scene={broken} />);
  assert.ok(text(html).includes("Personas atrapadas (cantidad no determinada)"));
  assert.ok(html.includes("M7"));
});
