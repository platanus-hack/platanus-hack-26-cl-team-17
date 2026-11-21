import { test } from "node:test";
import assert from "node:assert/strict";
import { LIMITS } from "@/lib/domain";
import {
  NOTE_CHIPS,
  accuracyText,
  canSendWithoutLocation,
  chipText,
  classifyFile,
  composeNote,
  freeTextBudget,
  groupMandoFiles,
  headingApplies,
  isPoorAccuracy,
  mandoResultText,
  pickGallerySelection,
  toggleChip,
  vecinoStageView,
  videoOutcomeText,
  videoSizeNotice,
  RECENT_CAPTURE_MS,
} from "./report-core";

const file = (name: string, type: string, size = 1000, lastModified?: number) => ({ name, type, size, lastModified });

/* ───────────── nota ───────────── */

test("chipText respeta el orden fijo de los chips, no el de selección", () => {
  assert.equal(chipText(["injured", "people_inside"]), "Hay personas adentro. Hay heridos");
  assert.equal(chipText(new Set<string>()), "");
  assert.equal(chipText(["desconocido"]), "");
});

test("composeNote une chips y texto libre", () => {
  assert.equal(composeNote([], "  humo negro  "), "humo negro");
  assert.equal(composeNote(["gas_cylinders"], ""), "Hay cilindros de gas");
  assert.equal(composeNote(["gas_cylinders"], "  en el patio "), "Hay cilindros de gas. en el patio");
  assert.equal(composeNote(new Set(["downed_wires", "injured"]), "x"), "Hay heridos. Cables caídos. x");
});

test("composeNote nunca supera el máximo y el presupuesto descuenta los chips", () => {
  const all = NOTE_CHIPS.map((c) => c.id);
  const chips = chipText(all);
  const budget = freeTextBudget(all);
  assert.equal(budget, LIMITS.MAX_NOTE_CHARS - chips.length - 2);
  const long = "a".repeat(LIMITS.MAX_NOTE_CHARS * 2);
  const note = composeNote(all, long);
  assert.ok(note.length <= LIMITS.MAX_NOTE_CHARS);
  assert.ok(note.startsWith(chips));
  assert.equal(composeNote([], long).length, LIMITS.MAX_NOTE_CHARS);
  assert.equal(freeTextBudget([]), LIMITS.MAX_NOTE_CHARS);
  // Presupuesto pequeño: se recorta el texto libre, nunca los chips.
  assert.equal(composeNote(["injured"], "abcdef", 15), "Hay heridos. ab");
});

test("composeNote no deja medio emoji al recortar", () => {
  const note = composeNote([], "ab🔥", 3);
  assert.equal(note, "ab");
});

test("toggleChip devuelve un Set nuevo", () => {
  const a = new Set<string>();
  const b = toggleChip(a, "injured");
  assert.notEqual(a, b);
  assert.equal(a.size, 0);
  assert.ok(b.has("injured"));
  assert.equal(toggleChip(b, "injured").size, 0);
});

/* ───────────── archivos ───────────── */

test("classifyFile usa el MIME y, si falta, la extensión", () => {
  assert.equal(classifyFile(file("a.mp4", "video/mp4")), "video");
  assert.equal(classifyFile(file("a", "video/webm;codecs=vp9")), "video");
  assert.equal(classifyFile(file("IMG_1.HEIC", "")), "photo");
  assert.equal(classifyFile(file("clip.3gp", "")), "video");
  assert.equal(classifyFile(file("a.jpg", "image/jpeg")), "photo");
  assert.equal(classifyFile(file("doc.pdf", "application/pdf")), null);
  assert.equal(classifyFile(file("sin-extension", "")), null);
});

test("pickGallerySelection: un video gana y se usa solo ese", () => {
  const r = pickGallerySelection([file("a.jpg", "image/jpeg"), file("v.mov", "video/quicktime"), file("w.mp4", "video/mp4")]);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.kind, "video");
  assert.equal(r.files.length, 1);
  assert.equal(r.files[0].name, "v.mov");
  assert.match(r.notice ?? "", /solo el primer video/);
});

test("pickGallerySelection: varias fotos hasta el máximo, con avisos", () => {
  const photos = Array.from({ length: LIMITS.MAX_FRAMES_PER_MEDIA + 3 }, (_, i) => file(`f${i}.jpg`, "image/jpeg"));
  const r = pickGallerySelection([...photos, file("x.pdf", "application/pdf")]);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.kind, "photo");
  assert.equal(r.files.length, LIMITS.MAX_FRAMES_PER_MEDIA);
  assert.match(r.notice ?? "", /hasta 12 fotos/);
  assert.match(r.notice ?? "", /Un archivo no era video ni foto/);

  const one = pickGallerySelection([file("f.png", "image/png")]);
  assert.ok(one.ok && one.notice === null && one.files.length === 1);
});

test("pickGallerySelection: nada útil → error en español", () => {
  const empty = pickGallerySelection([]);
  assert.equal(empty.ok, false);
  const bad = pickGallerySelection([file("x.pdf", "application/pdf")]);
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.error, /no es un video ni una foto/);
});

test("videoSizeNotice solo sobre el máximo", () => {
  assert.equal(videoSizeNotice(LIMITS.MAX_VIDEO_BYTES), null);
  assert.match(videoSizeNotice(LIMITS.MAX_VIDEO_BYTES + 1) ?? "", /no el video completo/);
});

