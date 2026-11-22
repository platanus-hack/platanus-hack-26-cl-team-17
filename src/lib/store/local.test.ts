/**
 * Store local: suite compartida del contrato + pruebas propias (persistencia en
 * db.json, rutas de archivos, firma de subida local).
 *   node --import tsx --test src/lib/store/local.test.ts
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { sha256Hex } from "../ids";
import { createLocalStore, flushLocalStore, resetLocalStoreCache } from "./local";
import {
  LocalPathError,
  createLocalFiles,
  isSafeStoragePath,
  localFilesRoot,
  resolveLocalPath,
  signLocalUpload,
  verifyLocalUpload,
} from "./local-files";
import { runStoreContract } from "./store-contract";
import type { Store } from "./types";

// La configuración se lee en cada llamada (getters): basta con fijarla antes de crear el store.
delete process.env.DATABASE_URL;
delete process.env.GCS_BUCKET;
process.env.VIGIA_FILE_SECRET = "secreto-de-prueba";

const createdDirs: string[] = [];
function freshDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vigia-local-store-"));
  createdDirs.push(dir);
  process.env.VIGIA_DATA_DIR = dir;
  return dir;
}

after(async () => {
  await flushLocalStore();
  for (const dir of createdDirs) fs.rmSync(dir, { recursive: true, force: true });
});

runStoreContract("local", async () => {
  freshDataDir();
  const harness = {
    store: createLocalStore(),
    // Cada prueba parte con una carpeta de datos nueva y un store nuevo (sin estado compartido).
    async reset() {
      await flushLocalStore();
      freshDataDir();
      harness.store = createLocalStore();
    },
    async teardown() {
      await flushLocalStore();
    },
  };
  return harness;
});

describe("store local: persistencia", () => {
  it("escribe db.json de forma atómica y lo recarga con los contadores intactos", async () => {
    const dir = freshDataDir();
    const store: Store = createLocalStore();
    const inc = await store.createIncident({
      type: "vehicle_collision",
      title: "Colisión",
      address: "Ruta 68",
      lat: -33.4,
      lng: -70.8,
      description: "",
      origin: "command",
      verified: true,
    });
    const media = await store.createMedia({
      incident_id: inc.id,
      source: "citizen",
      kind: "video",
      upload_token_hash: sha256Hex("tok"),
    });
    await store.addComm({ incident_id: inc.id, text: "uno", speaker: "", channel: "", source: "manual" });
    await store.createMission({
      incident_id: inc.id,
      mode: "device",
      pattern: "orbit",
      radius_m: 60,
      altitude_m: 45,
      speed_ms: 8,
      home_lat: -33.41,
      home_lng: -70.8,
      waypoints: [],
      ingest_token_hash: sha256Hex("ingesta"),
    });
    assert.equal(await store.acquireLock(inc.id, "fusion", 60), true);

    await flushLocalStore();
    const file = path.join(dir, "db.json");
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { version: number; incidents: unknown[] };
    assert.equal(raw.version, 1);
    assert.equal(raw.incidents.length, 1);
    assert.deepEqual(
      fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")),
      [],
      "no quedan temporales",
    );

    // Simula reiniciar el proceso: se descarta la memoria y se relee db.json.
    await resetLocalStoreCache();
    const reloaded = createLocalStore();
    const again = await reloaded.getIncident(inc.id);
    assert.deepEqual(again, await store.getIncident(inc.id));
    assert.equal(again?.rev, inc.rev + 3);
    assert.equal(await reloaded.verifyUploadToken(media.id, sha256Hex("tok")), true);
    const m2 = await reloaded.createMedia({ incident_id: inc.id, source: "responder", kind: "photo" });
    assert.equal(m2.label, "M2");
    const c2 = await reloaded.addComm({ incident_id: inc.id, text: "dos", speaker: "", channel: "", source: "manual" });
    assert.equal(c2.seq, 2);
    const d2 = await reloaded.createMission({
      incident_id: inc.id,
      mode: "device",
      pattern: "hover",
      radius_m: 20,
      altitude_m: 30,
      speed_ms: 5,
      home_lat: -33.41,
      home_lng: -70.8,
      waypoints: [],
      ingest_token_hash: sha256Hex("otra"),
    });
    assert.equal(d2.label, "D2");
    // Los candados viven en memoria: un reinicio los libera.
    assert.equal(await reloaded.acquireLock(inc.id, "fusion", 60), true);
  });

  it("un db.json dañado se respalda y se parte de cero", async () => {
    const dir = freshDataDir();
    fs.writeFileSync(path.join(dir, "db.json"), "{ esto no es json", "utf8");
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      const store = createLocalStore();
      assert.deepEqual(await store.listIncidents(), []);
    } finally {
      console.warn = warn;
    }
    assert.ok(fs.readdirSync(dir).some((f) => f.startsWith("db.json.corrupto-")));
  });

  it("los parches no pisan campos protegidos aunque lleguen claves de más", async () => {
    freshDataDir();
    const store = createLocalStore();
    const inc = await store.createIncident({
      type: "other",
      title: "x",
      address: "",
      lat: 0,
      lng: 0,
      description: "",
      origin: "command",
      verified: false,
    });
    const hostile = { title: "y", id: "otro", code: "VG-XXXX", share_key: "k", rev: 999 } as unknown as Parameters<
      Store["updateIncident"]
    >[1];
    const updated = await store.updateIncident(inc.id, hostile);
    assert.equal(updated.title, "y");
    assert.equal(updated.id, inc.id);
    assert.equal(updated.code, inc.code);
    assert.equal(updated.share_key, inc.share_key);
    assert.equal(updated.rev, inc.rev + 1);
  });

  it("devuelve copias: mutar el resultado no altera el store", async () => {
    freshDataDir();
    const store = createLocalStore();
    const inc = await store.createIncident({
      type: "other",
      title: "original",
      address: "",
      lat: 0,
      lng: 0,
      description: "",
      origin: "command",
      verified: false,
    });
    inc.title = "cambiado";
    inc.pipeline.fusion_status = "error";
    const fresh = await store.getIncident(inc.id);
    assert.equal(fresh?.title, "original");
    assert.equal(fresh?.pipeline.fusion_status, "idle");
  });
});

describe("archivos locales: rutas", () => {
  const id = randomUUID();
  const good = `incidents/${id}/media/${randomUUID()}/frames/000.jpg`;

  it("acepta rutas de la convención y quedan dentro de <data>/files", () => {
    freshDataDir();
    const abs = resolveLocalPath(good);
    const root = localFilesRoot();
    assert.ok(abs.startsWith(root + path.sep));
    assert.equal(path.relative(root, abs).split(path.sep).join("/"), good);
    assert.equal(isSafeStoragePath(good), true);
  });

  const bad: [string, string][] = [
    ["../etc/passwd", "sube un nivel"],
    ["incidents/../../etc/passwd", "sube en medio"],
    [`incidents/${id}/..`, ".. al final"],
    ["/etc/passwd", "absoluta"],
    ["//etc/passwd", "absoluta doble"],
    ["C:/Windows/system.ini", "unidad de Windows"],
    ["incidents\\..\\..\\x", "barra invertida"],
    ["%2e%2e/%2e%2e/etc/passwd", "codificada"],
    ["incidents/%2e%2e/x.jpg", "codificada en medio"],
    ["incidents/..%2fx.jpg", "barra codificada"],
    ["incidents/x\u0000.jpg", "byte nulo"],
    ["incidents//x.jpg", "segmento vacío"],
    ["./incidents/x.jpg", "punto inicial"],
    ["incidents/./x.jpg", "punto en medio"],
    ["incidents/.hidden", "oculto"],
    ["", "vacía"],
    ["incidents/x.jpg/", "barra final"],
    [`a/${"b/".repeat(20)}c.jpg`, "demasiados segmentos"],
    [`incidents/${"x".repeat(600)}.jpg`, "demasiado larga"],
  ];
  for (const [p, why] of bad) {
    it(`rechaza: ${why}`, () => {
      assert.equal(isSafeStoragePath(p), false);
      assert.throws(() => resolveLocalPath(p), LocalPathError);
    });
  }

  it("rechaza valores que no son string", () => {
    assert.equal(isSafeStoragePath(undefined), false);
    assert.equal(isSafeStoragePath(42), false);
    assert.equal(isSafeStoragePath(["incidents", "x.jpg"]), false);
  });

  it("las operaciones de archivo también rechazan traversal", async () => {
    freshDataDir();
    const files = createLocalFiles();
    await assert.rejects(files.upload("../fuera.jpg", new Uint8Array([1]), "image/jpeg"), LocalPathError);
    await assert.rejects(files.download("../../etc/passwd"), LocalPathError);
    await assert.rejects(files.createUploadTarget("/abs.jpg", "image/jpeg"), LocalPathError);
    await assert.rejects(files.remove(["incidents/../../x"]), LocalPathError);
    assert.equal(await files.exists("../x"), false);
  });
});

describe("archivos locales: firma de subida", () => {
  const p = `incidents/${randomUUID()}/media/${randomUUID()}/video.mp4`;
  const future = Math.floor(Date.now() / 1000) + 600;

  it("firma válida", () => {
    const sig = signLocalUpload(p, future, "video/mp4");
    assert.match(sig, /^[0-9a-f]{64}$/);
    assert.equal(verifyLocalUpload(p, future, sig, "video/mp4"), true);
    // Solo se toleran mayúsculas y espacios en los extremos.
    assert.equal(verifyLocalUpload(p, future, sig, "  Video/MP4 "), true);
  });

  it("firma alterada, de otra ruta o con otro vencimiento", () => {
    const sig = signLocalUpload(p, future, "video/mp4");
    const flipped = (sig[0] === "a" ? "b" : "a") + sig.slice(1);
    assert.equal(verifyLocalUpload(p, future, flipped, "video/mp4"), false);
    assert.equal(verifyLocalUpload(p, future, sig.slice(0, 63), "video/mp4"), false);
    assert.equal(verifyLocalUpload(p, future, "", "video/mp4"), false);
    assert.equal(verifyLocalUpload(p.replace("video.mp4", "video.webm"), future, sig, "video/mp4"), false);
    assert.equal(verifyLocalUpload(p, future + 1, sig, "video/mp4"), false);
    assert.equal(verifyLocalUpload(p, Number.NaN, sig, "video/mp4"), false);
  });

  it("firma vencida", () => {
    const past = Math.floor(Date.now() / 1000) - 1;
    const sig = signLocalUpload(p, past, "video/mp4");
    assert.equal(verifyLocalUpload(p, past, sig, "video/mp4"), false);
    // La misma firma vale antes del vencimiento.
    assert.equal(verifyLocalUpload(p, past, sig, "video/mp4", (past - 10) * 1000), true);
  });

  it("Content-Type distinto al firmado", () => {
    const sig = signLocalUpload(p, future, "video/mp4");
    assert.equal(verifyLocalUpload(p, future, sig, "video/webm"), false);
    assert.equal(verifyLocalUpload(p, future, sig, "text/html"), false);
    assert.equal(verifyLocalUpload(p, future, sig, null), false);
    assert.equal(verifyLocalUpload(p, future, sig, "video/mp4; codecs=avc1"), false);
  });

  it("otro secreto invalida la firma", () => {
    const sig = signLocalUpload(p, future, "video/mp4");
    const prev = process.env.VIGIA_FILE_SECRET;
    process.env.VIGIA_FILE_SECRET = "otro-secreto";
    try {
      assert.equal(verifyLocalUpload(p, future, sig, "video/mp4"), false);
    } finally {
      process.env.VIGIA_FILE_SECRET = prev;
    }
  });

  it("createUploadTarget emite un PUT firmado que verifica", async () => {
    freshDataDir();
    const target = await createLocalFiles().createUploadTarget(p, "video/mp4");
    assert.equal(target.method, "PUT");
    assert.deepEqual(target.headers, { "content-type": "video/mp4" });
    const url = new URL(target.url, "http://localhost");
    assert.equal(url.pathname, `/api/local-upload/${p}`);
    const exp = Number(url.searchParams.get("exp"));
    const sig = url.searchParams.get("sig") ?? "";
    const now = Date.now() / 1000;
    assert.ok(exp > now + 14 * 60 && exp <= now + 15 * 60 + 1, "vence en ~15 min");
    assert.equal(verifyLocalUpload(decodeURIComponent(url.pathname.slice("/api/local-upload/".length)), exp, sig, "video/mp4"), true);
    assert.equal(verifyLocalUpload(p, exp, sig, "image/jpeg"), false);
  });

  it("createUploadTarget rechaza Content-Type con saltos de línea", async () => {
    freshDataDir();
    await assert.rejects(createLocalFiles().createUploadTarget(p, "video/mp4\r\nX-Evil: 1"));
  });
});
