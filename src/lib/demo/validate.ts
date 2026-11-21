/**
 * Validación de los datos de demostración: esquemas Zod, referencias a evidencia,
 * cronología y coherencia geométrica de la escena. Devuelve la lista de problemas
 * (vacía si todo calza). La usan las pruebas; no corre en producción.
 */
import {
  CommsAnalysisAISchema,
  MediaAnalysisAISchema,
  SceneModelAISchema,
  SituationReportAISchema,
  type EvidenceRef,
  type SceneModel,
} from "@/lib/domain";
import { headingVector } from "@/lib/geo";
import type { DemoMediaSpec, ScenarioScript, ShowcaseSpec } from "./types";

type XY = { x: number; y: number };

function zodProblems(where: string, schema: { safeParse(v: unknown): { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } } }, value: unknown): string[] {
  const r = schema.safeParse(value);
  if (r.success) return [];
  return (r.error?.issues ?? []).map((i) => `${where}: ${i.path.map(String).join(".")} — ${i.message}`);
}

/** Cuántos fotogramas tiene cada etiqueta de medio, y cuántas entradas de radio hay. */
interface Sources {
  frames: Map<string, number>;
  comms: number;
}

function refProblems(where: string, refs: EvidenceRef[], src: Sources): string[] {
  const out: string[] = [];
  for (const r of refs) {
    const m = /^([MC])(\d+)$/.exec(r.ref);
    if (!m) {
      out.push(`${where}: etiqueta inválida "${r.ref}"`);
      continue;
    }
    if (m[1] === "M") {
      const n = src.frames.get(r.ref);
      if (n === undefined) out.push(`${where}: ${r.ref} no existe`);
      else if (r.frame !== -1 && (r.frame < 0 || r.frame >= n || !Number.isInteger(r.frame)))
        out.push(`${where}: ${r.ref} no tiene fotograma ${r.frame} (tiene ${n})`);
    } else {
      const seq = Number(m[2]);
      if (seq < 1 || seq > src.comms) out.push(`${where}: ${r.ref} no existe (hay ${src.comms} entradas)`);
      if (r.frame !== -1) out.push(`${where}: ${r.ref} es radio, frame debe ser -1`);
    }
    if (!r.note.trim()) out.push(`${where}: ${r.ref} sin nota`);
  }
  return out;
}

function mediaProblems(where: string, m: DemoMediaSpec | Omit<DemoMediaSpec, "captured_at_s" | "received_at_s" | "analyzed_at_s">): string[] {
  const out = zodProblems(`${where}.analysis`, MediaAnalysisAISchema, m.analysis);
  const n = m.frames.length;
  if (n < 2 || n > 6) out.push(`${where}: debe tener 2 a 6 fotogramas (tiene ${n})`);
  const idxOk = (i: number) => Number.isInteger(i) && i >= 0 && i < n;
  const a = m.analysis;
  for (const p of a.people ?? []) for (const f of p.frame_refs) if (!idxOk(f)) out.push(`${where}: people.frame_refs ${f} fuera de rango`);
  for (const v of a.vehicles ?? []) for (const f of v.frame_refs) if (!idxOk(f)) out.push(`${where}: vehicles.frame_refs ${f} fuera de rango`);
  for (const h of a.hazards ?? []) for (const f of h.frame_refs) if (!idxOk(f)) out.push(`${where}: hazards.frame_refs ${f} fuera de rango`);
  for (const k of a.key_frames ?? []) if (!idxOk(k.frame)) out.push(`${where}: key_frames ${k.frame} fuera de rango`);
  if ((a.key_frames ?? []).length < 1 || (a.key_frames ?? []).length > 4) out.push(`${where}: key_frames debe tener 1 a 4`);
  if (m.source === "drone" && a.viewpoint?.elevation !== "aerial") out.push(`${where}: lote de dron con elevation distinta de "aerial"`);
  for (let i = 1; i < n; i++) if (m.frames[i].t_s < m.frames[i - 1].t_s) out.push(`${where}: t_s de fotogramas no crece`);
  if (m.duration_s !== null && n > 0 && m.frames[n - 1].t_s > m.duration_s) out.push(`${where}: fotograma después del fin del video`);
  for (const f of m.frames) if (!f.poster.caption.trim()) out.push(`${where}: póster sin caption`);
  return out;
}

