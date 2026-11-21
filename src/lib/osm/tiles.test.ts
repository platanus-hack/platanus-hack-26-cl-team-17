import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toLocal } from "@/lib/geo";
import { tilePointToLatLng, tilesCovering, tilesToContext, type RawTile } from "./tiles";

const origin = { lat: -33.4568, lng: -70.59169 };

describe("teselas OSM", () => {
  it("cubre el radio con teselas z14 que contienen el origen", () => {
    const tiles = tilesCovering(origin, 350);
    assert.ok(tiles.length >= 1 && tiles.length <= 4);
    assert.ok(tiles.every((t) => t.z === 14));
  });

  it("convierte a ENU, filtra por radio y nombra los tramos por cercanía", () => {
    const [tile] = tilesCovering(origin, 1);
    // Punto de tesela que cae en el origen (aprox.) para armar geometría a su alrededor.
    const n = 2 ** tile.z;
    const ox = ((origin.lng + 180) / 360) * n - tile.x;
    const s = Math.sin((origin.lat * Math.PI) / 180);
    const oy = ((1 - Math.log((1 + s) / (1 - s)) / (2 * Math.PI)) / 2) * n - tile.y;
    const E = 4096;
    const px = (dx: number) => (ox * E) + dx;
    const py = (dy: number) => (oy * E) + dy;
    const raw: RawTile = {
      tile,
      extent: E,
      buildings: [
        { id: "cerca", rings: [[{ x: px(-5), y: py(-5) }, { x: px(5), y: py(-5) }, { x: px(5), y: py(5) }, { x: px(-5), y: py(5) }]], height: 6, minHeight: 0 },
        { id: "lejos", rings: [[{ x: px(3000), y: py(0) }, { x: px(3010), y: py(0) }, { x: px(3010), y: py(10) }]], height: 6, minHeight: 0 },
      ],
      roads: [{ id: "r1", cls: "secondary", name: null, points: [{ x: px(-100), y: py(30) }, { x: px(100), y: py(30) }] }],
      names: [
        { id: "n1", cls: "secondary", name: "Dublé Almeyda", points: [{ x: px(-200), y: py(30) }, { x: px(200), y: py(30) }] },
        { id: "n2", cls: "minor", name: "Otra", points: [{ x: px(-200), y: py(30) }, { x: px(200), y: py(30) }] },
      ],
    };
    const ctx = tilesToContext(origin, [raw], 350);
    assert.deepEqual(ctx.buildings.map((b) => b.id), ["cerca"]);
    assert.equal(ctx.roads[0].name, "Dublé Almeyda");
    // y de tesela hacia abajo = Sur en ENU.
    const expected = toLocal(origin, tilePointToLatLng(tile, E, px(0), py(30)));
    assert.ok(expected.y < 0);
    assert.ok(Math.abs(ctx.roads[0].points[0].y - expected.y) < 0.01);
  });
});
