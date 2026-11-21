/**
 * La siembra ancla la escena al mapa si se le inyecta el anclaje, y siembra la escena tal
 * cual si el anclaje falla (sin red).
 *   node --import tsx --test src/lib/demo/anchor-seed.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vigia-demo-anchor-"));
process.env.VIGIA_DATA_DIR = dataDir;
delete process.env.DATABASE_URL;
delete process.env.GCS_BUCKET;
after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

async function deps(anchorScene?: import("./types").DemoDeps["anchorScene"]) {
  const { createLocalStore } = await import("@/lib/store/local");
  const { createLocalFiles } = await import("@/lib/store/local-files");
  return {
    store: createLocalStore(),
    files: createLocalFiles(),
    pipeline: { processMedia: async () => {}, requestFusion: async () => {}, requestCommsAnalysis: async () => {} },
    now: Date.now,
    defer: () => {},
    anchorScene,
  };
}

test("siembra la escena anclada cuando hay anclaje", async () => {
  const { seedShowcase } = await import("./seed");
  const { SHOWCASE_B } = await import("./data-showcase-b");
  const seen: { lat: number; lng: number; type: string }[] = [];
  const d = await deps(async (scene, incident) => {
    seen.push(incident);
    return { ...scene, uncertainty_notes: [...scene.uncertainty_notes, "anclada"] };
  });
  const inc = await seedShowcase(d, SHOWCASE_B);
  assert.deepEqual(seen, [{ lat: SHOWCASE_B.lat, lng: SHOWCASE_B.lng, type: "vehicle_collision" }]);
  assert.equal(inc.scene?.uncertainty_notes.at(-1), "anclada");
});

test("sin red (el anclaje falla) siembra la escena tal cual", async () => {
  const { seedShowcase } = await import("./seed");
  const { SHOWCASE_A } = await import("./data-showcase-a");
  const d = await deps(async () => {
    throw new Error("sin red");
  });
  const inc = await seedShowcase(d, SHOWCASE_A);
  assert.deepEqual(inc.scene, SHOWCASE_A.scene);
});
