import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { ApiClientError, type CreateReportBody } from "@/lib/client/api";
import type { CompleteReportRequest, CreateReportResponse, UploadTarget } from "@/lib/contract";
import { CreateReportInputSchema, LIMITS } from "@/lib/domain";
import {
  backoffDelay,
  bodyForTarget,
  buildCreateReportBody,
  cleanNote,
  createProgressReporter,
  guessMime,
  isCrossOrigin,
  isRetryableStatus,
  mapWithConcurrency,
  normalizeHeading,
  overallFraction,
  prepareFrames,
  putToTarget,
  runSubmitReport,
  SubmitReportError,
  toIsoOrNull,
  uploadErrorFor,
  videoExtension,
  type LocalFrame,
  type PutOptions,
  type SubmitReportDeps,
  type UploadProgress,
  type UploadStage,
} from "@/lib/client/upload-core";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/* ───────────── backoff y status ───────────── */

test("backoffDelay: exponencial con jitter entre la mitad y el total, con tope", () => {
  assert.equal(backoffDelay(0, 500, 8000, () => 0), 250);
  assert.equal(backoffDelay(0, 500, 8000, () => 1), 500);
  assert.equal(backoffDelay(1, 500, 8000, () => 1), 1000);
  assert.equal(backoffDelay(2, 500, 8000, () => 0.5), 1500);
  assert.equal(backoffDelay(10, 500, 8000, () => 1), 8000);
  assert.equal(backoffDelay(10, 500, 8000, () => 0), 4000);
  assert.equal(backoffDelay(-3, 500, 8000, () => 1), 500);
  assert.equal(backoffDelay(Number.NaN, 500, 8000, () => 1), 500);
  assert.equal(backoffDelay(1000, 500, 8000, () => 1), 8000);
  // rand fuera de rango se acota
  assert.equal(backoffDelay(0, 500, 8000, () => 7), 500);
  for (let i = 0; i < 50; i++) {
    const d = backoffDelay(3);
    assert.ok(d >= 2000 && d <= 4000, `fuera de rango: ${d}`);
  }
});

test("isRetryableStatus: red, 408, 429 y 5xx sí; otros 4xx no", () => {
  for (const s of [0, 408, 429, 500, 502, 503, 504, 599]) assert.equal(isRetryableStatus(s), true, String(s));
  for (const s of [200, 201, 400, 401, 403, 404, 409, 413, 422, 600]) {
    assert.equal(isRetryableStatus(s), false, String(s));
  }
});

test("uploadErrorFor: códigos y mensajes en español", () => {
  assert.equal(uploadErrorFor(0).code, "network");
  assert.equal(uploadErrorFor(403).code, "forbidden");
  assert.equal(uploadErrorFor(413).code, "too_large");
  assert.equal(uploadErrorFor(503).code, "internal");
  assert.equal(uploadErrorFor(429).code, "rate_limited");
  assert.equal(uploadErrorFor(400).code, "invalid");
  assert.ok(uploadErrorFor(503) instanceof ApiClientError);
  assert.match(uploadErrorFor(0).message, /conexión/);
});

/* ───────────── progreso ───────────── */

const ORDER: UploadStage[] = [
  "extracting",
  "registering",
  "uploading_frames",
  "analyzing_started",
  "uploading_video",
  "done",
];

test("overallFraction: monótona a lo largo de las etapas, 0 al inicio y 1 al final", () => {
  for (const hasVideo of [true, false]) {
    let prev = -1;
    for (const stage of ORDER) {
      for (const f of [0, 0.25, 0.5, 1]) {
        const v = overallFraction(stage, f, hasVideo);
        assert.ok(v >= prev, `${stage}@${f} retrocede (${v} < ${prev}) hasVideo=${hasVideo}`);
        assert.ok(v >= 0 && v <= 1);
        prev = v;
      }
    }
    assert.equal(overallFraction("extracting", 0, hasVideo), 0);
    assert.equal(overallFraction("done", 0, hasVideo), 1);
  }
  // el video ocupa la mayor parte cuando existe
  assert.ok(overallFraction("analyzing_started", 1, true) < 0.5);
  assert.ok(overallFraction("analyzing_started", 1, false) > 0.9);
});

test("overallFraction: acota stageFraction y tolera NaN/undefined", () => {
  assert.equal(overallFraction("registering", 5, true), overallFraction("registering", 1, true));
  assert.equal(overallFraction("registering", -2, true), overallFraction("registering", 0, true));
  assert.equal(overallFraction("registering", Number.NaN, true), overallFraction("registering", 0, true));
  assert.equal(overallFraction("registering", undefined, false), overallFraction("registering", 0, false));
});

test("createProgressReporter: nunca retrocede y aísla errores del callback", () => {
  const seen: UploadProgress[] = [];
  const report = createProgressReporter(true, (p) => seen.push(p));
  report("uploading_frames", 1, "a");
  report("uploading_video", 0.5, "b");
  report("uploading_video", 0, "c"); // reintento: reinicia la etapa
  report("extracting", 0, "d");
  const fr = seen.map((p) => p.fraction);
  for (let i = 1; i < fr.length; i++) assert.ok(fr[i] >= fr[i - 1]);
  assert.equal(seen[2].stageFraction, 0);
  assert.equal(seen[2].stage, "uploading_video");
  const boom = createProgressReporter(false, () => {
    throw new Error("ui rota");
  });
  assert.doesNotThrow(() => boom("done", 1, "x"));
});

/* ───────────── concurrencia ───────────── */

