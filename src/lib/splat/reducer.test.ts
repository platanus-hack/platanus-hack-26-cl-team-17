import { test } from "node:test";
import assert from "node:assert/strict";
import type { Reconstruction, ReconstructionUpdate } from "@/lib/domain";
import { applyReconstructionUpdate } from "./reducer";
import { displayProgress, geometricConfidence, isReconstructionStale } from "./status";
import { INCIDENT_ID, REC_ID, reconstruction } from "./test-fixtures";

const NOW = "2026-11-21T10:05:00.000Z";
const ctx = { incidentId: INCIDENT_ID, now: NOW };
const PREFIX = `incidents/${INCIDENT_ID}/reconstructions/${REC_ID}/`;

function upd(extra: Partial<ReconstructionUpdate>): ReconstructionUpdate {
  return { reconstruction_id: REC_ID, status: "training", progress: 0.5, message: "", ...extra };
}

function applied(current: Reconstruction | null, u: ReconstructionUpdate) {
  const r = applyReconstructionUpdate(current, u, ctx);
  assert.equal(r.applied, true);
  if (!r.applied) throw new Error("no aplicado");
  return r;
}

test("una reconstrucción reemplazada o inexistente pide cancelar", () => {
  assert.deepEqual(applyReconstructionUpdate(null, upd({}), ctx), {
    applied: false,
    cancel: true,
    reason: "superseded",
  });
  const other = reconstruction({ id: "otra" });
  assert.equal(applyReconstructionUpdate(other, upd({}), ctx).cancel, true);
});

test("terminada: ready ignora más avisos sin cancelar; failed pide cancelar", () => {
  const ready = applyReconstructionUpdate(reconstruction({ status: "ready" }), upd({}), ctx);
  assert.deepEqual(ready, { applied: false, cancel: false, reason: "finished" });
  const failed = applyReconstructionUpdate(reconstruction({ status: "failed" }), upd({}), ctx);
  assert.deepEqual(failed, { applied: false, cancel: true, reason: "cancelled" });
});

test("el avance y la etapa son monotónicos y nunca llegan a 100 % antes de ready", () => {
  let cur = reconstruction();
  let r = applied(cur, upd({ status: "preparing", progress: 0.05, message: "Leyendo videos", gpu: "nvidia-l4" }));
  assert.equal(r.next.status, "preparing");
  assert.equal(r.next.started_at, NOW, "marca el inicio con la primera etapa real");
  assert.equal(r.next.message, "Leyendo videos");
  assert.equal(r.next.gpu, "nvidia-l4");
  assert.equal(r.event, null);
  assert.equal(r.cancel, false);
  cur = r.next;

  r = applied(cur, upd({ status: "training", progress: 0.6 }));
  assert.equal(r.next.progress, 0.6);
  assert.equal(r.next.message, "Entrenando la reconstrucción 3D…", "mensaje por defecto al cambiar de etapa");
  cur = r.next;

  // Llega tarde un aviso de una etapa anterior: no retrocede.
  r = applied(cur, upd({ status: "posing", progress: 0.2, message: "viejo" }));
  assert.equal(r.next.status, "training");
  assert.equal(r.next.progress, 0.6);
  assert.equal(r.next.message, cur.message);
  assert.equal(r.next.started_at, NOW);

  r = applied(cur, upd({ status: "exporting", progress: 1 }));
  assert.equal(r.next.progress, 0.99);
  assert.equal(r.next.finished_at, null);
});

