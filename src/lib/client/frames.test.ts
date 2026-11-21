import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { LIMITS } from "@/lib/domain";
import {
  computeLumaStats,
  filterDarkFrames,
  HEIC_UNSUPPORTED_MESSAGE,
  isNearBlack,
  jpegQualityLadder,
  type LumaStats,
  mediaErrorToCode,
  probeInstants,
  progressFraction,
  roundTime,
  sampleInstants,
  sampleInstantsInRange,
  scaleToLongEdge,
  seekableSpan,
  shouldDropDarkFrames,
  usableDuration,
} from "@/lib/client/frames-core";
import {
  captureVideoElementFrame,
  extractVideoFrames,
  FrameExtractionError,
  imageToFrame,
} from "@/lib/client/frames";

/* ---------- lógica pura ---------- */

describe("sampleInstants", () => {
  test("n = clamp(round(dur/3), 4, max) y evita el primer y último 3 %", () => {
    const t = sampleInstants(30);
    assert.equal(t.length, 10);
    assert.equal(t[0], 0.9);
    assert.equal(t[t.length - 1], 29.1);
    for (let i = 1; i < t.length; i++) assert.ok(t[i] > t[i - 1]);
    const gaps = t.slice(1).map((x, i) => roundTime(x - t[i]));
    assert.ok(gaps.every((g) => Math.abs(g - gaps[0]) <= 0.01));
  });

  test("mínimo 4 y máximo LIMITS.MAX_FRAMES_PER_MEDIA", () => {
    assert.equal(sampleInstants(2).length, 4);
    assert.equal(sampleInstants(5).length, 4);
    assert.equal(sampleInstants(300).length, LIMITS.MAX_FRAMES_PER_MEDIA);
    assert.equal(sampleInstants(300, 6).length, 6);
    assert.equal(sampleInstants(300, 2).length, 2);
  });

  test("todos dentro del video", () => {
    for (const d of [0.4, 1, 7.3, 61, 3600]) {
      for (const t of sampleInstants(d)) assert.ok(t >= d * 0.03 - 1e-9 && t <= d * 0.97 + 1e-9, `${d}: ${t}`);
    }
  });

  test("duraciones inválidas → []", () => {
    assert.deepEqual(sampleInstants(0), []);
    assert.deepEqual(sampleInstants(-3), []);
    assert.deepEqual(sampleInstants(Number.NaN), []);
    assert.deepEqual(sampleInstants(Number.POSITIVE_INFINITY), []);
    assert.deepEqual(sampleInstants(10, 0), []);
  });

  test("por rango (seekable)", () => {
    const t = sampleInstantsInRange(10, 22);
    assert.equal(t.length, 4);
    assert.ok(t[0] > 10 && t[3] < 22);
    assert.deepEqual(sampleInstantsInRange(5, 5), []);
  });

  test("video muy corto no repite instantes", () => {
    const t = sampleInstants(0.002);
    assert.equal(new Set(t).size, t.length);
  });
});

test("probeInstants: segundos fijos", () => {
  assert.deepEqual(probeInstants(4), [0.5, 2.5, 4.5, 6.5]);
  assert.equal(probeInstants().length, LIMITS.MAX_FRAMES_PER_MEDIA);
  assert.deepEqual(probeInstants(0), []);
});

test("seekableSpan", () => {
  assert.deepEqual(seekableSpan([[0, 12]]), { start: 0, end: 12 });
  assert.deepEqual(seekableSpan([[2, 5], [7, 20]]), { start: 2, end: 20 });
  assert.equal(seekableSpan([]), null);
  assert.equal(seekableSpan([[0, Number.POSITIVE_INFINITY]]), null);
  assert.equal(seekableSpan([[3, 3]]), null);
});

