import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BriefingSnapshot, RuntimeMode, UnchangedResponse } from "@/lib/contract";
import type { Incident } from "@/lib/domain";
import type { Store } from "@/lib/store/types";
import type { VigiaUtterance } from "@/lib/vigia/types";
import { analysis, ev, media, situation } from "./fixtures.test-helpers";

const dir = mkdtempSync(path.join(os.tmpdir(), "vigia-briefing-"));
process.env.VIGIA_DATA_DIR = dir;
delete process.env.DATABASE_URL;
delete process.env.GCS_BUCKET;

type Briefing = typeof import("./briefing");
let B: Briefing;
let store: Store;

before(async () => {
  B = await import("./briefing");
  const { createLocalStore } = await import("@/lib/store/local");
  store = createLocalStore();
});
after(() => rmSync(dir, { recursive: true, force: true }));

const MODE: RuntimeMode = { store: "local", files: "local", ai: "simulated", auth: "open", model: null };
const yes = async () => true;
const no = async () => false;

function isUnchanged(r: BriefingSnapshot | UnchangedResponse): r is UnchangedResponse {
  return r.unchanged === true;
}

describe("selectKeyFrames", () => {
  const m1 = media({ id: "m1", label: "M1", analysis: analysis([{ frame: 2, caption: "Fachada con humo negro" }]) });
  const m2 = media({ id: "m2", label: "M2", frameCount: 5, analysis: analysis([{ frame: 4, caption: "Cilindro de gas" }, { frame: 1, caption: "Patio" }]) });
  const m3 = media({ id: "m3", label: "M3" });

  test("prioriza evidencia de atrapados, luego hallazgos críticos y peligros altos", () => {
    const sit = situation({
      trapped: { status: "probable", evidence: [ev("M2", 3, "Persona en la ventana del 2º piso"), ev("C4", -1, "Radio")] },
      insights: [
        { id: "I2", category: "access", priority: "high", title: "Acceso por pasaje", detail: "", confidence: "medium", evidence: [ev("M3", 1)] },
        { id: "I1", category: "hazard", priority: "critical", title: "Cilindro junto al foco", detail: "", confidence: "high", evidence: [ev("M2", 4, "Cilindro bajo la ventana")] },
      ],
      hazards: [
        { kind: "power_lines", description: "Cables cortados", severity: "high", evidence: [ev("M1", 0, "")] },
        { kind: "traffic", description: "Tránsito", severity: "low", evidence: [ev("M1", 1, "No debería salir antes")] },
      ],
    });
    const kf = B.selectKeyFrames(sit, [m1, m2, m3], "KEY");
    assert.deepEqual(
      kf.map((k) => `${k.media_label}:${k.frame}`),
      ["M2:3", "M2:4", "M1:0", "M3:1", "M1:2", "M2:1"],
    );
    assert.equal(kf.length, B.MAX_BRIEFING_KEY_FRAMES);
    assert.equal(kf[0].caption, "Persona en la ventana del 2º piso");
    assert.equal(kf[2].caption, "Cables cortados"); // sin nota: descripción del peligro
    assert.equal(kf[3].caption, "Acceso por pasaje"); // sin nota: título del hallazgo
    assert.ok(kf.every((k) => k.url.startsWith("/api/files/") && k.url.endsWith("?k=KEY")));
  });

  test("sin informe usa los fotogramas clave de cada medio y luego el primero de los demás", () => {
    const kf = B.selectKeyFrames(null, [m3, m2, m1], null);
    assert.deepEqual(kf.map((k) => `${k.media_label}:${k.frame}`), ["M1:2", "M2:4", "M2:1", "M3:0"]);
    assert.ok(kf.every((k) => !k.url.includes("?k=")));
    assert.equal(kf[3].caption, "Imagen de M3"); // sin análisis ni resumen
  });

  test("no repite cuadros, ignora índices inexistentes y medios que aún suben", () => {
    const uploading = media({ id: "m4", label: "M4", status: "uploading" });
    const sit = situation({
      trapped: { status: "possible", evidence: [ev("M1", 2, "a"), ev("M1", 2, "b"), ev("M1", 99, "no existe"), ev("M4", 0, "subiendo"), ev("m1", -1, "sin cuadro")] },
    });
    const kf = B.selectKeyFrames(sit, [m1, uploading], null);
    assert.deepEqual(kf.map((k) => `${k.media_label}:${k.frame}:${k.caption}`), ["M1:2:a"]);
  });

  test("sin medios con imágenes, lista vacía", () => {
    assert.deepEqual(B.selectKeyFrames(situation(), [media({ id: "x", label: "M1", frameCount: 0 })], "k"), []);
  });
});