test("ready válido: guarda resultado, 100 % y evento de línea de tiempo", () => {
  const transform = [1, 0, 0, 2, 0, 1, 0, 3, 0, 0, 1, 0, 0, 0, 0, 1];
  const r = applied(
    reconstruction({ status: "exporting", progress: 0.97, started_at: "2026-11-21T10:01:00.000Z" }),
    upd({
      status: "ready",
      progress: 1,
      splat_path: `${PREFIX}scene.splat`,
      splat_format: "splat",
      transform,
      alignment: "gps",
      scale_known: true,
      gaussians: 812345,
      iterations: 7000,
      gpu_seconds: 640,
      frames_registered: 37,
      frame_count: 40,
      gpu: "nvidia-rtx-pro-6000",
    }),
  );
  assert.equal(r.next.status, "ready");
  assert.equal(r.next.progress, 1);
  assert.equal(r.next.finished_at, NOW);
  assert.equal(r.next.started_at, "2026-11-21T10:01:00.000Z");
  assert.deepEqual(r.next.transform, transform);
  assert.equal(r.next.alignment, "gps");
  assert.equal(r.next.scale_known, true);
  assert.equal(r.next.frames_registered, 37);
  assert.equal(r.next.error, null);
  assert.ok(r.event);
  assert.equal(r.event.kind, "scene_updated");
  assert.equal(r.event.title, "Reconstrucción 3D lista");
  assert.match(r.event.detail, /37 de 40 cuadros registrados/);
  assert.match(r.event.detail, /alineada con gps/);
  assert.match(r.event.detail, /escala conocida/);
});

test("ready sin archivo o con ruta ajena se convierte en falla", () => {
  const cur = reconstruction({ status: "exporting" });
  const missing = applied(cur, upd({ status: "ready", progress: 1 }));
  assert.equal(missing.next.status, "failed");
  assert.match(missing.next.error ?? "", /sin entregar el archivo/);
  assert.equal(missing.event?.kind, "error");

  const foreign = applied(cur, upd({ status: "ready", progress: 1, splat_path: "incidents/otro/x.splat" }));
  assert.equal(foreign.next.status, "failed");
  assert.equal(foreign.next.splat_path, null);

  const traversal = applied(cur, upd({ status: "ready", progress: 1, splat_path: `${PREFIX}../../x.splat` }));
  assert.equal(traversal.next.status, "failed");
});

test("failed: guarda el error y emite evento", () => {
  const r = applied(
    reconstruction({ status: "posing", progress: 0.15 }),
    upd({ status: "failed", progress: 0.15, error: "COLMAP no registró cuadros", frames_registered: 0 }),
  );
  assert.equal(r.next.status, "failed");
  assert.equal(r.next.error, "COLMAP no registró cuadros");
  assert.equal(r.next.frames_registered, 0);
  assert.equal(r.next.finished_at, NOW);
  assert.equal(r.event?.kind, "error");
  assert.equal(r.event?.title, "Falló la reconstrucción 3D");
  assert.equal(r.cancel, false);

  const noDetail = applied(reconstruction(), upd({ status: "failed", progress: 0, message: "Cancelada" }));
  assert.equal(noDetail.next.error, "Cancelada");
});

test("vencimiento: en cola sin partir más de 20 min o más de 2 h en total", () => {
  const t0 = Date.parse("2026-11-21T10:00:00.000Z");
  const queued = reconstruction();
  assert.equal(isReconstructionStale(queued, t0 + 10 * 60_000), false);
  assert.equal(isReconstructionStale(queued, t0 + 21 * 60_000), true);
  const running = reconstruction({ status: "training", started_at: "2026-11-21T10:02:00.000Z" });
  assert.equal(isReconstructionStale(running, t0 + 60 * 60_000), false);
  assert.equal(isReconstructionStale(running, t0 + 121 * 60_000), true);
  assert.equal(isReconstructionStale(reconstruction({ status: "ready" }), t0 + 999 * 60_000), false);
});

test("avance mostrado: nunca menos que el piso de la etapa", () => {
  assert.equal(displayProgress({ status: "training", progress: 0.05 }), 0.2);
  assert.equal(displayProgress({ status: "training", progress: 0.7 }), 0.7);
  assert.equal(displayProgress({ status: "ready", progress: 0.9 }), 1);
});

test("confianza geométrica según alineación, escala y cuadros registrados", () => {
  const base = { frame_count: 100, frames_registered: 80 };
  assert.equal(geometricConfidence({ ...base, alignment: "gps", scale_known: true }).level, "high");
  assert.equal(geometricConfidence({ ...base, alignment: "approximate", scale_known: false }).level, "medium");
  assert.equal(geometricConfidence({ ...base, alignment: "none", scale_known: true }).level, "low");
  assert.equal(
    geometricConfidence({ frame_count: 100, frames_registered: 20, alignment: "gps", scale_known: true }).level,
    "low",
  );
});