test("usableDuration y roundTime", () => {
  assert.equal(usableDuration(12.5), 12.5);
  assert.equal(usableDuration(Number.POSITIVE_INFINITY), null);
  assert.equal(usableDuration(Number.NaN), null);
  assert.equal(usableDuration(0), null);
  assert.equal(usableDuration(undefined), null);
  assert.equal(roundTime(1.23456), 1.23);
  assert.equal(roundTime(2.005 + 1e-9), 2.01);
});

describe("scaleToLongEdge", () => {
  test("reduce manteniendo proporción", () => {
    assert.deepEqual(scaleToLongEdge(1920, 1080, 1280), { width: 1280, height: 720 });
    assert.deepEqual(scaleToLongEdge(1080, 1920, 1280), { width: 720, height: 1280 });
    assert.deepEqual(scaleToLongEdge(4032, 3024, 1280), { width: 1280, height: 960 });
  });
  test("nunca agranda", () => {
    assert.deepEqual(scaleToLongEdge(640, 480, 1280), { width: 640, height: 480 });
  });
  test("extremos", () => {
    assert.deepEqual(scaleToLongEdge(10000, 1, 1280), { width: 1280, height: 1 });
    assert.deepEqual(scaleToLongEdge(0, 480, 1280), { width: 0, height: 0 });
    assert.deepEqual(scaleToLongEdge(Number.NaN, 480, 1280), { width: 0, height: 0 });
  });
});

test("jpegQualityLadder baja desde la calidad inicial hasta el mínimo", () => {
  const l = jpegQualityLadder(LIMITS.FRAME_JPEG_QUALITY);
  assert.equal(l[0], LIMITS.FRAME_JPEG_QUALITY);
  assert.equal(l[l.length - 1], 0.4);
  for (let i = 1; i < l.length; i++) assert.ok(l[i] < l[i - 1]);
  assert.deepEqual(jpegQualityLadder(0.3), [0.3]);
});

const rgba = (pixels: Array<[number, number, number, number]>) => new Uint8ClampedArray(pixels.flat());
const S = (mean: number, std = 2): LumaStats => ({ mean, std, alpha: 255 });

test("computeLumaStats", () => {
  const black = computeLumaStats(rgba([[0, 0, 0, 255], [0, 0, 0, 255]]));
  assert.deepEqual(black, { mean: 0, std: 0, alpha: 255 });
  const half = computeLumaStats(rgba([[0, 0, 0, 255], [255, 255, 255, 255]]));
  assert.ok(Math.abs(half.mean - 127.5) < 0.01);
  assert.ok(Math.abs(half.std - 127.5) < 0.01);
  assert.equal(computeLumaStats(rgba([[0, 0, 0, 0]])).alpha, 0);
  assert.deepEqual(computeLumaStats([]), { mean: 0, std: 0, alpha: 0 });
});

test("isNearBlack: oscuro y uniforme", () => {
  assert.equal(isNearBlack(S(5)), true);
  assert.equal(isNearBlack(S(5, 40)), false); // noche con llamas: hay contraste
  assert.equal(isNearBlack(S(90)), false);
  assert.equal(isNearBlack(null), false);
});

describe("filterDarkFrames", () => {
  test("descarta los casi negros si quedan ≥ 4", () => {
    const stats = [S(3), S(4), S(100), S(110), S(120), S(130)];
    assert.deepEqual(filterDarkFrames(stats, 4), [2, 3, 4, 5]);
    assert.equal(shouldDropDarkFrames(stats, 4), true);
  });

  test("si no quedan suficientes, solo descarta repetidos hasta llegar a 4", () => {
    const stats = [S(3), S(3), S(3), S(100), S(110)];
    // 2 claros + primer oscuro + un repetido = 4
    assert.deepEqual(filterDarkFrames(stats, 4), [0, 1, 3, 4]);
  });

  test("oscuros distintos entre sí no son repetidos", () => {
    const stats = [S(2), S(15), S(100), S(110)];
    assert.deepEqual(filterDarkFrames(stats, 4), [0, 1, 2, 3]);
    assert.equal(shouldDropDarkFrames(stats, 4), false);
  });

  test("todo negro: conserva al menos minKeep", () => {
    const stats = Array.from({ length: 8 }, () => S(1));
    assert.equal(filterDarkFrames(stats, 4).length, 4);
    assert.deepEqual(filterDarkFrames(stats.slice(0, 3), 4), [0, 1, 2]);
  });

  test("sin oscuros o sin estadística no toca nada", () => {
    assert.deepEqual(filterDarkFrames([S(100), null, S(90)], 4), [0, 1, 2]);
    assert.deepEqual(filterDarkFrames([], 4), []);
  });
});