test("mapWithConcurrency: respeta el límite y conserva el orden", async () => {
  let running = 0;
  let peak = 0;
  const items = [30, 5, 20, 1, 15, 2, 8, 12];
  const out = await mapWithConcurrency(items, 3, async (ms, i) => {
    running++;
    peak = Math.max(peak, running);
    await delay(ms);
    running--;
    return `${i}:${ms}`;
  });
  assert.equal(peak, 3);
  assert.deepEqual(
    out,
    items.map((ms, i) => `${i}:${ms}`),
  );
});

test("mapWithConcurrency: vacío, límite inválido y límite mayor que la lista", async () => {
  assert.deepEqual(await mapWithConcurrency([], 3, async () => 1), []);
  let peak = 0;
  let running = 0;
  const r = await mapWithConcurrency([1, 2, 3], 0, async (x) => {
    running++;
    peak = Math.max(peak, running);
    await delay(2);
    running--;
    return x * 2;
  });
  assert.deepEqual(r, [2, 4, 6]);
  assert.equal(peak, 1);
  assert.deepEqual(await mapWithConcurrency([1, 2], 10, async (x) => x + 1), [2, 3]);
});

test("mapWithConcurrency: ante un error deja de lanzar tareas y rechaza con el primero", async () => {
  const started: number[] = [];
  await assert.rejects(
    mapWithConcurrency([0, 1, 2, 3, 4, 5, 6, 7], 2, async (x) => {
      started.push(x);
      await delay(5);
      if (x === 1) throw new Error("falla 1");
      if (x === 2) throw new Error("falla 2");
      return x;
    }),
    /falla 1/,
  );
  assert.ok(started.length <= 4, `lanzó demasiadas: ${started.join(",")}`);
});

/* ───────────── normalización ───────────── */

test("normalizeHeading", () => {
  assert.equal(normalizeHeading(null), null);
  assert.equal(normalizeHeading(undefined), null);
  assert.equal(normalizeHeading(Number.NaN), null);
  assert.equal(normalizeHeading(Infinity), null);
  assert.equal(normalizeHeading(0), 0);
  assert.equal(normalizeHeading(360), 0);
  assert.equal(normalizeHeading(-90), 270);
  assert.equal(normalizeHeading(725), 5);
  assert.equal(normalizeHeading(-0.0000000000001) !== null, true);
  const h = normalizeHeading(-1e-14);
  assert.ok(h !== null && h >= 0 && h <= 360);
});

test("toIsoOrNull", () => {
  assert.equal(toIsoOrNull(null), null);
  assert.equal(toIsoOrNull(undefined), null);
  assert.equal(toIsoOrNull(""), null);
  assert.equal(toIsoOrNull("no es fecha"), null);
  assert.equal(toIsoOrNull(new Date(Number.NaN)), null);
  assert.equal(toIsoOrNull(new Date("2026-11-21T12:00:00Z")), "2026-11-21T12:00:00.000Z");
  assert.equal(toIsoOrNull("2026-11-21T09:00:00-03:00"), "2026-11-21T12:00:00.000Z");
});

test("cleanNote: recorta, limita y no deja medio emoji", () => {
  assert.equal(cleanNote("  hola  "), "hola");
  assert.equal(cleanNote(undefined), "");
  assert.equal(cleanNote("a".repeat(LIMITS.MAX_NOTE_CHARS + 50)).length, LIMITS.MAX_NOTE_CHARS);
  const s = "a".repeat(4) + "🔥"; // 4 + 2 unidades UTF-16
  assert.equal(cleanNote(s, 5), "aaaa");
  assert.equal(cleanNote("abc   def", 6), "abc");
});

test("guessMime y videoExtension", () => {
  assert.equal(guessMime("x.mp4", "video/mp4", "video"), "video/mp4");
  assert.equal(guessMime("x.webm", "video/webm;codecs=vp9", "video"), "video/webm");
  assert.equal(guessMime("IMG_1.MOV", "", "video"), "video/quicktime");
  assert.equal(guessMime("clip.3gp", "", "video"), "video/3gpp");
  assert.equal(guessMime("clip", "", "video"), "video/mp4");
  assert.equal(guessMime("foto.HEIC", "", "photo"), "image/heic");
  assert.equal(guessMime("foto", "application/octet-stream", "photo"), "image/jpeg");
  assert.equal(guessMime("a.jpg", "Image/JPEG", "photo"), "image/jpeg");
  assert.equal(videoExtension("video/quicktime"), "mov");
  assert.equal(videoExtension("video/webm; codecs=vp8"), "webm");
  assert.equal(videoExtension("video/3gpp"), "3gp");
  assert.equal(videoExtension("video/mp4"), "mp4");
  assert.equal(videoExtension("video/x-matroska"), "mp4");
});

test("isCrossOrigin", () => {
  assert.equal(isCrossOrigin("/api/local-upload/a.jpg?exp=1&sig=2", "https://vigia.cl"), false);
  assert.equal(isCrossOrigin("https://vigia.cl/api/x", "https://vigia.cl"), false);
  assert.equal(isCrossOrigin("https://storage.googleapis.com/b/o?X-Goog-Signature=1", "https://vigia.cl"), true);
  assert.equal(isCrossOrigin("https://storage.googleapis.com/b/o", null), true);
  // en node no hay `location`: una URL absoluta se trata como de otro origen
  assert.equal(isCrossOrigin("https://storage.googleapis.com/b/o"), true);
  assert.equal(isCrossOrigin("/relativa"), false);
});