/* ───────────── Geometría ───────────── */

type Structure = SceneModel["structures"][number];
type Road = SceneModel["roads"][number];

/** Coordenadas del punto en el marco de la estructura: u a lo largo de la fachada, v hacia el frente. */
function inStructureFrame(s: Structure, p: XY): { u: number; v: number } {
  const n = headingVector(s.rotation_deg);
  const t = headingVector(s.rotation_deg + 90);
  const dx = p.x - s.x;
  const dy = p.y - s.y;
  return { u: dx * t.x + dy * t.y, v: dx * n.x + dy * n.y };
}

export function insideStructure(s: Structure, p: XY, marginM = 0): boolean {
  const { u, v } = inStructureFrame(s, p);
  return Math.abs(u) < s.width_m / 2 - marginM && Math.abs(v) < s.depth_m / 2 - marginM;
}

function structureSamples(s: Structure): XY[] {
  const n = headingVector(s.rotation_deg);
  const t = headingVector(s.rotation_deg + 90);
  const out: XY[] = [];
  for (const a of [-0.5, -0.25, 0, 0.25, 0.5])
    for (const b of [-0.5, -0.25, 0, 0.25, 0.5])
      out.push({ x: s.x + t.x * a * s.width_m + n.x * b * s.depth_m, y: s.y + t.y * a * s.width_m + n.y * b * s.depth_m });
  return out;
}

export function distToSegment(p: XY, r: Pick<Road, "x1" | "y1" | "x2" | "y2">): number {
  const dx = r.x2 - r.x1;
  const dy = r.y2 - r.y1;
  const len2 = dx * dx + dy * dy || 1;
  const k = Math.max(0, Math.min(1, ((p.x - r.x1) * dx + (p.y - r.y1) * dy) / len2));
  return Math.hypot(p.x - (r.x1 + k * dx), p.y - (r.y1 + k * dy));
}

function rectsOverlap(a: Structure, b: Structure): boolean {
  return structureSamples(a).some((p) => insideStructure(b, p, 0.3)) || structureSamples(b).some((p) => insideStructure(a, p, 0.3));
}

export function sceneProblems(scene: SceneModel, src: Sources): string[] {
  const out = zodProblems("scene", SceneModelAISchema, scene);
  const ids = new Set<string>();
  const dup = (id: string) => {
    if (ids.has(id)) out.push(`scene: id duplicado "${id}"`);
    ids.add(id);
  };
  scene.structures.forEach((s) => dup(s.id));
  scene.roads.forEach((r) => dup(r.id));
  scene.fire_zones.forEach((f) => dup(f.id));
  scene.people.forEach((p) => dup(p.id));
  scene.vehicles.forEach((v) => dup(v.id));
  scene.hazards.forEach((h) => dup(h.id));
  scene.access_points.forEach((a) => dup(a.id));
  scene.smoke_plumes.forEach((s) => dup(s.id));
  const byId = new Map(scene.structures.map((s) => [s.id, s]));

  for (const s of scene.structures) {
    for (const r of scene.roads)
      if (structureSamples(s).some((p) => distToSegment(p, r) < r.width_m / 2 - 0.2))
        out.push(`scene: estructura ${s.id} se monta sobre la calle ${r.id}`);
    if (s.floors < 1) out.push(`scene: estructura ${s.id} sin pisos`);
  }
  for (let i = 0; i < scene.structures.length; i++)
    for (let j = i + 1; j < scene.structures.length; j++)
      if (rectsOverlap(scene.structures[i], scene.structures[j]))
        out.push(`scene: estructuras ${scene.structures[i].id} y ${scene.structures[j].id} se superponen`);

  const outsideAll = (what: string, p: XY) => {
    for (const s of scene.structures) if (insideStructure(s, p, 0.2)) out.push(`scene: ${what} está dentro de ${s.id}`);
  };
  for (const c of scene.cameras) {
    if (!src.frames.has(c.media_ref)) out.push(`scene: cámara de ${c.media_ref} que no existe`);
    if (c.z < 20) outsideAll(`cámara ${c.media_ref}`, c);
  }
  for (const a of scene.access_points) {
    if (a.kind === "hydrant" || a.kind === "staging" || a.kind === "command_post" || a.kind === "street_entry")
      outsideAll(`acceso ${a.id} (${a.kind})`, a);
    if (a.kind === "hydrant" && scene.roads.some((r) => distToSegment(a, r) < r.width_m / 2 - 0.3))
      out.push(`scene: grifo ${a.id} está en la calzada, no en la vereda`);
  }
  for (const f of scene.fire_zones) {
    if (f.structure_id) {
      const s = byId.get(f.structure_id);
      if (!s) out.push(`scene: foco ${f.id} en estructura inexistente ${f.structure_id}`);
      else {
        if (!insideStructure(s, f, -1)) out.push(`scene: foco ${f.id} fuera de la planta de ${s.id}`);
        if (f.floor > s.floors) out.push(`scene: foco ${f.id} en piso ${f.floor} de una estructura de ${s.floors}`);
        const top = s.floors * s.floor_height_m;
        if (f.z < 0 || f.z > top + 1) out.push(`scene: foco ${f.id} a z=${f.z} fuera de la altura de ${s.id}`);
      }
    }
  }
  for (const p of scene.people) {
    out.push(...refProblems(`scene.people ${p.id}`, p.evidence, src));
    if (p.structure_id) {
      const s = byId.get(p.structure_id);
      if (!s) out.push(`scene: persona ${p.id} en estructura inexistente`);
      else {
        if (!insideStructure(s, p, -1.5)) out.push(`scene: persona ${p.id} lejos de ${s.id}`);
        if (p.floor > s.floors) out.push(`scene: persona ${p.id} en piso inexistente`);
      }
    }
  }
  for (const v of scene.vehicles) outsideAll(`vehículo ${v.id}`, v);
  return out;
}