test("mediaErrorToCode", () => {
  assert.equal(mediaErrorToCode(4), "unsupported");
  assert.equal(mediaErrorToCode(3), "unsupported");
  assert.equal(mediaErrorToCode(2), "failed");
  assert.equal(mediaErrorToCode(undefined), "failed");
});

test("progressFraction", () => {
  assert.equal(progressFraction(0, 10), 0.05);
  assert.equal(progressFraction(10, 10), 1);
  assert.equal(progressFraction(0, 0), 0.05);
});

test("FrameExtractionError: código y mensaje en español", () => {
  const e = new FrameExtractionError("unsupported");
  assert.ok(e instanceof Error);
  assert.equal(e.code, "unsupported");
  assert.equal(e.name, "FrameExtractionError");
  assert.match(e.message, /navegador/);
  assert.equal(new FrameExtractionError("failed", "otro").message, "otro");
});

/* ---------- orquestación con un DOM falso mínimo ---------- */

interface VideoCfg {
  width?: number;
  height?: number;
  /** Duración que informa al cargar (Infinity/NaN para simular webm). */
  duration?: number;
  /** Largo real; acota los seek. */
  realLength?: number;
  /** Duración que aparece tras buscar un tiempo enorme. */
  durationAfterBigSeek?: number;
  seekable?: Array<[number, number]>;
  mediaErrorCode?: number;
  neverLoad?: boolean;
  luma?: (t: number) => number;
  /** Los seek nunca terminan (decodificador trabado). */
  stallSeeks?: boolean;
  /** En el seek n.º k (desde 1) el decodificador falla con este MediaError y ya no emite 'seeked'. */
  errorOnSeek?: { at: number; code: number };
  /** Fijar src lanza (navegador raro). */
  srcThrows?: boolean;
}

class FakeVideo extends EventTarget {
  muted = false;
  defaultMuted = false;
  playsInline = false;
  preload = "";
  style = { cssText: "" };
  attrs = new Map<string, string>();
  readyState = 0;
  videoWidth = 0;
  videoHeight = 0;
  duration = Number.NaN;
  seeking = false;
  ended = false;
  paused = true;
  error: { code: number } | null = null;
  removed = false;
  seeks: number[] = [];
  private t = 0;
  private srcValue = "";