test("bodyForTarget: quita el tipo sin cambiar los bytes", async () => {
  const typed = new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" });
  const plain = bodyForTarget(typed);
  assert.equal(plain.type, "");
  assert.equal(plain.size, 3);
  assert.deepEqual([...new Uint8Array(await plain.arrayBuffer())], [1, 2, 3]);
  const untyped = new Blob([new Uint8Array([9])]);
  assert.equal(bodyForTarget(untyped), untyped);
});

function fakeFrame(idx: number, bytes = 10, extra: Partial<LocalFrame> = {}): LocalFrame {
  return {
    idx,
    t_s: idx * 3,
    blob: new Blob([new Uint8Array(bytes)], { type: "image/jpeg" }),
    width: 1280,
    height: 720,
    ...extra,
  };
}

test("prepareFrames: máximo, tamaño, dimensiones e idx únicos", () => {
  const many = Array.from({ length: 20 }, (_, i) => fakeFrame(i));
  assert.equal(prepareFrames(many).length, LIMITS.MAX_FRAMES_PER_MEDIA);
  const big = { ...fakeFrame(1), blob: { size: LIMITS.MAX_FRAME_BYTES + 1 } as Blob };
  const out = prepareFrames([
    fakeFrame(0),
    big,
    fakeFrame(0), // idx repetido
    fakeFrame(2, 0), // vacío
    fakeFrame(3, 10, { width: 0 }),
    fakeFrame(99), // idx fuera de rango
    fakeFrame(4, 10, { width: 1279.6, t_s: -1 }),
  ]);
  assert.deepEqual(
    out.map((f) => f.idx),
    [0, 1, 2, 4],
  );
  assert.equal(out[3].width, 1280);
  assert.equal(out[3].t_s, 0);
});

test("buildCreateReportBody: cumple CreateReportInputSchema y normaliza campos", () => {
  const body = buildCreateReportBody({
    kind: "video",
    mime: "video/mp4",
    sizeBytes: 1234.4,
    durationS: 12.5,
    position: { lat: -33.45, lng: -70.66, accuracy_m: 14 },
    heading: -45,
    capturedAt: new Date("2026-11-21T12:00:00Z"),
    note: "  Hay personas adentro  ",
    frames: [fakeFrame(0), fakeFrame(1)],
    uploadVideo: true,
    incidentCode: "  VG-AB12 ",
    typeHint: "structure_fire",
    asResponder: false,
  });
  assert.equal(body.heading_deg, 315);
  assert.equal(body.note, "Hay personas adentro");
  assert.equal(body.incident_code, "VG-AB12");
  assert.equal(body.size_bytes, 1234);
  assert.equal(body.captured_at, "2026-11-21T12:00:00.000Z");
  assert.equal("as_responder" in body, false);
  assert.deepEqual(body.frames[1], { idx: 1, t_s: 3, width: 1280, height: 720 });
  CreateReportInputSchema.parse(body);

  const minimal = buildCreateReportBody({
    kind: "photo",
    mime: "image/jpeg",
    sizeBytes: 10,
    durationS: Number.NaN,
    position: { lat: Number.NaN, lng: 0 },
    heading: null,
    capturedAt: null,
    note: "",
    frames: [fakeFrame(0)],
    uploadVideo: false,
    incidentCode: "   ",
    asResponder: true,
  });
  assert.equal(minimal.lat, null);
  assert.equal(minimal.lng, null);
  assert.equal(minimal.accuracy_m, null);
  assert.equal(minimal.duration_s, null);
  assert.equal("incident_code" in minimal, false);
  assert.equal(minimal.as_responder, true);
  CreateReportInputSchema.parse(minimal);
});

/* ───────────── putToTarget contra un servidor HTTP real (fetch de node) ───────────── */

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

async function withServer(
  handler: (req: Seen, n: number) => number,
  fn: (base: string, seen: Seen[]) => Promise<void>,
): Promise<void> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const s: Seen = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) };
      seen.push(s);
      const status = handler(s, seen.length);
      if (status === -1) {
        req.socket.destroy(); // corte de red
        return;
      }
      res.statusCode = status;
      res.end(status >= 400 ? "error" : "");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, seen);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test("putToTarget: envía exactamente las cabeceras del destino (sin Content-Type agregado)", async () => {
  await withServer(
    () => 200,
    async (base, seen) => {
      const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/jpeg" });
      const target: UploadTarget = { method: "PUT", url: `${base}/b/o?X-Goog-Signature=abc`, headers: { "x-goog-meta-a": "1" } };
      await putToTarget(target, blob);
      assert.equal(seen.length, 1);
      assert.equal(seen[0].method, "PUT");
      assert.equal(seen[0].url, "/b/o?X-Goog-Signature=abc");
      assert.equal(seen[0].headers["content-type"], undefined);
      assert.equal(seen[0].headers["x-goog-meta-a"], "1");
      assert.equal(seen[0].headers.cookie, undefined);
      assert.deepEqual([...seen[0].body], [1, 2, 3, 4]);

      // con Content-Type firmado, viaja ese valor
      await putToTarget({ ...target, headers: { "Content-Type": "video/mp4" } }, blob);
      assert.equal(seen[1].headers["content-type"], "video/mp4");
    },
  );
});

test("putToTarget: reintenta 503/429/corte de red y termina bien", async () => {
  const plan = [503, 429, -1, 200];
  await withServer(
    (_s, n) => plan[n - 1] ?? 200,
    async (base, seen) => {
      const progress: number[] = [];
      await putToTarget({ method: "PUT", url: `${base}/x`, headers: {} }, new Blob(["hola"]), {
        retries: 3,
        retryBaseMs: 1,
        onProgress: (f) => progress.push(f),
      });
      assert.equal(seen.length, 4);
      assert.equal(progress.at(-1), 1);
    },
  );
});

