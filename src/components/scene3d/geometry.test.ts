import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fitView,
  footprintCorners,
  fromThree,
  groundSize,
  headingToThree,
  isInsideFootprint,
  localToWorld,
  nearestFacade,
  niceScaleLength,
  pointOnFacade,
  toThree,
  worldToLocal,
  yawForHeading,
  type Bounds,
} from "./geometry";

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);

test("ENU → three.js: x Este, y altura, Norte hacia -Z (y vuelta)", () => {
  assert.deepEqual(toThree(3, 10, 2), [3, 2, -10]);
  assert.deepEqual(fromThree([3, 2, -10]), { x: 3, y: 10, z: 2 });
  const n = headingToThree(0);
  near(n[0], 0);
  near(n[2], -1);
  const e = headingToThree(90);
  near(e[0], 1);
  near(e[2], 0);
});

test("yawForHeading lleva el +Z local al rumbo pedido", () => {
  for (const h of [0, 45, 90, 180, 270, 359]) {
    const yaw = yawForHeading(h);
    // Ry(yaw)·(0,0,1) = (sin yaw, 0, cos yaw)
    const dir = [Math.sin(yaw), 0, Math.cos(yaw)];
    const want = headingToThree(h);
    near(dir[0], want[0]);
    near(dir[2], want[2]);
  }
});

test("planta orientada: fachada al sur, derecha vista desde la calle = Este", () => {
  const fp = { x: 0, y: 0, width: 8, depth: 10, rotationDeg: 180 };
  const [fl, fr, rr, rl] = footprintCorners(fp);
  near(fl.x, -4);
  near(fl.y, -5);
  near(fr.x, 4);
  near(fr.y, -5);
  near(rr.x, 4);
  near(rr.y, 5);
  near(rl.x, -4);
  near(rl.y, 5);
  const back = worldToLocal(fp, localToWorld(fp, 1.5, -2).x, localToWorld(fp, 1.5, -2).y);
  near(back.u, 1.5);
  near(back.v, -2);
  assert.equal(isInsideFootprint(fp, 3.9, 4.9), true);
  assert.equal(isInsideFootprint(fp, 4.5, 0), false);
  assert.equal(isInsideFootprint(fp, 4.5, 0, 1), true);
});

test("pointOnFacade y nearestFacade", () => {
  const fp = { x: 10, y: 20, width: 8, depth: 10, rotationDeg: 0 }; // fachada al norte
  const front = pointOnFacade(fp, "front", 12, 0, 0.5);
  near(front.x, 12);
  near(front.y, 25.5);
  const rear = pointOnFacade(fp, "rear", 100, 0);
  near(rear.x, 13.5); // acotado al largo del muro (4 − 0,5)
  near(rear.y, 15);
  assert.equal(nearestFacade(fp, 10, 24.8), "front");
  // Fachada al norte: quien mira el frente desde la calle (al norte, mirando al sur) tiene el Oeste a su derecha.
  assert.equal(nearestFacade(fp, 13.9, 20), "left");
  assert.equal(nearestFacade(fp, 6.1, 20), "right");
});

const box: Bounds = { minX: -20, maxX: 20, minY: -15, maxY: 15, minZ: 0, maxZ: 8 };

test("fitView en planta: cámara sobre el centro con el Norte arriba", () => {
  const fit = fitView(box, "top", 180, 1.6);
  near(fit.position[0], fit.target[0], 1e-3);
  assert.ok(fit.position[1] > fit.target[1] + 10);
  // levemente al sur (three z mayor) para que el Norte quede arriba en pantalla
  assert.ok(fit.position[2] >= fit.target[2]);
  assert.ok(fit.position[2] - fit.target[2] < 0.5);
});

test("fitView frente/posterior según la fachada principal", () => {
  const front = fitView(box, "front", 180, 1.6);
  assert.ok(front.position[2] > front.target[2], "fachada al sur → cámara al sur (+Z)");
  const rear = fitView(box, "rear", 180, 1.6);
  assert.ok(rear.position[2] < rear.target[2], "posterior → cámara al norte (−Z)");
  const iso = fitView(box, "iso", 180, 1.6);
  assert.ok(iso.position[1] > iso.target[1]);
});

test("fitView: más contenido o pantalla angosta → más distancia; entradas raras no rompen", () => {
  const small = fitView(box, "iso", 0, 1.6);
  const big = fitView({ ...box, minX: -200, maxX: 200 }, "iso", 0, 1.6);
  assert.ok(big.distance > small.distance);
  const narrow = fitView(box, "iso", 0, 0.5);
  assert.ok(narrow.distance > small.distance);
  const weird = fitView(box, "iso", Number.NaN, Number.NaN);
  assert.ok(weird.position.every(Number.isFinite));
});

test("barra de escala y tamaño del suelo", () => {
  assert.equal(niceScaleLength(0.1, 90), 5);
  assert.equal(niceScaleLength(0.25, 90), 20);
  assert.equal(niceScaleLength(0.001, 90), 1);
  const g = groundSize(box, { x: 0, y: 0 });
  assert.ok(g >= 120 && g % 20 === 0);
  assert.equal(groundSize({ ...box, maxX: 1e6 }, { x: 0, y: 0 }), 1200);
});
