import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { LIMITS, type Media, type MediaFrame } from "@/lib/domain";
import { storagePaths, type FileStorage, type NewFrame, type Store } from "@/lib/store/types";
import {
  FFMPEG_UNAVAILABLE_MESSAGE,
  ServerFramesError,
  chooseFrameTimes,
  extractFramesOnServer,
  ffprobePathFor,
  isJpeg,
  jpegSize,
  parseClock,
} from "./server-frames";

const INCIDENT_ID = "11111111-2222-3333-4444-555555555555";
const MEDIA_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function makeMedia(over: Partial<Media> = {}): Media {
  return {
    id: MEDIA_ID,
    incident_id: INCIDENT_ID,
    label: "M1",
    source: "citizen",
    kind: "video",
    mission_id: null,
    video_path: storagePaths.video(INCIDENT_ID, MEDIA_ID, "mp4"),
    video_status: "uploaded",
    mime: "video/mp4",
    size_bytes: null,
    duration_s: null,
    lat: null,
    lng: null,
    accuracy_m: null,
    heading_deg: null,
    captured_at: null,
    reporter_note: "",
    status: "uploaded",
    error: null,
    analysis: null,
    analysis_engine: null,
    analyzed_at: null,
    frames: [],
    created_at: "2026-11-21T12:00:00.000Z",
    ...over,
  };
}

interface Fakes {
  store: Store;
  files: FileStorage;
  uploads: { path: string; bytes: Uint8Array; contentType: string }[];
  added: { mediaId: string; frames: NewFrame[] }[];
}

function makeFakes(video: Uint8Array | null): Fakes {
  const uploads: Fakes["uploads"] = [];
  const added: Fakes["added"] = [];
  const files = {
    kind: "local",
    async download(p: string) {
      if (!video) throw new Error(`no existe ${p}`);
      return { bytes: video, contentType: "video/mp4" };
    },
    async upload(p: string, bytes: Uint8Array, contentType: string) {
      uploads.push({ path: p, bytes, contentType });
    },
  } as unknown as FileStorage;
  const store = {
    kind: "local",
    async addFrames(mediaId: string, frames: NewFrame[]): Promise<MediaFrame[]> {
      added.push({ mediaId, frames });
      return frames.map((f, i) => ({ ...f, id: `frame-${i}`, media_id: mediaId }));
    },
  } as unknown as Store;
  return { store, files, uploads, added };
}

describe("chooseFrameTimes", () => {
  test("duración inválida → [0]", () => {
    assert.deepEqual(chooseFrameTimes(0), [0]);
    assert.deepEqual(chooseFrameTimes(-5), [0]);
    assert.deepEqual(chooseFrameTimes(Number.NaN), [0]);
    assert.deepEqual(chooseFrameTimes(Number.POSITIVE_INFINITY), [0]);
  });

  test("8 s → 4 instantes que evitan el 3 % de los bordes", () => {
    const t = chooseFrameTimes(8);
    assert.equal(t.length, 4);
    assert.equal(t[0], 0.24);
    assert.equal(t[3], 7.76);
    for (let i = 0; i < 4; i++) assert.equal(t[i], Math.round(8 * (0.03 + (0.94 * i) / 3) * 1000) / 1000);
  });

  test("n = clamp(round(dur/3), 4, máximo)", () => {
    assert.equal(chooseFrameTimes(1).length, 4);
    assert.equal(chooseFrameTimes(18).length, 6);
    assert.equal(chooseFrameTimes(19.4).length, 6);
    assert.equal(chooseFrameTimes(600).length, LIMITS.MAX_FRAMES_PER_MEDIA);
  });

  test("instantes crecientes y dentro del video", () => {
    for (const d of [0.01, 0.5, 2, 30, 125.7]) {
      const t = chooseFrameTimes(d);
      for (let i = 1; i < t.length; i++) assert.ok(t[i] > t[i - 1]);
      assert.ok(t[0] >= 0 && t[t.length - 1] <= d);
    }
  });
});

describe("utilidades", () => {
  test("ffprobePathFor", () => {
    assert.equal(ffprobePathFor("ffmpeg"), "ffprobe");
    assert.equal(ffprobePathFor("/usr/bin/ffmpeg"), "/usr/bin/ffprobe");
    assert.equal(ffprobePathFor("./bin/ffmpeg-7"), "./bin/ffprobe-7");
    assert.equal(ffprobePathFor("/opt/ff/run"), "/opt/ff/ffprobe");
  });

  test("parseClock", () => {
    assert.equal(parseClock("00:00:08.00"), 8);
    assert.equal(parseClock("01:02:03.5"), 3723.5);
    assert.equal(parseClock("N/A"), null);
  });

  test("jpegSize rechaza lo que no es JPEG", () => {
    assert.equal(jpegSize(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), null);
    assert.equal(jpegSize(new Uint8Array([0xff, 0xd8, 0xff, 0xd9])), null);
  });
});

