import assert from "node:assert/strict";
import { test } from "node:test";
import type { FileStorage } from "@/lib/store/types";
import { loadFocusPin, resetFocusCache, resolveFocus, saveFocusPin, SetFocusInputSchema } from "./focus";

const inc = (id: string, created_at: string, status: "active" | "controlled" | "closed" = "active") => ({ id, created_at, status });

const LIST = [
  inc("viejo", "2026-11-21T10:00:00.000Z"),
  inc("controlado", "2026-11-21T11:00:00.000Z", "controlled"),
  inc("cerrado", "2026-11-21T13:00:00.000Z", "closed"),
  inc("nuevo", "2026-11-21T12:00:00.000Z"),
];

/** Storage en memoria: solo lo que usa el foco. */
function memoryFiles(): FileStorage & { data: Map<string, Uint8Array> } {
  const data = new Map<string, Uint8Array>();
  return {
    kind: "local",
    data,
    async upload(path, bytes) {
      data.set(path, bytes);
    },
    async exists(path) {
      return data.has(path);
    },
    async download(path) {
      const bytes = data.get(path);
      if (!bytes) throw new Error("no existe");
      return { bytes, contentType: "application/json" };
    },
    createUploadTarget: () => Promise.reject(new Error("sin uso")),
    getSignedReadUrl: async () => null,
    remove: async () => undefined,
  };
}

test("sin fijar, el foco es la abierta más nueva (las cerradas no cuentan)", () => {
  assert.deepEqual(resolveFocus(LIST, null), { incident_id: "nuevo", pinned: false });
});

test("la fijada manda mientras siga abierta, aunque sea controlada o más vieja", () => {
  assert.deepEqual(resolveFocus(LIST, "viejo"), { incident_id: "viejo", pinned: true });
  assert.deepEqual(resolveFocus(LIST, "controlado"), { incident_id: "controlado", pinned: true });
});

test("una fijada cerrada o que ya no existe vuelve a la automática", () => {
  assert.deepEqual(resolveFocus(LIST, "cerrado"), { incident_id: "nuevo", pinned: false });
  assert.deepEqual(resolveFocus(LIST, "borrado"), { incident_id: "nuevo", pinned: false });
});

test("sin emergencias abiertas no hay foco", () => {
  assert.deepEqual(resolveFocus([inc("cerrado", "2026-11-21T13:00:00.000Z", "closed")], "cerrado"), { incident_id: null, pinned: false });
  assert.deepEqual(resolveFocus([], null), { incident_id: null, pinned: false });
});

test("guardar y leer la fijada; null vuelve a automático", async () => {
  resetFocusCache();
  const files = memoryFiles();
  assert.equal(await loadFocusPin(files, 0), null);
  await saveFocusPin("viejo", { email: "obac@vigia.local" }, files, new Date(10_000));
  resetFocusCache();
  assert.equal(await loadFocusPin(files, 20_000), "viejo");
  await saveFocusPin(null, { email: "obac@vigia.local" }, files, new Date(30_000));
  resetFocusCache();
  assert.equal(await loadFocusPin(files, 40_000), null);
});

test("un archivo dañado se lee como automático", async () => {
  resetFocusCache();
  const files = memoryFiles();
  files.data.set("system/focus.json", new TextEncoder().encode("{no es json"));
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    assert.equal(await loadFocusPin(files, 0), null);
  } finally {
    console.warn = warn;
  }
});

test("la entrada acepta un id o null y rechaza vacíos", () => {
  assert.deepEqual(SetFocusInputSchema.parse({ incident_id: " abc " }), { incident_id: "abc" });
  assert.deepEqual(SetFocusInputSchema.parse({ incident_id: null }), { incident_id: null });
  assert.throws(() => SetFocusInputSchema.parse({ incident_id: "" }));
  assert.throws(() => SetFocusInputSchema.parse({}));
});