/* ───────────── Vitrinas y guion ───────────── */

export function validateShowcase(spec: ShowcaseSpec): string[] {
  const out: string[] = [];
  const src: Sources = {
    frames: new Map(spec.media.map((m, i) => [`M${i + 1}`, m.frames.length])),
    comms: spec.comms.length,
  };
  spec.media.forEach((m, i) => {
    out.push(...mediaProblems(`M${i + 1}`, m));
    if (!(m.captured_at_s <= m.received_at_s && m.received_at_s < m.analyzed_at_s))
      out.push(`M${i + 1}: cronología captured ≤ received < analyzed no se cumple`);
    if (m.source === "drone" && !spec.mission) out.push(`M${i + 1}: lote de dron sin misión`);
    if (m.source === "drone" && spec.mission && m.captured_at_s < spec.mission.started_at_s)
      out.push(`M${i + 1}: cuadros de dron antes del despegue`);
    if (m.analyzed_at_s > spec.started_min_ago * 60) out.push(`M${i + 1}: analizado en el futuro`);
    const cam = spec.scene.cameras.find((c) => c.media_ref === `M${i + 1}`);
    if (!cam) out.push(`M${i + 1}: falta su cámara en la escena`);
    else if (Math.hypot(cam.x - m.camera.x, cam.y - m.camera.y) > 6)
      out.push(`M${i + 1}: cámara de la escena a más de 6 m de la posición del medio`);
  });
  for (let i = 1; i < spec.comms.length; i++)
    if (spec.comms[i].at_s < spec.comms[i - 1].at_s) out.push(`C${i + 1}: fuera de orden`);
  if (spec.comms.some((c) => c.at_s > spec.started_min_ago * 60)) out.push("comms: entrada en el futuro");
  for (const c of spec.comms) if (/\b\d-\d{1,2}\b|clave\s+\d/i.test(c.text)) out.push(`comms: posible clave numérica inventada en "${c.text.slice(0, 50)}"`);

  out.push(...zodProblems("comms_analysis", CommsAnalysisAISchema, spec.comms_analysis));
  for (const e of spec.comms_analysis.events ?? [])
    if (e.entry_seq < 1 || e.entry_seq > src.comms) out.push(`comms_analysis: entry_seq ${e.entry_seq} no existe`);
  for (const s of spec.comms_analysis.victims?.entry_seqs ?? [])
    if (s < 1 || s > src.comms) out.push(`comms_analysis.victims: entry_seq ${s} no existe`);

  out.push(...zodProblems("situation", SituationReportAISchema, spec.situation));
  const sit = spec.situation;
  if (sit?.trapped) out.push(...refProblems("situation.trapped", sit.trapped.evidence, src));
  for (const h of sit?.hazards ?? []) out.push(...refProblems(`situation.hazards ${h.kind}`, h.evidence, src));
  for (const ins of sit?.insights ?? []) out.push(...refProblems(`situation.insights ${ins.id}`, ins.evidence, src));
  const sourceExists = (s: string) =>
    /^M\d+$/.test(s) ? src.frames.has(s) : /^C\d+$/.test(s) && Number(s.slice(1)) >= 1 && Number(s.slice(1)) <= src.comms;
  for (const c of sit?.contradictions ?? [])
    for (const s of c.sources) if (!sourceExists(s)) out.push(`situation.contradictions: fuente ${s} no existe`);
  if ((sit?.insights ?? []).length > 10) out.push("situation: más de 10 insights");
  if ((sit?.recommended_actions ?? []).length > 6) out.push("situation: más de 6 acciones");
  const words = (sit?.briefing?.spoken ?? "").trim().split(/\s+/).length;
  if (words > 90) out.push(`situation.briefing.spoken: ${words} palabras (máx. 90)`);
  const bl = (sit?.briefing?.bullets ?? []).length;
  if (bl < 5 || bl > 8) out.push(`situation.briefing.bullets: ${bl} (deben ser 5 a 8)`);
  if (sit && sit.trapped.count_max < sit.trapped.count_min) out.push("situation.trapped: count_max < count_min");

  out.push(...sceneProblems(spec.scene, src));

  for (const e of spec.events) {
    if (e.media !== undefined && (e.media < 0 || e.media >= spec.media.length)) out.push(`events: media ${e.media} no existe`);
    if (e.comm_seq !== undefined && (e.comm_seq < 1 || e.comm_seq > src.comms)) out.push(`events: comm_seq ${e.comm_seq} no existe`);
    if (e.mission && !spec.mission) out.push("events: evento de misión sin misión");
    if (e.at_s > spec.started_min_ago * 60) out.push(`events: "${e.title}" en el futuro`);
  }
  if (spec.mission && spec.mission.started_at_s < spec.mission.created_at_s) out.push("mission: despega antes de crearse");
  return out;
}

