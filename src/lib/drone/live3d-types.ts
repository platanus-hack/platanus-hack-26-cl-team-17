/**
 * Tipos de la reconstrucción 3D en vivo (servicio vigia-live3d, gpu/splat/LIVE3D.md).
 * Sin dependencias de servidor: lo usan la API y el puesto de mando.
 */

/** Estado de la sesión de reconstrucción (sesión = id de la misión del dron). */
export interface Live3DStatus {
  session: string;
  /** "fake" = motor simulado (sin GPU): la interfaz lo rotula como «Simulado». */
  engine: string;
  /** Modelo cargado. */
  ready: boolean;
  /** lost = la última ventana no encajó en el mapa. */
  state: "waiting" | "running" | "lost";
  /** Aviso en español para mostrar tal cual. */
  message: string | null;
  /** Sube con cada cambio. */
  version: number;
  /** Trozos de puntos disponibles (0..chunks-1). */
  chunks: number;
  points: number;
  keyframes: number;
  frames_received: number;
  pending: number;
  /** Lo que tardó la última ventana (ms). */
  last_chunk_ms: number | null;
  /** ms epoch del último trozo; null si todavía no hay. */
  updated_at: number | null;
  /** Matriz 4x4 por filas: mundo → vista (Y arriba, centrada, ~1 unidad de escena). */
  display: number[];
  /** c2w 3x4 por filas de cada cuadro clave (OpenCV: x derecha, y abajo, z adelante), en orden. */
  cameras: number[][];
  /** Gaussian splatting en vivo; null si el servicio no lo trae. */
  splat: Live3DSplatInfo | null;
}

/** Estado del Gaussian splatting en vivo (solo entrena mientras alguien pide /splat). */
export interface Live3DSplatInfo {
  /** "gsplat" (GPU) o "fake" (simulado: gaussianas sin entrenar); null = desactivado en el servicio. */
  engine: string | null;
  /** Entrenando ahora (alguien pidió los splats hace poco). */
  active: boolean;
  /** Versión de la última instantánea (0 = todavía ninguna). */
  version: number;
  /** Gaussianas de la última instantánea. */
  gaussians: number;
  /** Gaussianas en entrenamiento. */
  training: number;
  steps: number;
  views: number;
  psnr: number | null;
  /** ms epoch de la última instantánea. */
  updated_at: number | null;
  /** Aviso en español si el entrenamiento falló. */
  error: string | null;
}

/** GET /api/drone/[missionId]/live/scene3d */
export interface Live3DSceneResponse {
  /** false = sin servicio configurado: la interfaz no muestra nada. */
  enabled: boolean;
  /** null = la sesión todavía no existe (no ha llegado video) o el servicio no respondió. */
  status: Live3DStatus | null;
}

/** Ids de sesión que acepta el servicio. */
export const LIVE3D_SESSION_RE = /^[A-Za-z0-9_-]{1,64}$/;

export const IDENTITY_4X4: readonly number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

const num = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const count = (v: unknown): number => Math.max(0, Math.floor(num(v)));
const finiteList = (v: unknown, len: number): number[] | null =>
  Array.isArray(v) && v.length === len && v.every((x) => typeof x === "number" && Number.isFinite(x)) ? (v as number[]) : null;

/** Valida el JSON de /status sin confiar en él. null si no es un estado reconocible. */
export function parseLive3dStatus(raw: unknown): Live3DStatus | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.session !== "string") return null;
  const state = r.state === "running" || r.state === "lost" ? r.state : "waiting";
  const cameras = Array.isArray(r.cameras)
    ? r.cameras.map((c) => finiteList(c, 12)).filter((c): c is number[] => c !== null)
    : [];
  return {
    session: r.session,
    engine: typeof r.engine === "string" ? r.engine : "desconocido",
    ready: r.ready === true,
    state,
    message: typeof r.message === "string" && r.message.trim() ? r.message : null,
    version: num(r.version),
    chunks: Math.max(0, Math.floor(num(r.chunks))),
    points: Math.max(0, Math.floor(num(r.points))),
    keyframes: Math.max(0, Math.floor(num(r.keyframes))),
    frames_received: Math.max(0, Math.floor(num(r.frames_received))),
    pending: Math.max(0, Math.floor(num(r.pending))),
    last_chunk_ms: typeof r.last_chunk_ms === "number" && Number.isFinite(r.last_chunk_ms) ? r.last_chunk_ms : null,
    updated_at: typeof r.updated_at === "number" && Number.isFinite(r.updated_at) && r.updated_at > 0 ? r.updated_at : null,
    display: finiteList(r.display, 16) ?? [...IDENTITY_4X4],
    cameras,
    splat: parseSplatInfo(r.splat),
  };
}

function parseSplatInfo(raw: unknown): Live3DSplatInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  return {
    engine: typeof r.engine === "string" ? r.engine : null,
    active: r.active === true,
    version: count(r.version),
    gaussians: count(r.gaussians),
    training: count(r.training),
    steps: count(r.steps),
    views: count(r.views),
    psnr: typeof r.psnr === "number" && Number.isFinite(r.psnr) ? r.psnr : null,
    updated_at: typeof r.updated_at === "number" && Number.isFinite(r.updated_at) && r.updated_at > 0 ? r.updated_at : null,
    error: typeof r.error === "string" && r.error.trim() ? r.error : null,
  };
}
