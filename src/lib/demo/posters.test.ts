/**
 * Pruebas de los pósters SVG de demostración: determinismo, marca de agua,
 * escape de texto, ausencia de referencias externas y tamaño acotado.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { POSTER_WATERMARK, escapeXml, renderPoster } from "./posters";
import type { PosterSpec, PosterView } from "./types";

const VIEWS: PosterView[] = ["front", "side", "rear", "corner", "aerial"];
const SCENES: PosterSpec["scene"][] = ["structure", "collision"];
const ALL_EXTRAS: NonNullable<PosterSpec["extras"]> = [
  "gas_cylinders",
  "power_lines",
  "hydrant",
  "fuel_spill",
  "fire_engine",
  "traffic_queue",
  "crowd",
  "roof_damage",
];

function fullSpec(over: Partial<PosterSpec> = {}): PosterSpec {
  return {
    scene: "structure",
    view: "front",
    caption: "M1 · Vecino · vereda de enfrente",
    clock: "14:32:07",
    floors: 2,
    building: "house",
    fire: { floor: 2, position: "right", intensity: "heavy" },
    smoke: { color: "black", volume: "heavy", position: "right" },
    person: { floor: 2, position: "left", balcony: false },
    exposures: { left: true, right: true },
    vehicles: [
      { kind: "car", state: "overturned", x: 0.3, tag: "V1 · volcado" },
      { kind: "suv_pickup", state: "crushed", x: 0.55, tag: "V2" },
      { kind: "truck", state: "burning", x: 0.8, burning: true, tag: "V3 · camión" },
    ],
    extras: [...ALL_EXTRAS],
    street: "Avenida Irarrázaval",
    variant: 3,
    ...over,
  };
}

/** Quita el único "http" legítimo: el espacio de nombres SVG. */
function withoutXmlns(svg: string): string {
  return svg.replace(' xmlns="http://www.w3.org/2000/svg"', "");
}