describe("extractFramesOnServer (ffmpeg real)", () => {
  let work: string;
  let video640: Uint8Array;
  let video1080: Uint8Array;

  before(async () => {
    work = await mkdtemp(path.join(os.tmpdir(), "vigia-sf-test-"));
    const gen = (name: string, size: string, duration: number) => {
      const out = path.join(work, name);
      execFileSync("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", `testsrc=duration=${duration}:size=${size}:rate=10`,
        "-pix_fmt", "yuv420p", out,
      ]);
      return out;
    };
    video640 = new Uint8Array(await readFile(gen("a.mp4", "640x360", 8)));
    video1080 = new Uint8Array(await readFile(gen("b.mp4", "1920x1080", 2)));
  });

  after(async () => {
    await rm(work, { recursive: true, force: true });
  });

  test("video de 8 s 640×360 → 4 JPEG subidos y registrados; temporales borrados", async () => {
    const tmpRoot = await mkdtemp(path.join(work, "tmp-"));
    const f = makeFakes(video640);
    const frames = await extractFramesOnServer(makeMedia(), { store: f.store, files: f.files, tmpRoot });

    assert.equal(frames.length, 4);
    assert.equal(f.uploads.length, 4);
    assert.equal(f.added.length, 1);
    assert.equal(f.added[0].mediaId, MEDIA_ID);
    assert.deepEqual(
      f.added[0].frames.map((x) => x.t_s),
      chooseFrameTimes(8),
    );
    f.uploads.forEach((u, i) => {
      assert.equal(u.contentType, "image/jpeg");
      assert.equal(u.path, storagePaths.frame(INCIDENT_ID, MEDIA_ID, i));
      assert.ok(isJpeg(u.bytes), "bytes mágicos JPEG");
      assert.deepEqual(jpegSize(u.bytes), { width: 640, height: 360 });
    });
    frames.forEach((fr, i) => {
      assert.equal(fr.idx, i);
      assert.equal(fr.width, 640);
      assert.equal(fr.height, 360);
      assert.ok(fr.width <= LIMITS.FRAME_LONG_EDGE_PX);
      assert.equal(fr.lat, null);
      assert.equal(fr.lng, null);
      assert.equal(fr.alt_m, null);
      assert.equal(fr.heading_deg, null);
      assert.equal(fr.storage_path, f.uploads[i].path);
    });
    assert.deepEqual(await readdir(tmpRoot), [], "el directorio temporal se borra");
  });

  test("usa duration_s del medio si viene informada", async () => {
    const tmpRoot = await mkdtemp(path.join(work, "tmp-"));
    const f = makeFakes(video640);
    const frames = await extractFramesOnServer(makeMedia({ duration_s: 4 }), {
      store: f.store,
      files: f.files,
      tmpRoot,
    });
    assert.deepEqual(
      frames.map((x) => x.t_s),
      chooseFrameTimes(4),
    );
  });

  test("1920×1080 se reduce a 1280×720", async () => {
    const tmpRoot = await mkdtemp(path.join(work, "tmp-"));
    const f = makeFakes(video1080);
    const frames = await extractFramesOnServer(makeMedia(), { store: f.store, files: f.files, tmpRoot });
    assert.equal(frames.length, 4);
    for (const u of f.uploads) assert.deepEqual(jpegSize(u.bytes), { width: 1280, height: 720 });
    for (const fr of frames) {
      assert.equal(fr.width, 1280);
      assert.equal(fr.height, 720);
    }
    assert.deepEqual(await readdir(tmpRoot), []);
  });

  test("sin ffprobe junto a ffmpeg: la duración sale de la cabecera de ffmpeg -i", async () => {
    const binDir = await mkdtemp(path.join(work, "bin-"));
    const real = execFileSync("sh", ["-c", "command -v ffmpeg"], { encoding: "utf8" }).trim();
    const linked = path.join(binDir, "ffmpeg");
    await symlink(real, linked);
    const tmpRoot = await mkdtemp(path.join(work, "tmp-"));
    const f = makeFakes(video640);
    const frames = await extractFramesOnServer(makeMedia(), {
      store: f.store,
      files: f.files,
      tmpRoot,
      ffmpegPath: linked,
    });
    assert.deepEqual(
      frames.map((x) => x.t_s),
      chooseFrameTimes(8),
    );
  });

  test("ffmpeg inexistente → ServerFramesError con mensaje para el operador", async () => {
    const tmpRoot = await mkdtemp(path.join(work, "tmp-"));
    const f = makeFakes(video640);
    await assert.rejects(
      extractFramesOnServer(makeMedia(), {
        store: f.store,
        files: f.files,
        tmpRoot,
        ffmpegPath: path.join(work, "no-existe", "ffmpeg"),
      }),
      (err: unknown) => err instanceof ServerFramesError && err.message === FFMPEG_UNAVAILABLE_MESSAGE,
    );
    assert.equal(f.uploads.length, 0);
    assert.equal(f.added.length, 0);
    assert.deepEqual(await readdir(tmpRoot), []);
  });

  test("sin video_path → ServerFramesError", async () => {
    const f = makeFakes(video640);
    await assert.rejects(
      extractFramesOnServer(makeMedia({ video_path: null }), { store: f.store, files: f.files }),
      ServerFramesError,
    );
  });

  test("archivo que no es video → ServerFramesError y sin registros", async () => {
    const tmpRoot = await mkdtemp(path.join(work, "tmp-"));
    const f = makeFakes(new TextEncoder().encode("esto no es un video"));
    await assert.rejects(
      extractFramesOnServer(makeMedia({ duration_s: 8 }), { store: f.store, files: f.files, tmpRoot }),
      ServerFramesError,
    );
    assert.equal(f.added.length, 0);
    assert.deepEqual(await readdir(tmpRoot), []);
  });

  test("falla la descarga → ServerFramesError", async () => {
    const f = makeFakes(null);
    await assert.rejects(extractFramesOnServer(makeMedia(), { store: f.store, files: f.files }), ServerFramesError);
  });
});
