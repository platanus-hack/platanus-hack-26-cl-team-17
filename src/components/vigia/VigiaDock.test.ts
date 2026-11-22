import { test } from "node:test";
import assert from "node:assert/strict";
import { isBriefDroneMessage } from "./VigiaDock";

test("mensaje breve: lo que Vigía comenta del dron va en una línea; respuestas y propuestas, completas", () => {
  assert.equal(isBriefDroneMessage({ evidence: ["D1"], text: "Humo negro por el techo.", kind: "alerta" }), true);
  assert.equal(isBriefDroneMessage({ evidence: [], text: "El dron ve llamas en la cocina.", kind: "resumen" }), true);
  assert.equal(isBriefDroneMessage({ evidence: ["M3", "C12"], text: "Derrame de combustible bajo V1.", kind: "alerta" }), false);
  assert.equal(isBriefDroneMessage({ evidence: ["D1"], text: "Sí, el dron ve a una persona.", kind: "respuesta" }), false);
  assert.equal(isBriefDroneMessage({ evidence: ["D1"], text: "Propongo avisar a 6-3.", kind: "propuesta" }), false);
});