  constructor(private cfg: VideoCfg) {
    super();
  }
  get currentTime() {
    return this.t;
  }
  set currentTime(v: number) {
    this.seeks.push(v);
    this.seeking = true;
    const fail = this.cfg.errorOnSeek;
    if (fail && this.seeks.length === fail.at) {
      setTimeout(() => {
        this.error = { code: fail.code };
        this.dispatchEvent(new Event("error"));
      }, 0);
      return;
    }
    if (this.cfg.stallSeeks || (fail && this.seeks.length > fail.at)) return;
    setTimeout(() => {
      if (v >= 1e6 && this.cfg.durationAfterBigSeek !== undefined) {
        this.duration = this.cfg.durationAfterBigSeek;
        this.dispatchEvent(new Event("durationchange"));
      }
      const end = this.cfg.realLength ?? (Number.isFinite(this.duration) ? this.duration : v);
      this.t = Math.min(v, end);
      this.ended = this.t >= end && v > end;
      this.seeking = false;
      this.dispatchEvent(new Event("seeked"));
    }, 0);
  }
  get src() {
    return this.srcValue;
  }
  set src(v: string) {
    if (this.cfg.srcThrows) throw new Error("src rechazado");
    this.srcValue = v;
    if (this.cfg.neverLoad) return;
    setTimeout(() => {
      if (this.cfg.mediaErrorCode) {
        this.error = { code: this.cfg.mediaErrorCode };
        this.dispatchEvent(new Event("error"));
        return;
      }
      this.videoWidth = this.cfg.width ?? 1920;
      this.videoHeight = this.cfg.height ?? 1080;
      this.duration = this.cfg.duration ?? 30;
      this.readyState = 1;
      this.dispatchEvent(new Event("loadedmetadata"));
      this.readyState = 4;
    }, 0);
  }
  get seekable() {
    const r = this.cfg.seekable ?? [];
    return { length: r.length, start: (i: number) => r[i][0], end: (i: number) => r[i][1] };
  }
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  load() {}
  setAttribute(k: string, v: string) {
    this.attrs.set(k, v);
  }
  removeAttribute(k: string) {
    if (k === "src") this.srcValue = "";
    this.attrs.delete(k);
  }
  remove() {
    this.removed = true;
  }
  lumaNow() {
    return this.cfg.luma ? this.cfg.luma(this.t) : 128;
  }
}

class FakeBitmap {
  closed = false;
  constructor(
    public width: number,
    public height: number,
  ) {}
  close() {
    this.closed = true;
  }
}

/** Tamaño simulado del JPEG según calidad y área. */
let blobSize: (w: number, h: number, q: number) => number = (w, h, q) => Math.round(w * h * q * 0.3);

class FakeCanvas {
  width = 0;
  height = 0;
  private luma = 128;
  getContext() {
    return {
      drawImage: (src: unknown) => {
        this.luma = src instanceof FakeVideo ? src.lumaNow() : 128;
      },
      getImageData: (_x: number, _y: number, w: number, h: number) => {
        const data = new Uint8ClampedArray(w * h * 4);
        for (let i = 0; i < w * h; i++) data.set([this.luma, this.luma, this.luma, 255], i * 4);
        return { data };
      },
    };
  }
  toBlob(cb: (b: Blob | null) => void, type: string, q: number) {
    const size = blobSize(this.width, this.height, q);
    setTimeout(() => cb(new Blob([new Uint8Array(size)], { type })), 0);
  }
}

interface Env {
  videos: FakeVideo[];
  revoked: string[];
  created: string[];
}

const g = globalThis as unknown as Record<string, unknown>;
const saved = {
  document: g.document,
  createImageBitmap: g.createImageBitmap,
  Image: g.Image,
  create: URL.createObjectURL,
  revoke: URL.revokeObjectURL,
};

function installDom(cfg: VideoCfg = {}): Env {
  const env: Env = { videos: [], revoked: [], created: [] };
  g.document = {
    body: { appendChild: () => undefined },
    createElement: (tag: string) => {
      if (tag === "video") {
        const v = new FakeVideo(cfg);
        env.videos.push(v);
        return v;
      }
      if (tag === "canvas") return new FakeCanvas();
      throw new Error(`tag inesperado ${tag}`);
    },
  };
  let n = 0;
  URL.createObjectURL = () => {
    const u = `blob:fake/${++n}`;
    env.created.push(u);
    return u;
  };
  URL.revokeObjectURL = (u: string) => {
    env.revoked.push(u);
  };
  return env;
}

afterEach(() => {
  g.document = saved.document;
  g.createImageBitmap = saved.createImageBitmap;
  g.Image = saved.Image;
  URL.createObjectURL = saved.create;
  URL.revokeObjectURL = saved.revoke;
  blobSize = (w, h, q) => Math.round(w * h * q * 0.3);
});

const videoBlob = () => new Blob([new Uint8Array(10)], { type: "video/mp4" });