test("putToTarget: no reintenta otros 4xx y se rinde tras los reintentos", async () => {
  await withServer(
    () => 403,
    async (base, seen) => {
      await assert.rejects(
        putToTarget({ method: "PUT", url: `${base}/x`, headers: {} }, new Blob(["a"]), { retryBaseMs: 1 }),
        (err: unknown) => err instanceof ApiClientError && err.status === 403 && err.code === "forbidden",
      );
      assert.equal(seen.length, 1);
    },
  );
  await withServer(
    () => 500,
    async (base, seen) => {
      await assert.rejects(
        putToTarget({ method: "PUT", url: `${base}/x`, headers: {} }, new Blob(["a"]), { retries: 2, retryBaseMs: 1 }),
        (err: unknown) => err instanceof ApiClientError && err.status === 500,
      );
      assert.equal(seen.length, 3);
    },
  );
});

test("putToTarget: se cancela durante la espera del backoff", async () => {
  await withServer(
    () => 503,
    async (base, seen) => {
      const ctrl = new AbortController();
      const p = putToTarget({ method: "PUT", url: `${base}/x`, headers: {} }, new Blob(["a"]), {
        signal: ctrl.signal,
        retryBaseMs: 5000,
      });
      await delay(50);
      ctrl.abort();
      await assert.rejects(p, (err: unknown) => err instanceof ApiClientError && err.code === "aborted");
      assert.equal(seen.length, 1);
      const pre = new AbortController();
      pre.abort();
      await assert.rejects(
        putToTarget({ method: "PUT", url: `${base}/x`, headers: {} }, new Blob(["a"]), { signal: pre.signal }),
        (err: unknown) => err instanceof ApiClientError && err.code === "aborted",
      );
      assert.equal(seen.length, 1);
    },
  );
});

/* ───────────── orquestación con dependencias falsas ───────────── */

function makeFile(name: string, type: string, size = 100): File {
  const f = new File([new Uint8Array(Math.min(size, 1000))], name, { type });
  if (size > 1000) Object.defineProperty(f, "size", { value: size });
  return f;
}

interface Calls {
  log: string[];
  bodies: CreateReportBody[];
  completes: CompleteReportRequest[];
  puts: { url: string; opts: PutOptions }[];
}

function makeDeps(over: Partial<SubmitReportDeps> & { frames?: number; videoUpload?: boolean } = {}): {
  deps: SubmitReportDeps;
  calls: Calls;
} {
  const calls: Calls = { log: [], bodies: [], completes: [], puts: [] };
  const nFrames = over.frames ?? 4;
  const deps: SubmitReportDeps = {
    retryBaseMs: 1,
    extractVideoFrames: async (_file, o) => {
      calls.log.push("extract");
      o.onProgress?.(0.5);
      o.onProgress?.(1);
      return {
        frames: Array.from({ length: nFrames }, (_, i) => fakeFrame(i)),
        duration_s: 12,
        width: 1280,
        height: 720,
      };
    },
    imageToFrame: async (file) => {
      calls.log.push(`image:${file.name}`);
      return { blob: new Blob([new Uint8Array(5)], { type: "image/jpeg" }), width: 800, height: 600 };
    },
    extractionErrorCode: (err) =>
      err && typeof err === "object" && "code" in err && err instanceof Error && err.name === "FrameExtractionError"
        ? String((err as { code: unknown }).code)
        : null,
    createReport: async (body): Promise<CreateReportResponse> => {
      calls.log.push("create");
      calls.bodies.push(body);
      return {
        media_id: "m1",
        incident_code: "VG-AB12",
        created_incident: false,
        upload_token: "tok",
        frame_uploads: body.frames.map((f) => ({ method: "PUT", url: `/up/frame-${f.idx}`, headers: {} })),
        video_upload: body.upload_video && over.videoUpload !== false ? { method: "PUT", url: "/up/video", headers: {} } : null,
      };
    },
    completeReport: async (_id, token, body) => {
      assert.equal(token, "tok");
      calls.log.push(`complete:${body.part}:${body.ok}`);
      calls.completes.push(body);
      return { ok: true };
    },
    putToTarget: async (target, _body, opts) => {
      calls.puts.push({ url: target.url, opts });
      calls.log.push(`put:${target.url}`);
      opts.onProgress?.(0.5);
      opts.onProgress?.(1);
    },
    ...over,
  };
  return { deps, calls };
}

class FakeExtractionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "FrameExtractionError";
  }
}

function assertMonotonic(progress: UploadProgress[]) {
  for (let i = 1; i < progress.length; i++) {
    assert.ok(progress[i].fraction >= progress[i - 1].fraction, `retrocede en ${i}: ${progress[i].stage}`);
  }
  assert.equal(progress.at(-1)?.stage, "done");
  assert.equal(progress.at(-1)?.fraction, 1);
}

