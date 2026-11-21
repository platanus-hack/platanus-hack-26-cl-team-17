import { test } from "node:test";
import assert from "node:assert/strict";
import { toLatLng } from "@/lib/geo";
import {
  buildSurroundingsMesh,
  buildingHeights,
  buildingPath,
  clipRingToTile,
  excludeInferred,
  polygonsOverlap,
  signedArea,
  tilePointToLatLng,
  tilePointToLocal,
  tilesCovering,
  tilesToSurroundings,
  type EnvBuilding,
  type TileContent,
  type TileId,
} from "./surroundings";

const near = (a: number, b: number, eps: number) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);
const ORIGIN = { lat: -33.4568, lng: -70.59169 };
const EXTENT = 4096;

/** Inversa de tilePointToLatLng para armar datos sintéticos (coordenadas de tesela). */
function latLngToTilePoint(tile: TileId, p: { lat: number; lng: number }) {
  const n = 2 ** tile.z;
  const x = ((p.lng + 180) / 360) * n;
  const s = Math.sin((p.lat * Math.PI) / 180);
  const y = ((1 - Math.log((1 + s) / (1 - s)) / (2 * Math.PI)) / 2) * n;
  return { x: (x - tile.x) * EXTENT, y: (y - tile.y) * EXTENT };
}

/** Rectángulo en ENU (m) → anillo de tesela. */
function rectRing(tile: TileId, x0: number, y0: number, x1: number, y1: number) {
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ].map(([x, y]) => latLngToTilePoint(tile, toLatLng(ORIGIN, { x, y })));
}

function homeTile(): TileId {
  return tilesCovering(ORIGIN, 1)[0];
}

