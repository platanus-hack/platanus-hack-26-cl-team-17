/**
 * Archivos del modo local: escritura por streaming, Range y las rutas
 * /api/local-upload y /api/files ejecutadas como handlers (modo open, sin Postgres).
 *   node --import tsx --test src/lib/store/local-files.test.ts
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { GET as filesGet, HEAD as filesHead } from "@/app/api/files/[...path]/route";
import { PUT as localUploadPut } from "@/app/api/local-upload/[...path]/route";
import { LIMITS } from "../domain";
import { createLocalStore, flushLocalStore } from "./local";
import {
  LocalUploadError,
  createLocalFiles,
  openLocal,
  parseByteRange,
  signLocalUpload,
  writeLocalStream,
} from "./local-files";
import { storagePaths } from "./types";

delete process.env.DATABASE_URL;
delete process.env.GCS_BUCKET;
process.env.VIGIA_FILE_SECRET = "secreto-de-prueba-archivos";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vigia-local-files-"));
process.env.VIGIA_DATA_DIR = dataDir;

after(async () => {
  // Primero la escritura diferida de db.json; si no, recrearía la carpeta después de borrarla.
  await flushLocalStore();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0xff, 0xd9]);

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function ctxFor(storagePath: string) {
  return { params: Promise.resolve({ path: storagePath.split("/") }) };
}

describe("parseByteRange", () => {
  it("interpreta rangos simples, abiertos y de sufijo", () => {
    assert.equal(parseByteRange(null, 100), null);
    assert.deepEqual(parseByteRange("bytes=0-9", 100), { start: 0, end: 9 });
    assert.deepEqual(parseByteRange("bytes=90-", 100), { start: 90, end: 99 });
    assert.deepEqual(parseByteRange("bytes=-10", 100), { start: 90, end: 99 });
    assert.deepEqual(parseByteRange("bytes=-500", 100), { start: 0, end: 99 });
    assert.deepEqual(parseByteRange("bytes=50-500", 100), { start: 50, end: 99 });
  });
  it("insatisfacible o ignorado", () => {
    assert.equal(parseByteRange("bytes=100-", 100), "unsatisfiable");
    assert.equal(parseByteRange("bytes=-0", 100), "unsatisfiable");
    assert.equal(parseByteRange("bytes=0-", 0), "unsatisfiable");
    assert.equal(parseByteRange("bytes=9-3", 100), null);
    assert.equal(parseByteRange("bytes=0-1,5-6", 100), null);
    assert.equal(parseByteRange("items=0-1", 100), null);
    assert.equal(parseByteRange("bytes=-", 100), null);
  });
});

describe("writeLocalStream y openLocal", () => {
  const p = `incidents/${randomUUID()}/media/${randomUUID()}/frames/000.jpg`;

  it("escribe por partes y lee completo o por rango", async () => {
    const { size } = await writeLocalStream(p, streamOf(JPEG.subarray(0, 2), JPEG.subarray(2)), {
      maxBytes: 100,
      expectedBytes: JPEG.length,
      requireJpeg: true,
    });
    assert.equal(size, JPEG.length);
    const file = await openLocal(p);
    assert.ok(file);
    assert.equal(file.stat.size, JPEG.length);
    assert.equal(file.contentType, "image/jpeg");
    assert.deepEqual(await readAll(file.stream()), JPEG);
    assert.deepEqual(await readAll(file.stream({ start: 2, end: 5 })), JPEG.subarray(2, 6));
    const dir = path.dirname(path.join(dataDir, "files", p));
    assert.deepEqual(
      fs.readdirSync(dir).filter((f) => f.endsWith(".part")),
      [],
    );
  });

  it("rechaza demasiado grande, vacío, incompleto y no-JPEG sin dejar archivos", async () => {
    const q = `incidents/${randomUUID()}/media/${randomUUID()}/frames/001.jpg`;
    const cases: [ReadableStream<Uint8Array>, Parameters<typeof writeLocalStream>[2], string][] = [
      [streamOf(JPEG), { maxBytes: 4 }, "too_large"],
      [streamOf(), { maxBytes: 100 }, "empty"],
      [streamOf(JPEG), { maxBytes: 100, expectedBytes: JPEG.length + 1 }, "incomplete"],
      [streamOf(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), { maxBytes: 100, requireJpeg: true }, "bad_type"],
    ];
    for (const [body, opts, reason] of cases) {
      await assert.rejects(writeLocalStream(q, body, opts), (err: unknown) => {
        assert.ok(err instanceof LocalUploadError);
        assert.equal(err.reason, reason);
        return true;
      });
    }
    assert.equal(await openLocal(q), null);
    const dir = path.dirname(path.join(dataDir, "files", q));
    assert.deepEqual(fs.existsSync(dir) ? fs.readdirSync(dir) : [], []);
  });

  it("openLocal devuelve null para rutas inválidas o inexistentes", async () => {
    assert.equal(await openLocal("../etc/passwd"), null);
    assert.equal(await openLocal(`incidents/${randomUUID()}/nada.jpg`), null);
  });

  it("upload/download/exists/remove", async () => {
    const files = createLocalFiles();
    const q = `incidents/${randomUUID()}/media/${randomUUID()}/frames/002.jpg`;
    assert.equal(await files.exists(q), false);
    await files.upload(q, JPEG, "image/jpeg");
    assert.equal(await files.exists(q), true);
    const got = await files.download(q);
    assert.deepEqual(got.bytes, JPEG);
    assert.equal(got.contentType, "image/jpeg");
    assert.equal(await files.getSignedReadUrl(q, 60), null);
    await files.remove([q, `incidents/${randomUUID()}/no-existe.jpg`]);
    assert.equal(await files.exists(q), false);
    await assert.rejects(files.download(q), (err: unknown) => err instanceof Error && err.name === "StoreNotFoundError");
  });
});

describe("PUT /api/local-upload", () => {
  const incidentId = randomUUID();
  const mediaId = randomUUID();
  const framePath = storagePaths.frame(incidentId, mediaId, 0);
  const videoPath = storagePaths.video(incidentId, mediaId, "mp4");

  async function put(target: { url: string; headers: Record<string, string> }, body: Uint8Array<ArrayBuffer>, headers?: Record<string, string>) {
    const url = new URL(target.url, "http://localhost");
    const storagePath = decodeURIComponent(url.pathname.slice("/api/local-upload/".length));
    const req = new Request(url, { method: "PUT", body, headers: headers ?? target.headers });
    return localUploadPut(req, ctxFor(storagePath));
  }

  it("acepta un fotograma con firma válida y lo guarda", async () => {
    const target = await createLocalFiles().createUploadTarget(framePath, "image/jpeg");
    const res = await put(target, JPEG);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.deepEqual(new Uint8Array(fs.readFileSync(path.join(dataDir, "files", framePath))), JPEG);
  });

  it("acepta el video con el tipo firmado", async () => {
    const target = await createLocalFiles().createUploadTarget(videoPath, "video/mp4");
    const res = await put(target, new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]));
    assert.equal(res.status, 200);
  });

  it("rechaza un Content-Type distinto al firmado (403)", async () => {
    const target = await createLocalFiles().createUploadTarget(videoPath, "video/mp4");
    const res = await put(target, new Uint8Array([1, 2, 3]), { "content-type": "text/html" });
    assert.equal(res.status, 403);
  });

  it("rechaza firma alterada y vencida (403)", async () => {
    const target = await createLocalFiles().createUploadTarget(framePath, "image/jpeg");
    const tampered = { ...target, url: target.url.replace(/sig=([0-9a-f])/, (_, c: string) => `sig=${c === "a" ? "b" : "a"}`) };
    assert.equal((await put(tampered, JPEG)).status, 403);

    const past = Math.floor(Date.now() / 1000) - 5;
    const expired = {
      url: `/api/local-upload/${framePath}?exp=${past}&sig=${signLocalUpload(framePath, past, "image/jpeg")}`,
      headers: { "content-type": "image/jpeg" },
    };
    assert.equal((await put(expired, JPEG)).status, 403);
  });

  it("una firma no sirve para otra ruta", async () => {
    const target = await createLocalFiles().createUploadTarget(framePath, "image/jpeg");
    const other = storagePaths.frame(incidentId, mediaId, 1);
    const url = new URL(target.url, "http://localhost");
    const req = new Request(`http://localhost/api/local-upload/${other}${url.search}`, {
      method: "PUT",
      body: JPEG,
      headers: target.headers,
    });
    assert.equal((await localUploadPut(req, ctxFor(other))).status, 403);
  });

  it("aplica LIMITS: un fotograma de más de MAX_FRAME_BYTES → 413", async () => {
    const target = await createLocalFiles().createUploadTarget(framePath, "image/jpeg");
    const big = new Uint8Array(LIMITS.MAX_FRAME_BYTES + 1);
    big.set(JPEG.subarray(0, 3));
    const res = await put(target, big);
    assert.equal(res.status, 413);
  });

  it("un fotograma que no es JPEG → 400; con tipo de video → 400", async () => {
    const target = await createLocalFiles().createUploadTarget(framePath, "image/jpeg");
    assert.equal((await put(target, new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).status, 400);

    // Firmado con un tipo que no corresponde a un fotograma: la firma calza pero el tipo no.
    const wrongKind = await createLocalFiles().createUploadTarget(framePath, "video/mp4");
    assert.equal((await put(wrongKind, JPEG)).status, 400);
  });

  it("rechaza traversal, rutas fuera de la convención y extensiones no permitidas (400)", async () => {
    for (const segments of [
      ["..", "..", "etc", "passwd"],
      ["incidents", "..", "x.jpg"],
      ["otra", "carpeta", "x.jpg"],
    ]) {
      const req = new Request("http://localhost/api/local-upload/x?exp=1&sig=0", {
        method: "PUT",
        body: JPEG,
        headers: { "content-type": "image/jpeg" },
      });
      const res = await localUploadPut(req, { params: Promise.resolve({ path: segments }) });
      assert.equal(res.status, 400, segments.join("/"));
    }
    const html = `incidents/${incidentId}/media/${mediaId}/pagina.html`;
    const req = new Request(`http://localhost/api/local-upload/${html}?exp=9999999999&sig=0`, {
      method: "PUT",
      body: new Uint8Array([60]),
      headers: { "content-type": "text/html" },
    });
    assert.equal((await localUploadPut(req, ctxFor(html))).status, 400);
  });

  it("con GCS configurado la ruta no existe (404)", async () => {
    const target = await createLocalFiles().createUploadTarget(framePath, "image/jpeg");
    process.env.GCS_BUCKET = "bucket-de-prueba";
    try {
      assert.equal((await put(target, JPEG)).status, 404);
    } finally {
      delete process.env.GCS_BUCKET;
    }
  });
});

describe("GET /api/files (modo local, acceso abierto)", () => {
  let filePath = "";
  let shareKey = "";
  const bytes = new Uint8Array(Array.from({ length: 1000 }, (_, i) => i % 256));

  before(async () => {
    const store = createLocalStore();
    const inc = await store.createIncident({
      type: "structure_fire",
      title: "Prueba",
      address: "",
      lat: 0,
      lng: 0,
      description: "",
      origin: "command",
      verified: true,
    });
    shareKey = inc.share_key;
    filePath = storagePaths.video(inc.id, randomUUID(), "mp4");
    await createLocalFiles().upload(filePath, bytes, "video/mp4");
  });

  const get = (p: string, headers: Record<string, string> = {}, query = "") =>
    filesGet(new Request(`http://localhost/api/files/${p}${query}`, { headers }), ctxFor(p));

  function assertSecurityHeaders(res: Response) {
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'none'.*sandbox/);
    assert.equal(res.headers.get("cross-origin-resource-policy"), "same-origin");
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  }

  it("200 con el archivo completo, tipo y cabeceras de seguridad", async () => {
    const res = await get(filePath);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "video/mp4");
    assert.equal(res.headers.get("accept-ranges"), "bytes");
    assert.equal(res.headers.get("content-length"), "1000");
    assertSecurityHeaders(res);
    assert.deepEqual(new Uint8Array(await res.arrayBuffer()), bytes);
  });

  it("también con ?k= del incidente", async () => {
    const res = await get(filePath, {}, `?k=${encodeURIComponent(shareKey)}`);
    assert.equal(res.status, 200);
    await res.arrayBuffer();
  });

  it("206 con Range y 416 fuera de rango", async () => {
    const res = await get(filePath, { range: "bytes=10-19" });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get("content-range"), "bytes 10-19/1000");
    assert.equal(res.headers.get("content-length"), "10");
    assert.deepEqual(new Uint8Array(await res.arrayBuffer()), bytes.subarray(10, 20));

    const tail = await get(filePath, { range: "bytes=-5" });
    assert.equal(tail.status, 206);
    assert.deepEqual(new Uint8Array(await tail.arrayBuffer()), bytes.subarray(995));

    const bad = await get(filePath, { range: "bytes=5000-" });
    assert.equal(bad.status, 416);
    assert.equal(bad.headers.get("content-range"), "bytes */1000");
    assertSecurityHeaders(bad);
  });

  it("304 con If-None-Match y HEAD sin cuerpo", async () => {
    const first = await get(filePath);
    const etag = first.headers.get("etag") ?? "";
    await first.arrayBuffer();
    assert.ok(etag);
    const cached = await get(filePath, { "if-none-match": etag });
    assert.equal(cached.status, 304);

    const head = await filesHead(new Request(`http://localhost/api/files/${filePath}`, { method: "HEAD" }), ctxFor(filePath));
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), "1000");
    assert.equal(head.body, null);
  });

  it("404 para archivos inexistentes, traversal o rutas fuera de la convención", async () => {
    const missing = await get(storagePaths.frame(randomUUID(), randomUUID(), 0));
    assert.equal(missing.status, 404);
    assertSecurityHeaders(missing);
    for (const segments of [["..", "..", "etc", "passwd"], ["incidents", "..", "db.json"], ["db.json"]]) {
      const res = await filesGet(new Request("http://localhost/api/files/x"), {
        params: Promise.resolve({ path: segments }),
      });
      assert.equal(res.status, 404, segments.join("/"));
    }
  });
});