test("submitReport (video): fotogramas → aviso → video → aviso, en ese orden", async () => {
  const { deps, calls } = makeDeps();
  const progress: UploadProgress[] = [];
  let framesInfoAt = -1;
  const res = await runSubmitReport(
    {
      kind: "video",
      file: makeFile("clip.mov", ""),
      note: "  Hay heridos ",
      position: { lat: -33.4, lng: -70.6, accuracy_m: 8 },
      heading: 370,
      typeHint: "structure_fire",
      onProgress: (p) => progress.push(p),
      onFramesUploaded: (r) => {
        framesInfoAt = calls.log.length;
        assert.equal(r.framesSent, 4);
        assert.equal(r.mediaId, "m1");
      },
    },
    deps,
  );
  assert.deepEqual(res, {
    mediaId: "m1",
    incidentCode: "VG-AB12",
    createdIncident: false,
    framesSent: 4,
    framesUnsupported: false,
    video: "uploaded",
  });
  const b = calls.bodies[0];
  assert.equal(b.mime, "video/quicktime");
  assert.equal(b.heading_deg, 10);
  assert.equal(b.note, "Hay heridos");
  assert.equal(b.upload_video, true);
  assert.equal(b.duration_s, 12);
  assert.equal(b.captured_at, null);
  assert.equal(b.type_hint, "structure_fire");
  CreateReportInputSchema.parse(b);
  assert.equal(calls.log[0], "extract");
  assert.equal(calls.log[1], "create");
  assert.deepEqual(calls.log.slice(2, 6).sort(), ["put:/up/frame-0", "put:/up/frame-1", "put:/up/frame-2", "put:/up/frame-3"]);
  assert.deepEqual(calls.log.slice(6), ["complete:frames:true", "put:/up/video", "complete:video:true"]);
  assert.equal(framesInfoAt, 7); // justo después del aviso de fotogramas
  assert.equal(calls.puts.find((p) => p.url === "/up/frame-0")?.opts.retries, 3);
  assert.ok(calls.puts.find((p) => p.url === "/up/video")?.opts.onProgress);
  assertMonotonic(progress);
  assert.ok(progress.some((p) => p.stage === "uploading_video" && p.stageFraction === 0.5));
});

test("submitReport (video): nunca más de 3 fotogramas subiendo a la vez", async () => {
  let running = 0;
  let peak = 0;
  const { deps } = makeDeps({
    frames: 10,
    putToTarget: async (target) => {
      if (target.url === "/up/video") return;
      running++;
      peak = Math.max(peak, running);
      await delay(5);
      running--;
    },
  });
  const res = await runSubmitReport({ kind: "video", file: makeFile("a.mp4", "video/mp4"), note: "" }, deps);
  assert.equal(res.framesSent, 10);
  assert.equal(peak, 3);
});

test("submitReport (video): navegador sin decodificador → solo video y framesUnsupported", async () => {
  const { deps, calls } = makeDeps({
    extractVideoFrames: async () => {
      throw new FakeExtractionError("unsupported");
    },
  });
  let framesCb = false;
  const progress: UploadProgress[] = [];
  const res = await runSubmitReport(
    {
      kind: "video",
      file: makeFile("a.mp4", "video/mp4"),
      note: "",
      onFramesUploaded: () => (framesCb = true),
      onProgress: (p) => progress.push(p),
    },
    deps,
  );
  assert.equal(res.framesUnsupported, true);
  assert.equal(res.framesSent, 0);
  assert.equal(res.video, "uploaded");
  assert.equal(framesCb, false);
  assert.deepEqual(calls.bodies[0].frames, []);
  assert.equal(calls.bodies[0].duration_s, null);
  assert.deepEqual(calls.log, ["create", "complete:frames:false", "put:/up/video", "complete:video:true"]);
  assertMonotonic(progress);
});

test("submitReport (video): sin decodificador y sin poder subir el video → error claro antes de registrar", async () => {
  const { deps, calls } = makeDeps({
    extractVideoFrames: async () => {
      throw new FakeExtractionError("unsupported");
    },
  });
  await assert.rejects(
    runSubmitReport({ kind: "video", file: makeFile("a.mp4", "video/mp4", LIMITS.MAX_VIDEO_BYTES + 1), note: "" }, deps),
    (err: unknown) =>
      err instanceof SubmitReportError &&
      err.stage === "extracting" &&
      err.code === "unsupported" &&
      !err.retryable &&
      /250 MB/.test(err.message),
  );
  await assert.rejects(
    runSubmitReport({ kind: "video", file: makeFile("a.mp4", "video/mp4"), note: "", uploadVideo: false }, deps),
    (err: unknown) => err instanceof SubmitReportError && err.code === "unsupported",
  );
  assert.equal(calls.bodies.length, 0);
});

test("submitReport (video): sin fotogramas y el servidor no da destino de video → error", async () => {
  const { deps, calls } = makeDeps({
    videoUpload: false,
    extractVideoFrames: async () => {
      throw new FakeExtractionError("unsupported");
    },
  });
  await assert.rejects(
    runSubmitReport({ kind: "video", file: makeFile("a.mp4", "video/mp4"), note: "" }, deps),
    (err: unknown) => err instanceof SubmitReportError && err.stage === "registering" && err.mediaId === "m1",
  );
  assert.deepEqual(calls.completes, [{ part: "video", ok: false, error: "El servidor no habilitó la subida del video." }]);
});

test("submitReport (video): video demasiado grande → solo fotogramas, sin aviso de video (upload_video false)", async () => {
  const { deps, calls } = makeDeps();
  const res = await runSubmitReport(
    { kind: "video", file: makeFile("a.mp4", "video/mp4", LIMITS.MAX_VIDEO_BYTES + 1), note: "" },
    deps,
  );
  assert.equal(res.video, "skipped_too_large");
  assert.match(res.videoError ?? "", /250 MB/);
  assert.equal(calls.bodies[0].upload_video, false);
  assert.ok(!calls.log.includes("put:/up/video"));
  // el servidor responde 400 "Este envío no incluye video" a un aviso de video sin upload_video
  assert.deepEqual(calls.completes, [{ part: "frames", ok: true }]);
});