export function validateScenario(script: ScenarioScript): string[] {
  const out: string[] = [];
  const steps = script.steps;
  if (steps.length < 8 || steps.length > 12) out.push(`guion: ${steps.length} pasos (se esperan ~9-10)`);
  const texts = new Set<string>();
  const titles = new Set<string>();
  let mediaCount = 0;
  let missions = 0;
  const frames = new Map<string, number>();
  steps.forEach((s, i) => {
    const w = `paso ${i}`;
    if (!s.label.trim()) out.push(`${w}: sin label`);
    if (s.wait_s < 3 || s.wait_s > 8) out.push(`${w}: wait_s ${s.wait_s} fuera de 3–8`);
    for (const c of s.comms ?? []) {
      if (texts.has(c.text)) out.push(`${w}: texto de radio repetido`);
      texts.add(c.text);
      if (/\b\d-\d{1,2}\b|clave\s+\d/i.test(c.text)) out.push(`${w}: posible clave numérica inventada`);
    }
    for (const e of s.events ?? []) {
      if (titles.has(e.title)) out.push(`${w}: título de evento repetido`);
      titles.add(e.title);
    }
    if (s.media) {
      mediaCount++;
      if (s.media.source !== "demo") out.push(`${w}: media debe ser source "demo"`);
      frames.set(`M${mediaCount}`, s.media.frames.length);
      out.push(...mediaProblems(`${w} M${mediaCount}`, s.media));
    }
    if (s.mission) missions++;
    if (s.drone_media) {
      if (missions === 0) out.push(`${w}: lote de dron antes de desplegar el dron`);
      mediaCount++;
      if (s.drone_media.source !== "drone") out.push(`${w}: drone_media debe ser source "drone"`);
      frames.set(`M${mediaCount}`, s.drone_media.frames.length);
      out.push(...mediaProblems(`${w} M${mediaCount}`, s.drone_media));
    }
  });
  if (missions !== 1) out.push(`guion: debe desplegar exactamente un dron (hay ${missions})`);
  return out;
}
