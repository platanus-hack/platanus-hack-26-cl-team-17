"use client";
/**
 * Casas del mapa de la ficha como maqueta 3D (three.js dentro del mapa, capa personalizada):
 * muros por piso con cornisa entre pisos, ventanas, puerta en la fachada principal (lado A)
 * y techo a dos aguas cuando la IA lo vio así (plano con parapeto si no se sabe, como en el
 * esquema). El piso con fuego va con los muros entibiados y las ventanas encendidas; la casa
 * afectada en blanco cálido con techo pizarra y las vecinas en gris apagado, para que la
 * afectada se lea primero.
 *
 * La geometría se arma en metros (x Este, y Norte, z arriba) alrededor del origen del
 * incidente; la matriz del mapa la lleva a pantalla, igual en MapLibre 6 y en Mapbox v3.
 * Este módulo se carga aparte (import dinámico) para no sumar three.js a la carga inicial.
 */
import * as THREE from "three";
import type { CustomLayerInterface, Map as MlMap } from "maplibre-gl";
import { footprintAxes, localToWorld } from "@/components/scene3d/geometry";
import type { HouseSpec } from "../house";
import type { LngLat } from "../model";

export const HOUSES_LAYER_ID = "f-houses-3d";

/* ───────────────────────────── Colores ───────────────────────────── */

const AFFECTED = {
  wall: "#FBF5EC",
  band: "#E6DCCD",
  roof: "#646B75",
  flatRoof: "#8B9097",
  window: "#33414F",
  door: "#5B4A3D",
  edge: 0.32,
};
const EXPOSURE = {
  wall: "#E3DFD8",
  band: "#D2CCC2",
  roof: "#A7A39C",
  flatRoof: "#B9B4AC",
  window: "#8F979F",
  door: "#9E968C",
  edge: 0.16,
};
const FIRE_WALL = "#F8C29C";
const FIRE_WINDOW = "#FF9A2E";
const EDGE = "#151A21";
/** Opacidad de las hileras de tejas. */
const TILE_EDGE = 0.12;

/* ───────────────────────────── Geometría ───────────────────────────── */

type V3 = [number, number, number];

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Triángulos de un color, con normales planas; luego un solo BufferGeometry por color. */
class Bucket {
  pos: number[] = [];
  nor: number[] = [];
  /** Agrega el triángulo con su cara hacia `n` (el giro de la planta puede reflejar los ejes). */
  tri(a: V3, b: V3, c: V3, n: V3) {
    if (dot(cross(sub(b, a), sub(c, a)), n) < 0) [b, c] = [c, b];
    this.pos.push(...a, ...b, ...c);
    for (let i = 0; i < 3; i++) this.nor.push(...n);
  }
  quad(a: V3, b: V3, c: V3, d: V3, n: V3) {
    this.tri(a, b, c, n);
    this.tri(a, c, d, n);
  }
}

/** Colores → triángulos (caras iluminadas), triángulos sin luz (ventanas encendidas) y aristas. */
interface Buckets {
  lit: Map<string, Bucket>;
  glow: Map<string, Bucket>;
  edges: Map<number, number[]>;
}

function bucket(map: Map<string, Bucket>, color: string): Bucket {
  let b = map.get(color);
  if (!b) map.set(color, (b = new Bucket()));
  return b;
}