test("submitReport: cancelar después de que el video subió confirma ok:true (no lo da por perdido)", async () => {
  const ctrl = new AbortController();
  const { deps, calls } = makeDeps({
    completeReport: async (_id, _t, body) => {
      calls.completes.push(body);
      // primer aviso de video (ya subido): la persona cancela mientras espera la respuesta
      if (body.part === "video" && calls.completes.filter((c) => c.part === "video").length === 1) {
        ctrl.abort();
        throw new ApiClientError(0, "aborted", "Envío cancelado.");
      }
      return { ok: true };
    },
  });
  await assert.rejects(
    runSubmitReport({ kind: "video", file: makeFile("a.mp4", "video/mp4"), note: "", signal: ctrl.signal }, deps),
    (err: unknown) => err instanceof SubmitReportError && err.code === "aborted" && err.stage === "uploading_video",
  );
  await delay(5);
  assert.deepEqual(calls.completes.at(-1), { part: "video", ok: true });
  assert.ok(!calls.completes.some((c) => c.part === "video" && !c.ok));
});

test("submitReport: un /complete colgado se corta por tiempo y se reintenta", async () => {
  let n = 0;
  const { deps } = makeDeps({
    completeTimeoutMs: 20,
    completeReport: async (_id, _t, _body, signal) => {
      n++;
      if (n === 1) {
        // ignora la señal a propósito: el tope debe funcionar igual
        await new Promise<void>(() => {});
      }
      assert.ok(signal);
      return { ok: true };
    },
  });
  const t0 = Date.now();
  const res = await runSubmitReport({ kind: "video", file: makeFile("a.mp4", "video/mp4"), note: "" }, deps);
  assert.equal(res.video, "uploaded");
  assert.equal(n, 3); // frames (colgado) + frames (reintento) + video
  assert.ok(Date.now() - t0 < 2000);
});

test("submitReport: el aviso de mejor esfuerzo tiene tope total y no traba el resultado", async () => {
  const { deps } = makeDeps({
    completeTimeoutMs: 1000,
    bestEffortTimeoutMs: 30,
    putToTarget: async (target) => {
      if (target.url === "/up/video") throw new ApiClientError(503, "internal", "El servidor no pudo recibir el archivo.");
    },
    completeReport: async (_id, _t, body) => {
      if (body.part === "video") await new Promise<void>(() => {}); // nunca responde
      return { ok: true };
    },
  });
  const t0 = Date.now();
  const res = await runSubmitReport({ kind: "video", file: makeFile("a.mp4", "video/mp4"), note: "" }, deps);
  assert.equal(res.video, "failed");
  assert.ok(Date.now() - t0 < 900, `tardó ${Date.now() - t0} ms`);
});

test("submitReport (video): uploadVideo false → sin video ni aviso de video", async () => {
  const { deps, calls } = makeDeps();
  const res = await runSubmitReport(
    { kind: "video", file: makeFile("a.mp4", "video/mp4"), note: "", uploadVideo: false },
    deps,
  );
  assert.equal(res.video, "none");
  assert.equal(calls.bodies[0].upload_video, false);
  assert.deepEqual(calls.completes, [{ part: "frames", ok: true }]);
});

test("submitReport (video): falla el video tras enviar fotogramas → no lanza, video failed", async () => {
  const { deps, calls } = makeDeps({
    putToTarget: async (target) => {
      if (target.url === "/up/video") throw new ApiClientError(0, "network", "Se perdió la conexión.");
    },
  });
  const res = await runSubmitReport({ kind: "video", file: makeFile("a.mp4", "video/mp4"), note: "" }, deps);
  assert.equal(res.video, "failed");
  assert.equal(res.videoError, "Se perdió la conexión.");
  assert.deepEqual(calls.completes.at(-1), { part: "video", ok: false, error: "Se perdió la conexión." });
});

test("submitReport (video): sin fotogramas y falla el video → lanza en uploading_video", async () => {
  const { deps } = makeDeps({
    extractVideoFrames: async () => {
      throw new FakeExtractionError("unsupported");
    },
    putToTarget: async () => {
      throw new ApiClientError(503, "internal", "x");
    },
  });
  await assert.rejects(
    runSubmitReport({ kind: "video", file: makeFile("a.mp4", "video/mp4"), note: "" }, deps),
    (err: unknown) => err instanceof SubmitReportError && err.stage === "uploading_video" && err.retryable,
  );
});

test("submitReport: falla un fotograma → SubmitReportError en uploading_frames y cancela los demás", async () => {
  const aborted: string[] = [];
  const { deps, calls } = makeDeps({
    frames: 6,
    putToTarget: async (target, _b, opts) => {
      if (target.url === "/up/frame-1") throw new ApiClientError(403, "forbidden", "El permiso de subida venció.");
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, 50);
        opts.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          aborted.push(target.url);
          reject(new ApiClientError(0, "aborted", "Envío cancelado."));
        });
      });
    },
  });
  await assert.rejects(
    runSubmitReport({ kind: "video", file: makeFile("a.mp4", "video/mp4"), note: "" }, deps),
    (err: unknown) =>
      err instanceof SubmitReportError &&
      err.stage === "uploading_frames" &&
      err.code === "forbidden" &&
      err.mediaId === "m1" &&
      !err.framesDelivered &&
      /imágenes/.test(err.message),
  );
  assert.ok(aborted.length >= 1);
  assert.ok(!calls.log.some((l) => l.startsWith("complete")));
});