describe("loadBriefing", () => {
  async function seeded(): Promise<Incident> {
    const inc = await store.createIncident({
      type: "structure_fire",
      title: "Incendio",
      address: "Av. Matta 1234",
      lat: -33.45,
      lng: -70.64,
      description: "",
      origin: "command",
      verified: true,
    });
    const m = await store.createMedia({ incident_id: inc.id, source: "citizen", kind: "video", reporter_note: "Mi vecino Juan está adentro" });
    await store.addFrames(m.id, [
      { idx: 0, t_s: 0, width: 10, height: 10, storage_path: `incidents/${inc.id}/media/${m.id}/frames/000.jpg`, lat: null, lng: null, alt_m: null, heading_deg: null },
    ]);
    await store.updateMedia(m.id, { status: "analyzed", analysis: analysis([{ frame: 0, caption: "Fachada" }]), analysis_engine: "simulated" });
    return store.updateIncident(inc.id, {
      situation: situation({ trapped: { status: "possible", evidence: [ev(m.label, 0, "Vecino informa persona adentro")] } }),
      situation_engine: "simulated",
    });
  }

  test("con la clave correcta entrega el briefing sin share_key ni notas de vecinos", async () => {
    const inc = await seeded();
    const r = await B.loadBriefing(store, inc.id, { key: inc.share_key, rev: null, hasStaffSession: no, mode: MODE });
    assert.ok(!isUnchanged(r));
    assert.equal(r.incident.id, inc.id);
    assert.equal(r.incident.situation_engine, "simulated");
    assert.equal(r.situation?.trapped.status, "possible");
    assert.equal(r.media_count, 1);
    assert.equal(r.key_frames.length, 1);
    assert.ok(r.key_frames[0].url.endsWith(`?k=${encodeURIComponent(inc.share_key)}`));
    assert.equal("share_key" in r.incident, false);
    assert.equal(JSON.stringify(r).includes("Mi vecino Juan"), false);
  });

  test("clave incorrecta o ausente sin sesión → 404 (aunque haya sesión, la clave mala no pasa)", async () => {
    const inc = await seeded();
    await assert.rejects(B.loadBriefing(store, inc.id, { key: "otra", rev: null, hasStaffSession: yes, mode: MODE }), { status: 404 });
    await assert.rejects(B.loadBriefing(store, inc.id, { key: null, rev: null, hasStaffSession: no, mode: MODE }), { status: 404 });
    await assert.rejects(
      B.loadBriefing(store, "00000000-0000-4000-8000-000000000000", { key: inc.share_key, rev: null, hasStaffSession: yes, mode: MODE }),
      { status: 404 },
    );
    const staff = await B.loadBriefing(store, inc.id, { key: null, rev: null, hasStaffSession: yes, mode: MODE });
    assert.ok(!isUnchanged(staff));
  });

  test("?rev= igual al actual → sin cambios", async () => {
    const inc = await seeded();
    const now = new Date("2026-11-21T15:00:00.000Z");
    const rev = (await store.getIncidentRev(inc.id)) ?? -1;
    const r = await B.loadBriefing(store, inc.id, { key: inc.share_key, rev, hasStaffSession: no, mode: MODE, now });
    assert.deepEqual(r, { unchanged: true, rev, server_time: now.toISOString() });
    const stale = await B.loadBriefing(store, inc.id, { key: inc.share_key, rev: rev - 1, hasStaffSession: no, mode: MODE, now });
    assert.ok(!isUnchanged(stale));
  });
});

describe("selectBriefingVigia", () => {
  const u = (seq: number, over: Partial<VigiaUtterance> = {}): VigiaUtterance => ({
    id: `u${seq}`,
    seq,
    incident_id: "inc",
    at: new Date(Date.UTC(2026, 10, 21, 12, seq)).toISOString(),
    text: `OBAC, Vigía: mensaje ${seq}.`,
    priority: "persona",
    kind: "alerta",
    speak: true,
    evidence: [],
    confidence: null,
    engine: "claude",
    rules: [],
    claves: null,
    reply_to: null,
    ...over,
  });

  test("solo personas o riesgo, sin propuestas, el más nuevo de cada tipo y máximo 3", () => {
    const out = B.selectBriefingVigia([
      u(1, { kind: "pendiente" }),
      u(2, { kind: "pendiente", priority: "riesgo" }),
      u(3, { kind: "propuesta" }),
      u(4, { kind: "resumen", priority: "recursos" }),
      u(5, { kind: "alerta" }),
      u(6, { kind: "contradiccion", priority: "riesgo" }),
      u(7, { kind: "pedido_video" }),
    ]);
    assert.deepEqual(out.map((m) => m.id), ["u7", "u6", "u5"]);
    const all = B.selectBriefingVigia([u(1, { kind: "pendiente" }), u(2, { kind: "pendiente", priority: "riesgo" })], 5);
    assert.deepEqual(all.map((m) => m.id), ["u2"]);
  });

  test("quita el «OBAC, Vigía:» y parte con mayúscula", () => {
    const [m] = B.selectBriefingVigia([u(1, { text: "OBAC, Vigía: sigue pendiente 1-2." })]);
    assert.equal(m.text, "Sigue pendiente 1-2.");
    assert.equal(m.priority, "persona");
  });
});
