import { test } from "node:test";
import assert from "node:assert/strict";
import { choosePick, declutter, resolveMode, shouldAnimate, threeDBlockedReason } from "./pose";

test("modo del visor: 3D por defecto, planta en compacto, sin WebGL o tras una falla", () => {
  assert.equal(resolveMode({ compact: false, webgl: true, failed: false, chosen: null }), "3d");
  assert.equal(resolveMode({ compact: true, webgl: true, failed: false, chosen: null }), "2d");
  assert.equal(resolveMode({ compact: true, webgl: true, failed: false, chosen: "3d" }), "3d");
  assert.equal(resolveMode({ compact: false, webgl: false, failed: false, chosen: "3d" }), "2d");
  assert.equal(resolveMode({ compact: false, webgl: true, failed: true, chosen: "3d" }), "2d");
  assert.equal(threeDBlockedReason({ webgl: true, failed: false }), null);
  assert.match(threeDBlockedReason({ webgl: false, failed: false }) ?? "", /WebGL/);
});

test("la animación se pausa con movimiento reducido, pestaña oculta o fuera de pantalla", () => {
  const base = { content: true, reducedMotion: false, pageVisible: true, onScreen: true };
  assert.equal(shouldAnimate(base), true);
  assert.equal(shouldAnimate({ ...base, reducedMotion: true }), false);
  assert.equal(shouldAnimate({ ...base, pageVisible: false }), false);
  assert.equal(shouldAnimate({ ...base, onScreen: false }), false);
  assert.equal(shouldAnimate({ ...base, content: false }), false);
});

test("despeje de etiquetas: la persona en riesgo (fija) nunca se oculta ni se mueve", () => {
  const person = { x: 100, y: 100, w: 80, h: 20, priority: 10, pinned: true };
  const hazard = { x: 105, y: 102, w: 80, h: 20, priority: 90, pinned: false };
  const [p, h] = declutter([person, hazard], { shift: false });
  assert.deepEqual(p, { visible: true, dx: 0, dy: 0 });
  assert.equal(h.visible, false);
  // Con corrimiento, la de menor prioridad busca otro lugar en vez de ocultarse.
  const [, h2] = declutter([person, hazard]);
  assert.equal(h2.visible, true);
  assert.ok(h2.dx !== 0 || h2.dy !== 0);
});

test("clic sobre entidades superpuestas: gana la persona", () => {
  const node = (kind: string, id: string) => ({ userData: { vgPick: { kind, id } }, parent: null });
  const hits = [{ object: node("structure", "S1") }, { object: node("person", "P1") }, { object: node("fire", "F1") }];
  assert.deepEqual(choosePick(hits), { kind: "person", id: "P1" });
  assert.equal(choosePick([{ object: { userData: {}, parent: null } }]), null);
});
