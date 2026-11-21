import { test } from "node:test";
import assert from "node:assert/strict";
import { SHOWCASE_A } from "@/lib/demo/data-showcase-a";
import { validateShowcase } from "@/lib/demo/validate";

test("Vitrina A valida sin problemas", () => {
  assert.deepEqual(validateShowcase(SHOWCASE_A), []);
});

test("Vitrina A: hechos clave coherentes", () => {
  const s = SHOWCASE_A;
  assert.equal(s.media.length, 4);
  assert.deepEqual(
    s.media.map((m) => m.source),
    ["demo", "demo", "demo", "drone"],
  );
  assert.equal(s.situation.trapped.status, "probable");
  assert.ok(s.situation.trapped.evidence.some((e) => e.ref === "M1" && e.frame >= 0));
  assert.equal(s.comms_analysis.victims.status, "reported");
  assert.deepEqual(s.comms_analysis.codes_interpreted, []);
  assert.ok(s.situation.hazards.some((h) => h.kind === "gas_cylinder" && h.severity === "high"));
  assert.equal(s.scene.structures.filter((x) => x.role === "exposure").length, 2);

  // La persona aparece en el póster solo en los fotogramas que cita el análisis.
  const m1 = s.media[0];
  const cited = new Set(m1.analysis.people.filter((p) => p.status === "at_window_or_balcony").flatMap((p) => p.frame_refs));
  m1.frames.forEach((f, i) => assert.equal(Boolean(f.poster.person), cited.has(i), `M1 fotograma ${i}`));

  // Los cilindros aparecen en los pósters donde el análisis los cita.
  for (const m of s.media) {
    const refs = new Set(m.analysis.hazards.filter((h) => h.kind === "gas_cylinder").flatMap((h) => h.frame_refs));
    m.frames.forEach((f, i) => {
      if (refs.has(i)) assert.ok(f.poster.extras?.includes("gas_cylinders"), `cilindros en fotograma ${i}`);
    });
  }

  // Dron: cámara sobre la órbita de la misión.
  const drone = s.media[3];
  assert.equal(Math.round(Math.hypot(drone.camera.x, drone.camera.y)), s.mission?.radius_m);
  assert.equal(drone.drone_alt_m, s.mission?.altitude_m);
});