/** Una casa en la escena local: ejes de la planta (u a la derecha mirando la fachada, v al frente, z arriba). */
function buildHouse(h: HouseSpec, out: Buckets) {
  const pal = h.affected ? AFFECTED : EXPOSURE;
  const { fp, floors, floorHeight: fh, roofHeight: rh } = h;
  const hw = fp.width / 2;
  const hd = fp.depth / 2;
  const H = floors * fh;
  const axes = footprintAxes(fp.rotationDeg);
  const P = (u: number, v: number, z: number): V3 => {
    const w = localToWorld(fp, u, v);
    return [w.x, w.y, z];
  };
  /** Dirección de la planta (du, dv) + dz, en la escena. */
  const D = (du: number, dv: number, dz: number): V3 =>
    norm([du * axes.right.x + dv * axes.front.x, du * axes.right.y + dv * axes.front.y, dz]);
  const lines: number[] = [];
  const line = (a: V3, b: V3) => lines.push(...a, ...b);
  const tiles: number[] = [];

  /** Caja con caras laterales y, si se pide, tapa. */
  const box = (b: Bucket, u0: number, u1: number, v0: number, v1: number, z0: number, z1: number, top = false) => {
    b.quad(P(u0, v1, z0), P(u1, v1, z0), P(u1, v1, z1), P(u0, v1, z1), D(0, 1, 0));
    b.quad(P(u1, v0, z0), P(u0, v0, z0), P(u0, v0, z1), P(u1, v0, z1), D(0, -1, 0));
    b.quad(P(u1, v1, z0), P(u1, v0, z0), P(u1, v0, z1), P(u1, v1, z1), D(1, 0, 0));
    b.quad(P(u0, v0, z0), P(u0, v1, z0), P(u0, v1, z1), P(u0, v0, z1), D(-1, 0, 0));
    if (top) b.quad(P(u0, v0, z1), P(u1, v0, z1), P(u1, v1, z1), P(u0, v1, z1), D(0, 0, 1));
  };

  const fireFloor = (f: number) => h.fireFloors.includes(f + 1);
  const topWall = fireFloor(floors - 1) ? FIRE_WALL : pal.wall;

  // Muros: un volumen por piso (el del foco, entibiado).
  for (let f = 0; f < floors; f++) {
    box(bucket(out.lit, fireFloor(f) ? FIRE_WALL : pal.wall), -hw, hw, -hd, hd, f * fh, (f + 1) * fh);
  }
  // Cornisa entre pisos: se cuentan los pisos de un vistazo.
  const bands = bucket(out.lit, pal.band);
  for (let f = 1; f < floors; f++) box(bands, -hw - 0.07, hw + 0.07, -hd - 0.07, hd + 0.07, f * fh - 0.11, f * fh + 0.11, true);

  // Ventanas en las cuatro fachadas; puerta al centro del primer piso de la fachada principal.
  const faces: { len: number; at: (s: number, z: number) => V3; n: V3 }[] = [
    { len: fp.width, at: (s, z) => P(s, hd + 0.04, z), n: D(0, 1, 0) },
    { len: fp.width, at: (s, z) => P(-s, -hd - 0.04, z), n: D(0, -1, 0) },
    { len: fp.depth, at: (s, z) => P(hw + 0.04, -s, z), n: D(1, 0, 0) },
    { len: fp.depth, at: (s, z) => P(-hw - 0.04, s, z), n: D(-1, 0, 0) },
  ];
  faces.forEach((face, fi) => {
    const n = Math.max(1, Math.floor((face.len - 0.8) / 2.7));
    const step = face.len / n;
    const ww = Math.min(1.25, step * 0.5);
    for (let f = 0; f < floors; f++) {
      const wh = Math.min(1.35, fh * 0.48);
      const z0 = f * fh + fh * 0.32;
      const lit = fireFloor(f);
      for (let i = 0; i < n; i++) {
        const c = -face.len / 2 + step * (i + 0.5);
        if (fi === 0 && f === 0 && i === Math.floor(n / 2)) {
          const dw = Math.min(1.05, step * 0.45);
          const dh = Math.min(2.15, fh * 0.8);
          bucket(out.lit, pal.door).quad(face.at(c - dw / 2, 0.02), face.at(c + dw / 2, 0.02), face.at(c + dw / 2, dh), face.at(c - dw / 2, dh), face.n);
          continue;
        }
        const b = lit ? bucket(out.glow, FIRE_WINDOW) : bucket(out.lit, pal.window);
        b.quad(face.at(c - ww / 2, z0), face.at(c + ww / 2, z0), face.at(c + ww / 2, z0 + wh), face.at(c - ww / 2, z0 + wh), face.n);
      }
    }
  });

  // Aristas verticales y borde superior de los muros.
  for (const [u, v] of [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]] as const) line(P(u, v, 0), P(u, v, H));

  if (h.roof === "gable" && rh > 0) {
    // Dos aguas con la cumbrera paralela a la fachada (eje u), alero de 35 cm.
    const o = 0.35;
    const eave = H - (o * rh) / hd;
    const roof = bucket(out.lit, pal.roof);
    const slope = rh / hd;
    roof.quad(P(-hw - o, hd + o, eave), P(hw + o, hd + o, eave), P(hw + o, 0, H + rh), P(-hw - o, 0, H + rh), D(0, slope, 1));
    roof.quad(P(hw + o, -hd - o, eave), P(-hw - o, -hd - o, eave), P(-hw - o, 0, H + rh), P(hw + o, 0, H + rh), D(0, -slope, 1));
    // Canto del alero (espesor del techo) adelante y atrás.
    const t = 0.16;
    roof.quad(P(-hw - o, hd + o, eave - t), P(hw + o, hd + o, eave - t), P(hw + o, hd + o, eave), P(-hw - o, hd + o, eave), D(0, 1, 0));
    roof.quad(P(hw + o, -hd - o, eave - t), P(-hw - o, -hd - o, eave - t), P(-hw - o, -hd - o, eave), P(hw + o, -hd - o, eave), D(0, -1, 0));
    // Hastiales: el triángulo de muro bajo el techo, a cada lado.
    const gable = bucket(out.lit, topWall);
    gable.tri(P(hw, hd, H), P(hw, -hd, H), P(hw, 0, H + rh), D(1, 0, 0));
    gable.tri(P(-hw, -hd, H), P(-hw, hd, H), P(-hw, 0, H + rh), D(-1, 0, 0));
    line(P(-hw - o, 0, H + rh), P(hw + o, 0, H + rh));
    // Hileras de tejas, tenues, paralelas a la cumbrera.
    const rows = Math.max(2, Math.round((hd + o) / 1.1));
    for (let i = 1; i < rows; i++) {
      const k = i / rows;
      const v = (hd + o) * (1 - k);
      const z = eave + (H + rh - eave) * k + 0.03;
      tiles.push(...P(-hw - o, v, z), ...P(hw + o, v, z), ...P(-hw - o, -v, z), ...P(hw + o, -v, z));
    }
    line(P(-hw - o, hd + o, eave), P(hw + o, hd + o, eave));
    line(P(-hw - o, -hd - o, eave), P(hw + o, -hd - o, eave));
    for (const s of [-1, 1]) {
      line(P(s * (hw + o), hd + o, eave), P(s * (hw + o), 0, H + rh));
      line(P(s * (hw + o), -hd - o, eave), P(s * (hw + o), 0, H + rh));
    }
  } else {
    // Techo plano con parapeto.
    const p = 0.22;
    const ph = 0.45;
    const rim = bucket(out.lit, pal.band);
    box(rim, -hw, hw, hd - p, hd, H, H + ph, true);
    box(rim, -hw, hw, -hd, -hd + p, H, H + ph, true);
    box(rim, hw - p, hw, -hd + p, hd - p, H, H + ph, true);
    box(rim, -hw, -hw + p, -hd + p, hd - p, H, H + ph, true);
    bucket(out.lit, pal.flatRoof).quad(P(-hw, -hd, H + 0.02), P(hw, -hd, H + 0.02), P(hw, hd, H + 0.02), P(-hw, hd, H + 0.02), D(0, 0, 1));
    for (const [u, v] of [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]] as const) line(P(u, v, H), P(u, v, H + ph));
    const ring = [P(-hw, -hd, H + ph), P(hw, -hd, H + ph), P(hw, hd, H + ph), P(-hw, hd, H + ph)];
    ring.forEach((a, i) => line(a, ring[(i + 1) % 4]));
  }
  const ring = [P(-hw, -hd, H), P(hw, -hd, H), P(hw, hd, H), P(-hw, hd, H)];
  ring.forEach((a, i) => line(a, ring[(i + 1) % 4]));

  const add = (opacity: number, pts: number[]) => {
    if (!pts.length) return;
    const e = out.edges.get(opacity) ?? [];
    e.push(...pts);
    out.edges.set(opacity, e);
  };
  add(pal.edge, lines);
  add(TILE_EDGE, tiles);
}