function assertSafe(svg: string, label: string): void {
  const body = withoutXmlns(svg);
  assert.ok(!/http/i.test(body), `${label}: contiene "http"`);
  assert.ok(!/<script/i.test(body), `${label}: contiene <script`);
  assert.ok(!/foreignObject/i.test(body), `${label}: contiene foreignObject`);
  assert.ok(!/href=/i.test(body), `${label}: contiene href=`);
  assert.ok(!/url\((?!#)/i.test(body), `${label}: url() que no apunta a un id interno`);
  assert.ok(!/@import/i.test(body), `${label}: @import`);
}

describe("renderPoster", () => {
  it("es determinista y varía con variant", () => {
    const a = renderPoster(fullSpec());
    const b = renderPoster(fullSpec());
    assert.equal(a, b);
    assert.notEqual(a, renderPoster(fullSpec({ variant: 4 })));
  });

  it("produce un documento SVG 1280×720 con viewBox y xmlns", () => {
    const svg = renderPoster(fullSpec());
    assert.match(svg, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<svg /);
    assert.match(svg, /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="1280" height="720" viewBox="0 0 1280 720"/);
    assert.ok(svg.endsWith("</svg>"));
  });

  it("lleva la marca de agua, el rótulo, el reloj y la marca de esquina", () => {
    const svg = renderPoster(fullSpec());
    assert.equal(POSTER_WATERMARK, "IMAGEN DE DEMOSTRACIÓN — NO ES VIDEO REAL");
    assert.ok(svg.split(POSTER_WATERMARK).length - 1 >= 2, "la advertencia debe aparecer en diagonal y en la banda");
    assert.ok(svg.includes("VIGÍA · DEMO"));
    assert.ok(svg.includes("M1 · Vecino · vereda de enfrente"));
    assert.ok(svg.includes("14:32:07"));
    assert.ok(svg.includes("Avenida Irarrázaval"));
    assert.ok(svg.includes("V1 · volcado"));
    assert.ok(svg.includes("VISTA FRONTAL"));
  });

  it("escapa el texto del descriptor", () => {
    const svg = renderPoster(
      fullSpec({
        caption: `<script>alert("x")</script> & 'y'`,
        street: `Calle <b>&"'`,
        clock: "<12>",
        vehicles: [{ kind: "car", state: "upright", x: 0.5, tag: "<img src=x>" }],
      }),
    );
    assert.ok(svg.includes("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &apos;y&apos;"));
    assert.ok(svg.includes("Calle &lt;b&gt;&amp;&quot;&apos;"));
    assert.ok(svg.includes("&lt;12&gt;"));
    assert.ok(svg.includes("&lt;img src=x&gt;"));
    assertSafe(svg, "texto hostil");
    assert.ok(!svg.includes("<b>"));
    assert.ok(!svg.includes("<img"));
  });

  it("escapeXml cubre los cinco caracteres y quita controles", () => {
    assert.equal(escapeXml(`<a href="x">&'</a>\u0001`), "&lt;a href=&quot;x&quot;&gt;&amp;&apos;&lt;/a&gt;");
  });

  it("dibuja todas las vistas × escenas, edificios y pisos sin referencias externas", () => {
    let max = 0;
    let count = 0;
    for (const scene of SCENES) {
      for (const view of VIEWS) {
        for (const building of ["house", "apartment"] as const) {
          for (let floors = 1; floors <= 6; floors++) {
            for (const variant of [0, 7]) {
              const spec = fullSpec({
                scene,
                view,
                building,
                floors,
                variant,
                fire: { floor: floors, position: variant ? "left" : "center", intensity: "heavy" },
                person: { floor: Math.min(3, floors), position: "right", balcony: variant === 7 },
              });
              const svg = renderPoster(spec);
              const label = `${scene}/${view}/${building}/${floors}/${variant}`;
              assert.ok(svg.includes(POSTER_WATERMARK), label);
              assert.ok(!svg.includes("NaN"), `${label}: NaN`);
              assert.ok(!svg.includes("undefined"), `${label}: undefined`);
              assert.ok(!svg.includes("Infinity"), `${label}: Infinity`);
              assertSafe(svg, label);
              max = Math.max(max, Buffer.byteLength(svg, "utf8"));
              count++;
            }
          }
        }
      }
    }
    assert.equal(count, 2 * 5 * 2 * 6 * 2);
    assert.ok(max < 40_000, `póster más pesado: ${max} bytes`);
  });

  it("acepta descriptores mínimos y valores fuera de rango", () => {
    const minimal: PosterSpec = { scene: "structure", view: "side", caption: "M2", clock: "09:00:00", variant: 0 };
    const svg = renderPoster(minimal);
    assert.ok(svg.includes(POSTER_WATERMARK));
    assertSafe(svg, "mínimo");

    const odd = renderPoster(
      fullSpec({
        floors: 40,
        fire: { floor: 99, position: "center", intensity: "none" },
        smoke: { color: "none", volume: "heavy", position: "left" },
        person: { floor: -3, position: "center" },
        vehicles: [{ kind: "bicycle", state: "unknown", x: Number.NaN }, { kind: "motorcycle", state: "on_side", x: 7 }],
        variant: Number.NaN,
      }),
    );
    assert.ok(!odd.includes("NaN"));
    assert.equal(odd, renderPoster(fullSpec({
      floors: 40,
      fire: { floor: 99, position: "center", intensity: "none" },
      smoke: { color: "none", volume: "heavy", position: "left" },
      person: { floor: -3, position: "center" },
      vehicles: [{ kind: "bicycle", state: "unknown", x: Number.NaN }, { kind: "motorcycle", state: "on_side", x: 7 }],
      variant: Number.NaN,
    })));
  });

  it("dibuja cada tipo y estado de vehículo en cada vista", () => {
    const kinds = ["car", "suv_pickup", "van", "truck", "bus", "motorcycle", "bicycle", "trailer", "other"] as const;
    const states = ["upright", "on_side", "overturned", "crushed", "burning", "unknown"] as const;
    for (const view of VIEWS) {
      const vehicles = kinds.flatMap((kind, i) =>
        states.map((state, j) => ({ kind, state, x: ((i * states.length + j) % 10) / 10, tag: `${kind}-${state}` })),
      );
      const svg = renderPoster(fullSpec({ scene: "collision", view, vehicles, extras: [] }));
      assert.ok(!svg.includes("NaN"), view);
      for (const k of kinds) assert.ok(svg.includes(`${k}-upright`), `${view}: ${k}`);
      assertSafe(svg, `vehículos/${view}`);
    }
  });

  it("cubre los colores y volúmenes de humo e intensidades de fuego", () => {
    const outputs = new Set<string>();
    for (const color of ["white", "gray", "black", "brown", "yellow", "unknown"] as const) {
      for (const volume of ["light", "moderate", "heavy"] as const) {
        for (const intensity of ["light", "moderate", "heavy"] as const) {
          const svg = renderPoster(fullSpec({ smoke: { color, volume, position: "center" }, fire: { floor: 1, position: "left", intensity } }));
          assert.ok(svg.includes('filter="url(#bl)"'));
          outputs.add(svg);
        }
      }
    }
    assert.equal(outputs.size, 6 * 3 * 3);
  });
});