test("submitReport: error del servidor al registrar usa su mensaje (p. ej. sin ubicación)", async () => {
  const { deps } = makeDeps({
    createReport: async () => {
      throw new ApiClientError(400, "invalid", "Necesitamos tu ubicación o el código de la emergencia");
    },
  });
  await assert.rejects(
    runSubmitReport({ kind: "video", file: makeFile("a.mp4", "video/mp4"), note: "" }, deps),
    (err: unknown) =>
      err instanceof SubmitReportError &&
      err.stage === "registering" &&
      err.message === "Necesitamos tu ubicación o el código de la emergencia" &&
      !err.retryable,
  );
});

test("submitReport: /complete se reintenta ante 503 y no ante 4xx", async () => {
  let n = 0;
  const { deps } = makeDeps({
    completeReport: async () => {
      n++;
      if (n < 3) throw new ApiClientError(503, "internal", "x");
      return { ok: true };
    },
  });
  const res = await runSubmitReport({ kind: "video", file: makeFile("a.mp4", "video/mp4"), note: "" }, deps);
  assert.equal(res.video, "uploaded");
  assert.equal(n, 4); // 2 fallos + frames ok + video ok

  let m = 0;
  const { deps: deps2 } = makeDeps({
    completeReport: async () => {
      m++;
      throw new ApiClientError(409, "conflict", "Esta emergencia ya fue cerrada");
    },
  });
  await assert.rejects(
    runSubmitReport({ kind: "video", file: makeFile("a.mp4", "video/mp4"), note: "" }, deps2),
    (err: unknown) => err instanceof SubmitReportError && err.stage === "analyzing_started",
  );
  assert.equal(m, 1);
});

test("submitReport (fotos): convierte cada foto, máx. N, sin video", async () => {
  const { deps, calls } = makeDeps();
  const files = Array.from({ length: LIMITS.MAX_FRAMES_PER_MEDIA + 3 }, (_, i) => makeFile(`f${i}.heic`, "", 10));
  const progress: UploadProgress[] = [];
  const res = await runSubmitReport(
    { kind: "photo", files, note: "Cables caídos", onProgress: (p) => progress.push(p) },
    deps,
  );
  assert.equal(res.framesSent, LIMITS.MAX_FRAMES_PER_MEDIA);
  assert.equal(res.video, "none");
  const b = calls.bodies[0];
  assert.equal(b.kind, "photo");
  assert.equal(b.mime, "image/heic");
  assert.equal(b.upload_video, false);
  assert.equal(b.size_bytes, 10 * LIMITS.MAX_FRAMES_PER_MEDIA);
  assert.equal(b.duration_s, null);
  assert.deepEqual(b.frames[0], { idx: 0, t_s: 0, width: 800, height: 600 });
  CreateReportInputSchema.parse(b);
  assert.deepEqual(calls.completes, [{ part: "frames", ok: true }]);
  assertMonotonic(progress);
  assert.equal(progress.find((p) => p.stage === "extracting")?.message, "Preparando fotos…");
});

test("submitReport (fotos): una foto ilegible se omite; todas ilegibles → error", async () => {
  const { deps, calls } = makeDeps({
    imageToFrame: async (file) => {
      if (file.name === "mala.jpg") throw new FakeExtractionError("failed");
      return { blob: new Blob([new Uint8Array(5)]), width: 10, height: 10 };
    },
  });
  const res = await runSubmitReport(
    { kind: "photo", files: [makeFile("buena.jpg", "image/jpeg"), makeFile("mala.jpg", "image/jpeg")], note: "" },
    deps,
  );
  assert.equal(res.framesSent, 1);
  assert.equal(calls.bodies[0].frames.length, 1);
  await assert.rejects(
    runSubmitReport({ kind: "photo", files: [makeFile("mala.jpg", "image/jpeg")], note: "" }, deps),
    (err: unknown) => err instanceof SubmitReportError && err.stage === "extracting" && err.code === "empty",
  );
  await assert.rejects(
    runSubmitReport({ kind: "photo", files: [], note: "" }, deps),
    (err: unknown) => err instanceof SubmitReportError && err.code === "invalid",
  );
});

test("submitReport: cancelar durante la subida del video aborta y avisa sin bloquear", async () => {
  const ctrl = new AbortController();
  const { deps, calls } = makeDeps({
    putToTarget: async (target, _b, opts) => {
      if (target.url !== "/up/video") return;
      await new Promise<void>((_resolve, reject) => {
        opts.signal?.addEventListener("abort", () => reject(new ApiClientError(0, "aborted", "Envío cancelado.")));
        setTimeout(() => ctrl.abort(), 5);
      });
    },
  });
  await assert.rejects(
    runSubmitReport({ kind: "video", file: makeFile("a.mp4", "video/mp4"), note: "", signal: ctrl.signal }, deps),
    (err: unknown) =>
      err instanceof SubmitReportError &&
      err.code === "aborted" &&
      err.stage === "uploading_video" &&
      err.framesDelivered,
  );
  await delay(5);
  assert.equal(calls.completes.at(-1)?.part, "video");
  assert.equal(calls.completes.at(-1)?.ok, false);
});

test("submitReport: cancelar durante la extracción no registra nada", async () => {
  const ctrl = new AbortController();
  const { deps, calls } = makeDeps({
    extractVideoFrames: async (_f, o) => {
      ctrl.abort();
      assert.equal(o.signal?.aborted, true);
      throw new FakeExtractionError("aborted");
    },
  });
  await assert.rejects(
    runSubmitReport({ kind: "video", file: makeFile("a.mp4", "video/mp4"), note: "", signal: ctrl.signal }, deps),
    (err: unknown) => err instanceof SubmitReportError && err.code === "aborted" && err.stage === "extracting",
  );
  assert.equal(calls.bodies.length, 0);
});