function rectBuilding(x0: number, y0: number, x1: number, y1: number, height = 6): EnvBuilding {
  const outer = [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
  return { outer, outerCut: [false, false, false, false], holes: [], holesCut: [], height, minHeight: 0, center: { x: (x0 + x1) / 2, y: (y0 + y1) / 2 } };
}

test("tilesCovering: el origen queda en una de las teselas y 350 m piden entre 1 y 4", () => {
  const tiles = tilesCovering(ORIGIN, 350, 14);
  assert.ok(tiles.length >= 1 && tiles.length <= 4, `${tiles.length} teselas`);
  assert.ok(tiles.every((t) => t.z === 14));
  // Dublé Almeyda 2847 cae en la tesela 14/4979/9809 (verificado contra OpenFreeMap).
  assert.ok(tiles.some((t) => t.x === 4979 && t.y === 9809));
});

test("tilePointToLocal: la esquina NO de la tesela y el origen coinciden con la inversa", () => {
  const t = homeTile();
  const nw = tilePointToLatLng(t, EXTENT, 0, 0);
  const se = tilePointToLatLng(t, EXTENT, EXTENT, EXTENT);
  assert.ok(nw.lat > se.lat && nw.lng < se.lng, "y de tesela crece hacia el Sur");
  const o = latLngToTilePoint(t, ORIGIN);
  const local = tilePointToLocal(ORIGIN, t, EXTENT, o.x, o.y);
  near(local.x, 0, 0.01);
  near(local.y, 0, 0.01);
  const p = latLngToTilePoint(t, toLatLng(ORIGIN, { x: 120, y: -80 }));
  const q = tilePointToLocal(ORIGIN, t, EXTENT, p.x, p.y);
  near(q.x, 120, 0.05);
  near(q.y, -80, 0.05);
});

test("clipRingToTile recorta al borde y marca los lados de recorte", () => {
  const ring = [
    { x: -100, y: 100 },
    { x: 200, y: 100 },
    { x: 200, y: 300 },
    { x: -100, y: 300 },
  ];
  const r = clipRingToTile(ring, EXTENT);
  assert.ok(r);
  assert.ok(r.pts.every((p) => p.x >= 0 && p.x <= EXTENT && p.y >= 0 && p.y <= EXTENT));
  near(Math.abs(signedArea(r.pts)), 200 * 200, 1e-6);
  assert.equal(r.cut.filter(Boolean).length, 1, "solo el lado sobre x = 0 es de recorte");
  assert.equal(clipRingToTile([{ x: -50, y: -50 }, { x: -10, y: -50 }, { x: -10, y: -10 }], EXTENT), null);
});

test("buildingHeights: valores por defecto y altura mínima", () => {
  assert.deepEqual(buildingHeights(undefined, undefined), { height: 6, minHeight: 0 });
  assert.deepEqual(buildingHeights(0, 0), { height: 6, minHeight: 0 });
  assert.deepEqual(buildingHeights(24, 3), { height: 24, minHeight: 3 });
  assert.deepEqual(buildingHeights(10, 12), { height: 10, minHeight: 0 });
});

test("tilesToSurroundings: convierte a ENU, orienta antihorario y recorta al radio", () => {
  const t = homeTile();
  const ring = (x0: number, y0: number, x1: number, y1: number) => {
    const pts = rectRing(t, x0, y0, x1, y1);
    return { pts, cut: pts.map(() => false) };
  };
  const tile: TileContent = {
    tile: t,
    extent: EXTENT,
    buildings: [
      { rings: [ring(20, 20, 30, 35)], height: 9, minHeight: 0 },
      { rings: [ring(500, 500, 510, 510)], height: 6, minHeight: 0 },
    ],
    roads: [rectRing(t, -40, 0, 40, 0).slice(0, 2), rectRing(t, 800, 800, 900, 800).slice(0, 2)],
  };
  const env = tilesToSurroundings(ORIGIN, [tile], 350);
  assert.equal(env.buildings.length, 1, "el edificio a ~700 m queda fuera");
  const b = env.buildings[0];
  assert.ok(signedArea(b.outer) > 0, "exterior antihorario");
  near(b.center.x, 25, 0.1);
  near(b.center.y, 27.5, 0.1);
  near(Math.abs(signedArea(b.outer)), 150, 0.5);
  assert.equal(env.roadSegments.length, 4, "solo el tramo cercano");
  near(env.roadSegments[0], -40, 0.1);
});

test("polygonsOverlap: contenido, cruce y separados", () => {
  const sq = (x: number, y: number, s: number) => rectBuilding(x, y, x + s, y + s).outer;
  assert.ok(polygonsOverlap(sq(0, 0, 10), sq(2, 2, 3)), "uno dentro del otro");
  assert.ok(polygonsOverlap(sq(0, 0, 10), sq(8, 8, 10)), "esquinas superpuestas");
  assert.ok(polygonsOverlap(sq(0, 4, 10), [{ x: 4, y: -5 }, { x: 6, y: -5 }, { x: 6, y: 20 }, { x: 4, y: 20 }]), "cruz sin vértices adentro");
  assert.ok(!polygonsOverlap(sq(0, 0, 10), sq(20, 0, 5)));
});

test("excludeInferred: quita lo que pisa una estructura inferida (con margen) o el origen", () => {
  const buildings = [
    rectBuilding(-5, -5, 5, 5), // contiene el origen
    rectBuilding(30, 0, 40, 10), // bajo la estructura inferida
    rectBuilding(52.5, 0, 60, 10), // a 1,5 m de la estructura: cae dentro del margen de 2 m
    rectBuilding(56, 0, 66, 10), // a 5 m: se queda
    rectBuilding(-60, -60, -50, -50), // lejos: se queda
  ];
  const structure = { x: 45, y: 5, width: 12, depth: 10, rotationDeg: 0 };
  const kept = excludeInferred(buildings, [structure], 2);
  assert.deepEqual(
    kept.map((b) => b.center),
    [
      { x: 61, y: 5 },
      { x: -55, y: -55 },
    ],
  );
  assert.equal(excludeInferred(buildings, [], 2).length, 4, "sin estructuras solo se quita el del origen");
});

test("buildSurroundingsMesh: muros hacia afuera, techo hacia arriba y sin muros de recorte", () => {
  const b = rectBuilding(0, 0, 10, 8, 6);
  const m = buildSurroundingsMesh([b]);
  // 4 muros × 2 triángulos + techo de 2 triángulos = 10 triángulos.
  assert.equal(m.positions.length, 10 * 9);
  assert.equal(m.edges.length, 4 * 6);
  const normal = (o: number) => {
    const p = m.positions;
    const ax = p[o + 3] - p[o], ay = p[o + 4] - p[o + 1], az = p[o + 5] - p[o + 2];
    const bx = p[o + 6] - p[o], by = p[o + 7] - p[o + 1], bz = p[o + 8] - p[o + 2];
    return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
  };
  // Primer muro: lado Sur (y = 0, de x = 0 a x = 10) → normal hacia el Sur = +Z en three.js.
  const n0 = normal(0);
  assert.ok(n0[2] > 0 && Math.abs(n0[0]) < 1e-9);
  for (let t = 8; t < 10; t++) assert.ok(normal(t * 9)[1] > 0, "techo hacia arriba");
  const cut = { ...b, outerCut: [true, false, false, false] };
  assert.equal(buildSurroundingsMesh([cut]).positions.length, 8 * 9);
});

test("buildingPath: planta SVG con Norte arriba", () => {
  assert.equal(buildingPath(rectBuilding(0, 0, 10, 5)), "M0 0L10 0L10 -5L0 -5Z");
});