test("headingApplies: cámara de la página siempre; galería solo si es reciente", () => {
  const now = 1_000_000_000_000;
  assert.equal(headingApplies("capture", undefined, now), true);
  assert.equal(headingApplies("gallery", now - 60_000, now), true);
  assert.equal(headingApplies("gallery", now - RECENT_CAPTURE_MS - 1, now), false);
  assert.equal(headingApplies("gallery", now + 60_000, now), false);
  assert.equal(headingApplies("gallery", undefined, now), false);
});

/* ───────────── ubicación ───────────── */

test("accuracyText redondea y formatea", () => {
  assert.equal(accuracyText(23.4), "Precisión: ±25 m");
  assert.equal(accuracyText(1), "Precisión: ±5 m");
  assert.equal(accuracyText(143), "Precisión: ±140 m");
  assert.equal(accuracyText(1520), "Precisión: ±1,5 km");
  assert.equal(accuracyText(null), null);
  assert.equal(accuracyText(Number.NaN), null);
  assert.equal(isPoorAccuracy(400), true);
  assert.equal(isPoorAccuracy(30), false);
  assert.equal(isPoorAccuracy(null), false);
});

test("canSendWithoutLocation solo con código", () => {
  assert.equal(canSendWithoutLocation("VG-1234"), true);
  assert.equal(canSendWithoutLocation("  "), false);
  assert.equal(canSendWithoutLocation(undefined), false);
});

/* ───────────── etapas ───────────── */

test("vecinoStageView: textos de cada etapa", () => {
  const base = { kind: "video" as const, fraction: 0.1, framesDelivered: false };
  assert.equal(vecinoStageView({ ...base, stage: "extracting" }).title, "Preparando imágenes…");
  assert.equal(vecinoStageView({ ...base, stage: "uploading_frames" }).title, "Enviando imágenes…");
  assert.equal(vecinoStageView({ ...base, stage: "registering" }).delivered, false);

  const up = vecinoStageView({ ...base, stage: "uploading_video", stageFraction: 0.4, framesDelivered: true });
  assert.equal(up.title, "Bomberos ya recibió tus imágenes ✔");
  assert.match(up.detail ?? "", /no cierres esta página/);
  assert.equal(up.delivered, true);
  assert.equal(up.value, 0.4);

  // Sin fotogramas (navegador no pudo leer el video): no dice que Bomberos ya recibió.
  const raw = vecinoStageView({ ...base, stage: "uploading_video", stageFraction: 0.2 });
  assert.equal(raw.delivered, false);
  assert.equal(raw.title, "Enviando el video…");

  assert.equal(vecinoStageView({ ...base, stage: "analyzing_started" }).delivered, false);
  assert.equal(vecinoStageView({ ...base, stage: "analyzing_started", framesDelivered: true }).delivered, true);
  assert.equal(vecinoStageView({ ...base, kind: "photo", stage: "extracting" }).title, "Preparando fotos…");
  assert.equal(vecinoStageView({ ...base, stage: "done" }).value, 1);
});

test("videoOutcomeText", () => {
  assert.equal(videoOutcomeText({ kind: "photo", video: "none", framesUnsupported: false }), null);
  assert.equal(videoOutcomeText({ kind: "video", video: "uploaded", framesUnsupported: false })?.tone, "ok");
  assert.match(
    videoOutcomeText({ kind: "video", video: "uploaded", framesUnsupported: true })?.text ?? "",
    /lo enviamos completo/,
  );
  assert.equal(videoOutcomeText({ kind: "video", video: "failed", framesUnsupported: false })?.tone, "warning");
  assert.equal(
    videoOutcomeText({ kind: "video", video: "skipped_too_large", framesUnsupported: false, videoError: "pesado" })?.text,
    "pesado",
  );
});

test("mandoResultText muestra código y estado", () => {
  assert.equal(
    mandoResultText({ kind: "video", incidentCode: "VG-1234", framesSent: 8, video: "uploaded", framesUnsupported: false }),
    "VG-1234 · análisis en curso · 8 fotogramas · video original subido",
  );
  assert.equal(
    mandoResultText({ kind: "photo", incidentCode: "VG-1", framesSent: 1, video: "none", framesUnsupported: false }),
    "VG-1 · análisis en curso · 1 foto",
  );
  assert.match(
    mandoResultText({ kind: "video", incidentCode: "VG-2", framesSent: 0, video: "uploaded", framesUnsupported: true }),
    /el servidor los extraerá/,
  );
});

test("groupMandoFiles: un medio por video; fotos juntas de a MAX; ignora lo demás", () => {
  const f = (name: string, type: string) => ({ name, type, size: 10 });
  const photos = Array.from({ length: LIMITS.MAX_FRAMES_PER_MEDIA + 2 }, (_, i) => f(`p${i}.jpg`, "image/jpeg"));
  const { groups, ignored } = groupMandoFiles([f("a.mp4", "video/mp4"), ...photos, f("doc.pdf", "application/pdf"), f("b.mov", "")]);
  assert.equal(ignored, 1);
  assert.deepEqual(
    groups.map((g) => [g.kind, g.files.length]),
    [
      ["video", 1],
      ["video", 1],
      ["photo", LIMITS.MAX_FRAMES_PER_MEDIA],
      ["photo", 2],
    ],
  );
  assert.equal(groups[1].files[0].name, "b.mov");
  assert.deepEqual(groupMandoFiles([]), { groups: [], ignored: 0 });
});