test("putToTarget (fetch): un onProgress que lanza no convierte un 200 en reintento", async () => {
  await withServer(
    () => 200,
    async (base, seen) => {
      await putToTarget({ method: "PUT", url: `${base}/x`, headers: {} }, new Blob(["a"]), {
        retryBaseMs: 1,
        onProgress: () => {
          throw new Error("ui rota");
        },
      });
      assert.equal(seen.length, 1);
    },
  );
});

/* ───────────── putToTarget con XMLHttpRequest (doble de prueba, sin DOM) ───────────── */

type XhrScript = "ok" | "hang" | "error" | "slow" | "slow-then-ok";

class FakeXhr extends EventTarget {
  static script: XhrScript[] = [];
  static instances: FakeXhr[] = [];
  readonly upload = new EventTarget();
  status = 0;
  method = "";
  url = "";
  headers: Record<string, string> = {};
  body: unknown = null;
  aborted = false;
  private done = false;
  private timers: ReturnType<typeof setTimeout>[] = [];

  constructor() {
    super();
    FakeXhr.instances.push(this);
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(k: string, v: string) {
    this.headers[k] = v;
  }
  private later(ms: number, fn: () => void) {
    this.timers.push(setTimeout(() => !this.done && fn(), ms));
  }
  private progress(loaded: number, total: number) {
    this.upload.dispatchEvent(Object.assign(new Event("progress"), { lengthComputable: true, loaded, total }));
  }
  private end(type: "load" | "error", status: number) {
    this.done = true;
    this.status = status;
    this.dispatchEvent(new Event(type));
  }
  send(body: unknown) {
    this.body = body;
    const mode = FakeXhr.script.shift() ?? "ok";
    if (mode === "ok") {
      this.later(2, () => this.progress(50, 100));
      this.later(4, () => this.progress(100, 100));
      this.later(6, () => this.end("load", 200));
    } else if (mode === "error") {
      this.later(2, () => this.end("error", 0));
    } else if (mode === "slow" || mode === "slow-then-ok") {
      for (let i = 1; i <= 10; i++) this.later(i * 10, () => this.progress(i * 10, 100));
      if (mode === "slow-then-ok") this.later(110, () => this.end("load", 200));
    }
    // "hang": nunca avanza
  }
  abort() {
    if (this.done) return;
    this.done = true;
    this.aborted = true;
    for (const t of this.timers) clearTimeout(t);
    this.status = 0;
    this.dispatchEvent(new Event("abort"));
  }
}

async function withFakeXhr(fn: () => Promise<void>): Promise<void> {
  const g = globalThis as { XMLHttpRequest?: unknown };
  const prev = g.XMLHttpRequest;
  g.XMLHttpRequest = FakeXhr;
  FakeXhr.script = [];
  FakeXhr.instances = [];
  try {
    await fn();
  } finally {
    if (prev === undefined) delete g.XMLHttpRequest;
    else g.XMLHttpRequest = prev;
  }
}

test("putToTarget (XHR): progreso real, cabeceras exactas, cuerpo sin tipo y reintento tras inactividad o error", async () => {
  await withFakeXhr(async () => {
    FakeXhr.script = ["hang", "error", "ok"];
    const progress: number[] = [];
    await putToTarget(
      { method: "PUT", url: "https://storage.example/b/o?sig=1", headers: { "content-type": "video/mp4" } },
      new Blob([new Uint8Array(4)], { type: "video/quicktime" }),
      { onProgress: (f) => progress.push(f), idleTimeoutMs: 30, retryBaseMs: 1, retries: 3 },
    );
    assert.equal(FakeXhr.instances.length, 3);
    assert.equal(FakeXhr.instances[0].aborted, true); // cortado por inactividad
    const last = FakeXhr.instances[2];
    assert.equal(last.method, "PUT");
    assert.deepEqual(last.headers, { "content-type": "video/mp4" });
    assert.ok(last.body instanceof Blob && last.body.type === "");
    assert.ok(progress.includes(0.5));
    assert.equal(progress.at(-1), 1);
  });
});

test("putToTarget (XHR): el avance reinicia el tope de inactividad", async () => {
  await withFakeXhr(async () => {
    FakeXhr.script = ["slow-then-ok"];
    await putToTarget({ method: "PUT", url: "/up/v", headers: {} }, new Blob(["a"]), {
      onProgress: () => {},
      idleTimeoutMs: 30, // menor que la duración total (110 ms) pero mayor que el intervalo (10 ms)
      retries: 0,
    });
    assert.equal(FakeXhr.instances.length, 1);
  });
});

test("putToTarget (XHR): cancelar aborta la petición y no deja temporizadores vivos", async () => {
  await withFakeXhr(async () => {
    FakeXhr.script = ["slow"];
    const ctrl = new AbortController();
    let calls = 0;
    const p = putToTarget({ method: "PUT", url: "/up/v", headers: {} }, new Blob(["a"]), {
      signal: ctrl.signal,
      onProgress: () => calls++,
      idleTimeoutMs: 40,
    });
    await delay(25);
    ctrl.abort();
    await assert.rejects(p, (err: unknown) => err instanceof ApiClientError && err.code === "aborted");
    assert.equal(FakeXhr.instances.length, 1);
    assert.equal(FakeXhr.instances[0].aborted, true);
    const seenCalls = calls;
    await delay(80); // si el tope de inactividad siguiera vivo, aquí haría un reintento
    assert.equal(FakeXhr.instances.length, 1);
    assert.equal(calls, seenCalls);
  });
});