/* ───────────────────────────── Capa del mapa ───────────────────────────── */

/** Coordenada Web Mercator (0..1) y metros → unidades Mercator, como MercatorCoordinate de MapLibre y Mapbox. */
function mercator([lng, lat]: LngLat) {
  const x = (180 + lng) / 360;
  const y = (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360;
  const s = 1 / (2 * Math.PI * 6371008.8) / Math.cos((lat * Math.PI) / 180);
  return { x, y, s };
}

function houseKey(center: LngLat, houses: readonly HouseSpec[]): string {
  return JSON.stringify([center, houses]);
}

export interface HouseLayer {
  /** Vuelve a armar las casas si cambiaron. */
  update: (center: LngLat, houses: readonly HouseSpec[]) => void;
  remove: () => void;
}

/**
 * Agrega la capa de casas 3D al mapa. Si el equipo no puede (sin WebGL 2, error de three.js),
 * llama a `onFail` y el mapa vuelve a las casas en prismas.
 */
export function addHouseLayer(map: MlMap, center: LngLat, houses: readonly HouseSpec[], onFail: (err: unknown) => void): HouseLayer | null {
  const gl = map.getCanvas().getContext("webgl2");
  if (!gl) {
    onFail(new Error("sin WebGL 2"));
    return null;
  }
  let renderer: THREE.WebGLRenderer;
  try {
    // Comparte el contexto del mapa (el suavizado de bordes lo define el mapa al crearse).
    renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl });
  } catch (err) {
    onFail(err);
    return null;
  }
  renderer.autoClear = false;

  const scene = new THREE.Scene();
  const camera = new THREE.Camera();
  // Luz de tarde desde el suroeste (frente y techo delantero claros, el costado oriente en sombra) y un relleno suave.
  scene.add(new THREE.AmbientLight(0xffffff, 1.75));
  const sun = new THREE.DirectionalLight(0xffffff, 1.9);
  sun.position.set(-0.55, -0.8, 1.15);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xffffff, 0.45);
  fill.position.set(0.7, 0.5, 0.6);
  scene.add(fill);
  const group = new THREE.Group();
  scene.add(group);

  let local = new THREE.Matrix4();
  let key = "";
  let broken = false;

  const clear = () => {
    for (const obj of [...group.children]) {
      group.remove(obj);
      const m = obj as THREE.Mesh | THREE.LineSegments;
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
  };

  const build = (c: LngLat, list: readonly HouseSpec[]) => {
    clear();
    const m = mercator(c);
    local = new THREE.Matrix4().makeTranslation(m.x, m.y, 0).scale(new THREE.Vector3(m.s, -m.s, m.s));
    const out: Buckets = { lit: new Map(), glow: new Map(), edges: new Map() };
    for (const h of list) buildHouse(h, out);
    const geometry = (b: Bucket) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(b.pos, 3));
      g.setAttribute("normal", new THREE.Float32BufferAttribute(b.nor, 3));
      return g;
    };
    // Las caras van un poco "atrás" en profundidad para que las aristas se dibujen limpias encima.
    const offset = { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 };
    for (const [color, b] of out.lit) {
      // Por ambas caras: la parte de abajo de los aleros también se ve.
      const mesh = new THREE.Mesh(geometry(b), new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide, ...offset }));
      mesh.frustumCulled = false;
      group.add(mesh);
    }
    for (const [color, b] of out.glow) {
      const mesh = new THREE.Mesh(geometry(b), new THREE.MeshBasicMaterial({ color, ...offset }));
      mesh.frustumCulled = false;
      group.add(mesh);
    }
    for (const [opacity, pts] of out.edges) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
      const lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: EDGE, transparent: true, opacity }));
      lines.frustumCulled = false;
      group.add(lines);
    }
  };

  const fail = (err: unknown) => {
    if (broken) return;
    broken = true;
    try {
      if (map.getLayer(HOUSES_LAYER_ID)) map.removeLayer(HOUSES_LAYER_ID);
    } catch {
      /* el mapa ya no existe */
    }
    onFail(err);
  };

  const layer: CustomLayerInterface = {
    id: HOUSES_LAYER_ID,
    type: "custom",
    renderingMode: "3d",
    render(glCtx, args) {
      if (broken || !group.children.length) return;
      try {
        // MapLibre 6 pasa un objeto con la matriz Mercator → pantalla; Mapbox v3, la matriz directa.
        const a = args as unknown;
        const main = (Array.isArray(a) || ArrayBuffer.isView(a) ? a : args.defaultProjectionData.mainMatrix) as ArrayLike<number>;
        camera.projectionMatrix.fromArray(Array.from(main)).multiply(local);
        camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
        renderer.resetState();
        renderer.setViewport(0, 0, glCtx.drawingBufferWidth, glCtx.drawingBufferHeight);
        renderer.render(scene, camera);
      } catch (err) {
        console.warn("[ficha] casas 3D:", err);
        fail(err);
      }
    },
  };

  try {
    key = houseKey(center, houses);
    build(center, houses);
    map.addLayer(layer);
  } catch (err) {
    fail(err);
    return null;
  }

  return {
    update(c, list) {
      if (broken) return;
      const k = houseKey(c, list);
      if (k === key) return;
      key = k;
      try {
        build(c, list);
        map.triggerRepaint();
      } catch (err) {
        fail(err);
      }
    },
    remove() {
      broken = true;
      try {
        if (map.getLayer(HOUSES_LAYER_ID)) map.removeLayer(HOUSES_LAYER_ID);
      } catch {
        /* el mapa ya no existe */
      }
      clear();
    },
  };
}
