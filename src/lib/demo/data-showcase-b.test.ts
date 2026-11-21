import assert from "node:assert/strict";
import { test } from "node:test";
import { SHOWCASE_B } from "./data-showcase-b";
import { validateShowcase } from "./validate";

test("Vitrina B valida sin problemas", () => {
  assert.deepEqual(validateShowcase(SHOWCASE_B), []);
});

test("Vitrina B: atrapamiento confirmado solo por la unidad en el lugar", () => {
  const sit = SHOWCASE_B.situation;
  assert.equal(sit.trapped.status, "confirmed");
  assert.ok(sit.trapped.evidence.some((e) => e.ref === "C5"));
  assert.match(SHOWCASE_B.comms[4].text, /^B-4 a Central, en el lugar/);
  assert.equal(SHOWCASE_B.mission, null);
});