function assertCleaned(env: Env) {
  assert.equal(env.videos.length, 1);
  assert.equal(env.videos[0].removed, true);
  assert.deepEqual(env.revoked, env.created);
}

async function rejectsWith(p: Promise<unknown>, code: FrameExtractionError["code"]) {
  await assert.rejects(p, (err: unknown) => err instanceof FrameExtractionError && err.code === code);
}

describe("extractVideoFrames (DOM falso)", () => {
  test("sin DOM (SSR/node) → unsupported", async () => {
    await rejectsWith(extractVideoFrames(videoBlob()), "unsupported");
  });

  test("video normal: instantes repartidos, escalado, índices, progreso y limpieza", async () => {
    const env = installDom({ duration: 30 });
    const progress: number[] = [];
    const out = await extractVideoFrames(videoBlob(), { onProgress: (f) => progress.push(f) });
    assert.equal(out.frames.length, 10);
    assert.equal(out.duration_s, 30);
    assert.equal(out.width, 1920);
    assert.equal(out.height, 1080);
    out.frames.forEach((f, i) => {
      assert.equal(f.idx, i);
      assert.equal(f.width, 1280);
      assert.equal(f.height, 720);
      assert.equal(f.blob.type, "image/jpeg");
      assert.ok(f.blob.size <= LIMITS.MAX_FRAME_BYTES);
    });
    assert.deepEqual(
      out.frames.map((f) => f.t_s),
      sampleInstants(30).map(roundTime),
    );
    assert.equal(progress[0], 0);
    assert.equal(progress[progress.length - 1], 1);
    for (let i = 1; i < progress.length; i++) assert.ok(progress[i] >= progress[i - 1]);
    const v = env.videos[0];
    assert.equal(v.muted, true);
    assert.equal(v.playsInline, true);
    assert.ok(v.attrs.has("playsinline") && v.attrs.has("webkit-playsinline") && v.attrs.has("muted"));
    assertCleaned(env);
  });

  test("descarta cuadros casi negros y reindexa", async () => {
    installDom({ duration: 30, luma: (t) => (t < 8 ? 4 : 120) });
    const out = await extractVideoFrames(videoBlob());
    assert.equal(out.frames.length, 7);
    assert.ok(out.frames.every((f) => f.t_s >= 8));
    assert.deepEqual(
      out.frames.map((f) => f.idx),
      [0, 1, 2, 3, 4, 5, 6],
    );
  });

  test("duración Infinity: truco del seek enorme", async () => {
    const env = installDom({ duration: Number.POSITIVE_INFINITY, durationAfterBigSeek: 20 });
    const out = await extractVideoFrames(videoBlob());
    assert.equal(out.duration_s, 20);
    assert.equal(out.frames.length, 7);
    assert.ok(env.videos[0].seeks.includes(1e7));
    assertCleaned(env);
  });

  test("duración desconocida: usa los rangos de seekable", async () => {
    installDom({ duration: Number.NaN, realLength: 12, seekable: [[0, 12]] });
    const out = await extractVideoFrames(videoBlob());
    assert.equal(out.duration_s, null);
    assert.equal(out.frames.length, 4);
    assert.ok(out.frames.every((f) => f.t_s > 0 && f.t_s < 12));
  });

  test("sin duración ni seekable: sondea segundos fijos hasta el final", async () => {
    installDom({ duration: Number.POSITIVE_INFINITY, realLength: 5 });
    const out = await extractVideoFrames(videoBlob());
    assert.equal(out.duration_s, null);
    assert.deepEqual(
      out.frames.map((f) => f.t_s),
      [0.5, 2.5, 4.5, 5],
    );
  });

  test("formato no soportado (MEDIA_ERR_SRC_NOT_SUPPORTED) → unsupported y limpia", async () => {
    const env = installDom({ mediaErrorCode: 4 });
    await rejectsWith(extractVideoFrames(videoBlob()), "unsupported");
    assertCleaned(env);
  });

  test("videoWidth 0 tras metadatos → unsupported", async () => {
    const env = installDom({ width: 0 });
    await rejectsWith(extractVideoFrames(videoBlob()), "unsupported");
    assertCleaned(env);
  });

  test("metadatos que no llegan → timeout y limpia", async () => {
    const env = installDom({ neverLoad: true });
    await rejectsWith(extractVideoFrames(videoBlob(), { metadataTimeoutMs: 30 }), "timeout");
    assertCleaned(env);
  });

  test("AbortSignal → aborted y limpia", async () => {
    const env = installDom({ duration: 30 });
    const ac = new AbortController();
    const p = extractVideoFrames(videoBlob(), {
      signal: ac.signal,
      onProgress: (f) => {
        if (f > 0.2) ac.abort();
      },
    });
    await rejectsWith(p, "aborted");
    assertCleaned(env);
  });

  test("señal ya abortada → aborted sin crear nada", async () => {
    const env = installDom({ duration: 30 });
    const ac = new AbortController();
    ac.abort();
    await rejectsWith(extractVideoFrames(videoBlob(), { signal: ac.signal }), "aborted");
    assert.equal(env.videos.length, 0);
  });

  test("maxFrames nunca supera LIMITS.MAX_FRAMES_PER_MEDIA; NaN usa el máximo", async () => {
    installDom({ duration: 600 });
    const out = await extractVideoFrames(videoBlob(), { maxFrames: 50 });
    assert.equal(out.frames.length, LIMITS.MAX_FRAMES_PER_MEDIA);
    installDom({ duration: 600 });
    const nan = await extractVideoFrames(videoBlob(), { maxFrames: Number.NaN });
    assert.equal(nan.frames.length, LIMITS.MAX_FRAMES_PER_MEDIA);
  });

  test("decodificador que falla a mitad: devuelve los cuadros ya capturados sin esperar timeouts", async () => {
    const env = installDom({ duration: 30, errorOnSeek: { at: 4, code: 3 } });
    const started = Date.now();
    const out = await extractVideoFrames(videoBlob(), { seekTimeoutMs: 2000 });
    assert.equal(out.frames.length, 3);
    assert.ok(Date.now() - started < 1500, "no debe esperar el timeout de los cuadros siguientes");
    assertCleaned(env);
  });

  test("seeks que nunca terminan: corta tras pocos timeouts y no deja recursos", async () => {
    const env = installDom({ duration: 30, stallSeeks: true });
    await rejectsWith(extractVideoFrames(videoBlob(), { seekTimeoutMs: 20 }), "timeout");
    // 10 instantes, pero se rinde tras 2 timeouts seguidos
    assert.equal(env.videos[0].seeks.length, 2);
    assertCleaned(env);
  });

  test("si fijar src lanza, falla limpio (sin rechazos colgados)", async () => {
    const env = installDom({ srcThrows: true });
    let unhandled = 0;
    const onUnhandled = () => {
      unhandled++;
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      await rejectsWith(extractVideoFrames(videoBlob(), { metadataTimeoutMs: 20 }), "failed");
      await new Promise((r) => setTimeout(r, 60));
      assert.equal(unhandled, 0);
      assertCleaned(env);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("cuadro demasiado pesado se recodifica con menos calidad", async () => {
    installDom({ duration: 12 });
    const qualities: number[] = [];
    blobSize = (_w, _h, q) => {
      qualities.push(q);
      return q > 0.6 ? LIMITS.MAX_FRAME_BYTES + 1 : 1000;
    };
    const out = await extractVideoFrames(videoBlob());
    assert.equal(out.frames.length, 4);
    assert.ok(out.frames.every((f) => f.blob.size <= LIMITS.MAX_FRAME_BYTES));
    assert.ok(qualities.includes(LIMITS.FRAME_JPEG_QUALITY) && qualities.some((q) => q <= 0.6));
  });
});

describe("imageToFrame (DOM falso)", () => {
  test("sin DOM → unsupported", async () => {
    await rejectsWith(imageToFrame(new Blob([], { type: "image/jpeg" })), "unsupported");
  });

  test("usa createImageBitmap con orientación EXIF y escala", async () => {
    installDom();
    const calls: unknown[] = [];
    const bitmaps: FakeBitmap[] = [];
    g.createImageBitmap = async (_b: Blob, o?: unknown) => {
      calls.push(o);
      const bm = new FakeBitmap(3024, 4032);
      bitmaps.push(bm);
      return bm;
    };
    const f = await imageToFrame(new Blob([new Uint8Array(5)], { type: "image/jpeg" }));
    assert.deepEqual(calls, [{ imageOrientation: "from-image" }]);
    assert.deepEqual([f.idx, f.t_s, f.width, f.height], [0, 0, 960, 1280]);
    assert.equal(f.blob.type, "image/jpeg");
    assert.equal(bitmaps[0].closed, true);
  });

  test("si la opción falla, reintenta sin opciones", async () => {
    installDom();
    const calls: unknown[] = [];
    g.createImageBitmap = async (_b: Blob, o?: unknown) => {
      calls.push(o);
      if (o) throw new TypeError("opción no soportada");
      return new FakeBitmap(800, 600);
    };
    const f = await imageToFrame(new Blob([new Uint8Array(5)], { type: "image/png" }));
    assert.equal(calls.length, 2);
    assert.deepEqual([f.width, f.height], [800, 600]);
  });

  test("HEIC que el navegador no abre → unsupported con mensaje claro", async () => {
    const env = installDom();
    g.createImageBitmap = async () => {
      throw new Error("no decodifica");
    };
    g.Image = class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      decoding = "";
      naturalWidth = 0;
      naturalHeight = 0;
      removeAttribute() {}
      set src(url: string) {
        void url;
        setTimeout(() => this.onerror?.(), 0);
      }
    };
    const file = new File([new Uint8Array(5)], "IMG_0001.HEIC", { type: "" });
    await assert.rejects(
      imageToFrame(file),
      (err: unknown) =>
        err instanceof FrameExtractionError && err.code === "unsupported" && err.message === HEIC_UNSUPPORTED_MESSAGE,
    );
    assert.deepEqual(env.revoked, env.created);
  });

  test("respaldo con <img> cuando no hay createImageBitmap", async () => {
    installDom();
    g.createImageBitmap = undefined;
    g.Image = class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      decoding = "";
      naturalWidth = 2000;
      naturalHeight = 1000;
      removeAttribute() {}
      set src(url: string) {
        void url;
        setTimeout(() => this.onload?.(), 0);
      }
    };
    const f = await imageToFrame(new Blob([new Uint8Array(5)], { type: "image/jpeg" }));
    assert.deepEqual([f.width, f.height], [1280, 640]);
  });
});

describe("captureVideoElementFrame (DOM falso)", () => {
  test("captura el cuadro actual como JPEG escalado", async () => {
    installDom();
    const v = new FakeVideo({});
    v.readyState = 4;
    v.videoWidth = 640;
    v.videoHeight = 480;
    const blob = await captureVideoElementFrame(v as unknown as HTMLVideoElement, 320);
    assert.equal(blob.type, "image/jpeg");
    assert.equal(blob.size, Math.round(320 * 240 * LIMITS.FRAME_JPEG_QUALITY * 0.3));
  });

  test("espera a que la cámara entregue imagen", async () => {
    installDom();
    const v = new FakeVideo({ neverLoad: true });
    // la imagen llega después de llamar
    setTimeout(() => {
      v.readyState = 4;
      v.videoWidth = 100;
      v.videoHeight = 50;
      v.dispatchEvent(new Event("loadeddata"));
    }, 10);
    const blob = await captureVideoElementFrame(v as unknown as HTMLVideoElement);
    assert.ok(blob.size > 0);
  });
});
