/**
 * Pruebas de Cloud Storage sin red: armado de opciones, validación de rutas,
 * comportamiento del adaptador con un bucket simulado y firma V4 real con una
 * llave RSA generada aquí (la firma con llave privada es local; no llama a Google).
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash, createVerify, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Storage } from "@google-cloud/storage";
import {
  GCS_MAX_SIGNED_TTL_S,
  GCS_OBJECT_CACHE_CONTROL,
  GCS_UPLOAD_TTL_S,
  GcsPathError,
  assertContentType,
  assertGcsPath,
  buildReadUrlConfig,
  buildSaveOptions,
  buildStorageOptions,
  buildUploadUrlConfig,
  clampSignedTtl,
  createGcsFiles,
  isNotFoundError,
  toUploadTarget,
} from "./gcs-files";
import { StoreNotFoundError, storagePaths } from "./types";

const INCIDENT = "4b0c1f7e-8a7d-4c1e-9f55-0d3a6a1b2c3d";
const MEDIA = "9e2f7d1a-3b4c-4d5e-8f60-112233445566";
const FRAME_PATH = storagePaths.frame(INCIDENT, MEDIA, 0);
const VIDEO_PATH = storagePaths.video(INCIDENT, MEDIA, "mp4");

const BAD_PATHS: unknown[] = [
  "",
  "/incidents/x/a.jpg",
  "../secreto.txt",
  "incidents/../../etc/passwd",
  "incidents/./a.jpg",
  "incidents//a.jpg",
  "incidents/a.jpg/",
  "incidents\\a.jpg",
  "incidents/a b.jpg",
  "incidents/%2e%2e/a.jpg",
  "incidents/a.jpg?x=1",
  "incidents/a\n.jpg",
  ".hidden",
  "a/".repeat(20) + "b",
  "x".repeat(600),
  null,
  undefined,
  42,
];

describe("assertGcsPath", () => {
  it("acepta las rutas de la convención del bucket", () => {
    assert.equal(assertGcsPath(FRAME_PATH), FRAME_PATH);
    assert.equal(assertGcsPath(VIDEO_PATH), VIDEO_PATH);
    assert.equal(assertGcsPath("demo/escena-01.jpg"), "demo/escena-01.jpg");
  });

  for (const bad of BAD_PATHS) {
    it(`rechaza ${JSON.stringify(bad)?.slice(0, 40) ?? String(bad)}`, () => {
      assert.throws(() => assertGcsPath(bad), GcsPathError);
    });
  }
});

describe("assertContentType", () => {
  it("acepta tipos habituales", () => {
    for (const ct of ["image/jpeg", "video/mp4", "video/quicktime", "video/webm; codecs=vp9", "application/octet-stream"]) {
      assert.equal(assertContentType(ct), ct);
    }
  });
  it("rechaza vacíos, sin subtipo, con saltos de línea o demasiado largos", () => {
    for (const ct of ["", "image", "image/", "/jpeg", "image/jpeg\r\nx-evil: 1", "a/" + "b".repeat(200), 7, null]) {
      assert.throws(() => assertContentType(ct));
    }
  });
});

describe("clampSignedTtl", () => {
  it("acota a [1 s, 7 días] y redondea hacia abajo", () => {
    assert.equal(clampSignedTtl(3600), 3600);
    assert.equal(clampSignedTtl(10.9), 10);
    assert.equal(clampSignedTtl(0), 1);
    assert.equal(clampSignedTtl(-50), 1);
    assert.equal(clampSignedTtl(30 * 24 * 3600), GCS_MAX_SIGNED_TTL_S);
    assert.equal(GCS_MAX_SIGNED_TTL_S, 604_800);
  });
  it("rechaza valores no finitos", () => {
    assert.throws(() => clampSignedTtl(Number.NaN));
    assert.throws(() => clampSignedTtl(Number.POSITIVE_INFINITY));
  });
});

describe("armado de opciones", () => {
  const now = Date.UTC(2026, 10, 21, 12, 0, 0);

  it("buildUploadUrlConfig: PUT V4 de 15 minutos con el Content-Type firmado", () => {
    assert.deepEqual(buildUploadUrlConfig("video/mp4", now), {
      version: "v4",
      action: "write",
      expires: now + 15 * 60_000,
      contentType: "video/mp4",
    });
    assert.equal(GCS_UPLOAD_TTL_S, 900);
    assert.throws(() => buildUploadUrlConfig("nada", now));
  });

  it("buildReadUrlConfig: lectura V4 con vigencia acotada", () => {
    assert.deepEqual(buildReadUrlConfig(3600, now), { version: "v4", action: "read", expires: now + 3_600_000 });
    assert.equal(buildReadUrlConfig(99 * 24 * 3600, now).expires, now + GCS_MAX_SIGNED_TTL_S * 1000);
  });

  it("toUploadTarget: forma exacta de UploadTarget", () => {
    assert.deepEqual(toUploadTarget("https://storage.googleapis.com/b/o?x=1", "image/jpeg"), {
      method: "PUT",
      url: "https://storage.googleapis.com/b/o?x=1",
      headers: { "content-type": "image/jpeg" },
    });
  });

  it("buildSaveOptions: sin subida reanudable y con caché privado", () => {
    assert.deepEqual(buildSaveOptions("image/jpeg"), {
      contentType: "image/jpeg",
      resumable: false,
      metadata: { cacheControl: GCS_OBJECT_CACHE_CONTROL },
    });
    assert.match(GCS_OBJECT_CACHE_CONTROL, /^private\b/);
    assert.throws(() => buildSaveOptions(""));
  });

  it("buildStorageOptions: el proyecto solo si está configurado", () => {
    assert.deepEqual(buildStorageOptions("mi-proyecto"), { projectId: "mi-proyecto" });
    assert.deepEqual(buildStorageOptions(""), {});
  });

  it("isNotFoundError reconoce las formas de 404 de la biblioteca", () => {
    assert.equal(isNotFoundError({ code: 404 }), true);
    assert.equal(isNotFoundError({ code: "404" }), true);
    assert.equal(isNotFoundError({ status: 404 }), true);
    assert.equal(isNotFoundError({ response: { status: 404 } }), true);
    assert.equal(isNotFoundError({ code: 403 }), false);
    assert.equal(isNotFoundError({ response: null }), false);
    assert.equal(isNotFoundError(new Error("x")), false);
    assert.equal(isNotFoundError(null), false);
    assert.equal(isNotFoundError("404"), false);
  });
});

// ---------------------------------------------------------------------------
// Adaptador con un bucket simulado: verifica qué se le pide a la biblioteca.

interface Call {
  op: string;
  name: string;
  arg?: unknown;
}

function fakeStorage(state: { objects: Map<string, { bytes: Buffer; contentType: string }>; calls: Call[]; bucketNames: string[] }) {
  const notFound = () => Object.assign(new Error("No such object"), { code: 404 });
  const makeFile = (name: string) => ({
    name,
    async save(data: Uint8Array, options: { contentType?: string }) {
      state.calls.push({ op: "save", name, arg: options });
      state.objects.set(name, { bytes: Buffer.from(data), contentType: options.contentType ?? "" });
    },
    async download() {
      state.calls.push({ op: "download", name });
      const o = state.objects.get(name);
      if (!o) throw notFound();
      return [o.bytes] as const;
    },
    async getMetadata() {
      state.calls.push({ op: "getMetadata", name });
      const o = state.objects.get(name);
      if (!o) throw notFound();
      return [{ contentType: o.contentType }, {}] as const;
    },
    async exists() {
      state.calls.push({ op: "exists", name });
      return [state.objects.has(name)] as const;
    },
    async delete(options: { ignoreNotFound?: boolean }) {
      state.calls.push({ op: "delete", name, arg: options });
      if (!state.objects.delete(name) && !options.ignoreNotFound) throw notFound();
      return [{}] as const;
    },
    async getSignedUrl(cfg: unknown) {
      state.calls.push({ op: "getSignedUrl", name, arg: cfg });
      return [`https://firmada.example/${name}`] as const;
    },
  });
  const storage = {
    bucket(bucketName: string) {
      state.bucketNames.push(bucketName);
      return { file: makeFile };
    },
  };
  // Solo implementa lo que usa gcs-files.ts.
  return storage as unknown as Storage;
}

describe("createGcsFiles con bucket simulado", () => {
  const setup = () => {
    const state = { objects: new Map<string, { bytes: Buffer; contentType: string }>(), calls: [] as Call[], bucketNames: [] as string[] };
    const files = createGcsFiles({ storage: fakeStorage(state), bucket: "bucket-prueba" });
    return { state, files };
  };

  it("crea el bucket una sola vez y solo al primer uso", async () => {
    const { state, files } = setup();
    assert.equal(files.kind, "gcs");
    assert.equal(state.bucketNames.length, 0);
    await files.exists(FRAME_PATH);
    await files.exists(VIDEO_PATH);
    assert.deepEqual(state.bucketNames, ["bucket-prueba"]);
  });

  it("sin bucket configurado falla con un mensaje claro", async () => {
    const state = { objects: new Map(), calls: [] as Call[], bucketNames: [] as string[] };
    const files = createGcsFiles({ storage: fakeStorage(state), bucket: "  " });
    await assert.rejects(files.upload(FRAME_PATH, new Uint8Array([1]), "image/jpeg"), /GCS_BUCKET/);
  });

  it("upload → download conserva bytes y tipo; save recibe las opciones armadas", async () => {
    const { state, files } = setup();
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    await files.upload(FRAME_PATH, bytes, "image/jpeg");
    const save = state.calls.find((c) => c.op === "save");
    assert.deepEqual(save?.arg, buildSaveOptions("image/jpeg"));
    const got = await files.download(FRAME_PATH);
    assert.ok(got.bytes instanceof Uint8Array);
    assert.deepEqual(Array.from(got.bytes), Array.from(bytes));
    assert.equal(got.contentType, "image/jpeg");
  });

  it("download de algo inexistente → StoreNotFoundError", async () => {
    const { files } = setup();
    await assert.rejects(files.download(VIDEO_PATH), StoreNotFoundError);
  });

  it("exists: true/false, y false para rutas inválidas sin tocar el bucket", async () => {
    const { state, files } = setup();
    await files.upload(FRAME_PATH, new Uint8Array([1]), "image/jpeg");
    assert.equal(await files.exists(FRAME_PATH), true);
    assert.equal(await files.exists(VIDEO_PATH), false);
    const before = state.calls.length;
    assert.equal(await files.exists("../x.jpg"), false);
    assert.equal(state.calls.length, before);
  });

  it("remove borra en paralelo e ignora lo que no existe", async () => {
    const { state, files } = setup();
    await files.upload(FRAME_PATH, new Uint8Array([1]), "image/jpeg");
    await files.remove([FRAME_PATH, VIDEO_PATH]);
    const deletes = state.calls.filter((c) => c.op === "delete");
    assert.deepEqual(deletes.map((d) => d.name).sort(), [FRAME_PATH, VIDEO_PATH].sort());
    for (const d of deletes) assert.deepEqual(d.arg, { ignoreNotFound: true });
    assert.equal(await files.exists(FRAME_PATH), false);
    await files.remove([]);
  });

  it("remove con una ruta inválida no borra nada", async () => {
    const { state, files } = setup();
    await files.upload(FRAME_PATH, new Uint8Array([1]), "image/jpeg");
    await assert.rejects(files.remove([FRAME_PATH, "../../x"]), GcsPathError);
    assert.equal(state.calls.filter((c) => c.op === "delete").length, 0);
    assert.equal(await files.exists(FRAME_PATH), true);
  });

  it("las rutas inválidas se rechazan antes de llamar a Cloud Storage", async () => {
    const { state, files } = setup();
    for (const bad of ["", "/abs.jpg", "a/../b.jpg"]) {
      await assert.rejects(files.createUploadTarget(bad, "image/jpeg"), GcsPathError);
      await assert.rejects(files.getSignedReadUrl(bad, 60), GcsPathError);
      await assert.rejects(files.upload(bad, new Uint8Array([1]), "image/jpeg"), GcsPathError);
      await assert.rejects(files.download(bad), GcsPathError);
    }
    assert.equal(state.calls.length, 0);
  });

  it("createUploadTarget y getSignedReadUrl pasan las opciones V4 a getSignedUrl", async () => {
    const { state, files } = setup();
    const t0 = Date.now();
    const target = await files.createUploadTarget(VIDEO_PATH, "video/mp4");
    const t1 = Date.now();
    assert.deepEqual(target, {
      method: "PUT",
      url: `https://firmada.example/${VIDEO_PATH}`,
      headers: { "content-type": "video/mp4" },
    });
    const write = state.calls.find((c) => c.op === "getSignedUrl")?.arg as { expires: number; action: string; version: string; contentType: string };
    assert.equal(write.version, "v4");
    assert.equal(write.action, "write");
    assert.equal(write.contentType, "video/mp4");
    assert.ok(write.expires >= t0 + 900_000 && write.expires <= t1 + 900_000);

    const readUrl = await files.getSignedReadUrl(FRAME_PATH, 3600);
    assert.equal(readUrl, `https://firmada.example/${FRAME_PATH}`);
    const read = state.calls.filter((c) => c.op === "getSignedUrl")[1]?.arg as { action: string; version: string; contentType?: string };
    assert.equal(read.action, "read");
    assert.equal(read.version, "v4");
    assert.equal(read.contentType, undefined);
  });

  it("un Content-Type inválido no llega a firmarse", async () => {
    const { state, files } = setup();
    await assert.rejects(files.createUploadTarget(FRAME_PATH, "image/jpeg\nx: y"));
    assert.equal(state.calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Firma V4 real con la biblioteca y una cuenta de servicio falsa (sin red).

describe("firma V4 real sin red", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const clientEmail = "vigia-prueba@proyecto-falso.iam.gserviceaccount.com";
  const storage = new Storage({
    projectId: "proyecto-falso",
    credentials: { client_email: clientEmail, private_key: privateKey },
  });
  const files = createGcsFiles({ storage, bucket: "bucket-falso" });

  // Cualquier intento de red durante la firma haría fallar la prueba.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (() => Promise.reject(new Error("La prueba no debe usar la red"))) as typeof fetch;
  after(() => {
    globalThis.fetch = realFetch;
  });

  /** Recalcula la cadena firmada V4 desde la URL y verifica la firma con la llave pública. */
  function verifyV4(url: URL, method: string, headers: Record<string, string>): void {
    const rawQuery = url.search.slice(1).split("&");
    const sigPair = rawQuery.find((p) => p.startsWith("X-Goog-Signature="));
    assert.ok(sigPair, "falta X-Goog-Signature");
    const signatureHex = sigPair.slice("X-Goog-Signature=".length);
    assert.match(signatureHex, /^[0-9a-f]{512}$/);

    const canonicalQuery = rawQuery.filter((p) => p !== sigPair).sort().join("&");
    const signedHeaders = url.searchParams.get("X-Goog-SignedHeaders") ?? "";
    const allHeaders: Record<string, string> = { ...headers, host: url.host };
    const canonicalHeaders = signedHeaders
      .split(";")
      .map((h) => `${h}:${allHeaders[h]}\n`)
      .join("");
    const canonicalRequest = [method, url.pathname, canonicalQuery, canonicalHeaders, signedHeaders, "UNSIGNED-PAYLOAD"].join("\n");
    const datetime = url.searchParams.get("X-Goog-Date") ?? "";
    const scope = (url.searchParams.get("X-Goog-Credential") ?? "").split("/").slice(1).join("/");
    const stringToSign = [
      "GOOG4-RSA-SHA256",
      datetime,
      scope,
      createHash("sha256").update(canonicalRequest).digest("hex"),
    ].join("\n");
    const ok = createVerify("RSA-SHA256").update(stringToSign).verify(publicKey, Buffer.from(signatureHex, "hex"));
    assert.ok(ok, "la firma V4 no corresponde a la llave de la cuenta de servicio");
  }

  it("createUploadTarget produce una URL PUT V4 válida, de 15 min, con content-type firmado", async () => {
    const target = await files.createUploadTarget(VIDEO_PATH, "video/mp4");
    assert.equal(target.method, "PUT");
    assert.deepEqual(target.headers, { "content-type": "video/mp4" });
    const url = new URL(target.url);
    assert.equal(url.protocol, "https:");
    assert.equal(url.host, "storage.googleapis.com");
    assert.equal(url.pathname, `/bucket-falso/${VIDEO_PATH}`);
    assert.equal(url.searchParams.get("X-Goog-Algorithm"), "GOOG4-RSA-SHA256");
    assert.equal(url.searchParams.get("X-Goog-Expires"), "900");
    assert.match(url.searchParams.get("X-Goog-Date") ?? "", /^\d{8}T\d{6}Z$/);
    assert.match(url.searchParams.get("X-Goog-Credential") ?? "", new RegExp(`^${clientEmail.replace(/\./g, "\\.")}/\\d{8}/auto/storage/goog4_request$`));
    assert.equal(url.searchParams.get("X-Goog-SignedHeaders"), "content-type;host");
    verifyV4(url, "PUT", { "content-type": "video/mp4" });
  });

  it("getSignedReadUrl produce una URL GET V4 válida con la vigencia pedida y acotada a 7 días", async () => {
    const readUrl = await files.getSignedReadUrl(FRAME_PATH, 3600);
    assert.ok(readUrl);
    const url = new URL(readUrl);
    assert.equal(url.pathname, `/bucket-falso/${FRAME_PATH}`);
    assert.equal(url.searchParams.get("X-Goog-Expires"), "3600");
    assert.equal(url.searchParams.get("X-Goog-SignedHeaders"), "host");
    verifyV4(url, "GET", {});

    const longUrl = new URL((await files.getSignedReadUrl(FRAME_PATH, 30 * 24 * 3600)) ?? "");
    assert.equal(longUrl.searchParams.get("X-Goog-Expires"), String(GCS_MAX_SIGNED_TTL_S));
  });
});

// ---------------------------------------------------------------------------

describe("deploy/cors.json", () => {
  it("permite PUT/GET/HEAD desde el origen de la app con content-type y caché de 1 h", () => {
    const file = path.resolve(process.cwd(), "deploy/cors.json");
    const rules = JSON.parse(readFileSync(file, "utf8")) as Array<{
      origin: string[];
      method: string[];
      responseHeader: string[];
      maxAgeSeconds: number;
    }>;
    assert.ok(Array.isArray(rules) && rules.length >= 1);
    const [rule] = rules;
    assert.ok(rule.origin.length >= 1);
    for (const o of rule.origin) assert.match(o, /^https:\/\/[^/*]+$/);
    assert.deepEqual([...rule.method].sort(), ["GET", "HEAD", "PUT"]);
    assert.ok(rule.responseHeader.map((h) => h.toLowerCase()).includes("content-type"));
    assert.equal(rule.maxAgeSeconds, 3600);
  });
});
