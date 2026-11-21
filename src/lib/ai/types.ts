/**
 * Tipos compartidos de la capa de IA (solo servidor).
 *
 * Los motores (Claude y reglas) reciben exactamente estas entradas; el pipeline
 * las arma desde el store. `UserContent` es neutral respecto del SDK: client.ts
 * lo traduce a bloques de la API de Claude.
 */
import type {
  AnalysisEngine,
  CommEntry,
  CommsAnalysis,
  Incident,
  Media,
  MediaAnalysis,
  SceneModel,
  SituationReport,
} from "@/lib/domain";

/** Formatos de imagen que acepta la API de Claude (SVG no). */
export type ImageMediaType = "image/jpeg" | "image/png" | "image/webp" | "image/gif";

export const IMAGE_MEDIA_TYPES: readonly ImageMediaType[] = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
];

export function isImageMediaType(value: string): value is ImageMediaType {
  return (IMAGE_MEDIA_TYPES as readonly string[]).includes(value);
}

/** Un fotograma ya descargado, listo para enviarse a la IA. */
export interface FrameImage {
  /** Índice del fotograma dentro de su medio (el que cita la IA). */
  idx: number;
  /** Segundo del video del que se extrajo (0 para fotos). */
  t_s: number;
  media_type: ImageMediaType;
  /** Bytes de la imagen en base64 (sin prefijo data:). */
  base64: string;
}

/** Fotograma clave para la fusión: además indica de qué medio viene. */
export interface KeyFrameImage extends FrameImage {
  /** Etiqueta del medio, p. ej. "M2". */
  media_label: string;
  /** Por qué se eligió (caption de `key_frames` del análisis del medio). */
  caption: string;
}

export type UserContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; media_type: ImageMediaType; base64: string };

/** Contenido del mensaje de usuario, en orden. */
export type UserContent = UserContentBlock[];

/** Tareas de IA; sirven para registrar uso y para elegir prompt. */
export type AITask = "media" | "comms" | "situation" | "scene";

/** Datos del incidente que necesitan los motores. */
export type IncidentContext = Pick<
  Incident,
  "id" | "code" | "type" | "title" | "address" | "lat" | "lng" | "description" | "status" | "created_at"
>;

export interface MediaAnalysisInput {
  incident: IncidentContext;
  /** El medio a analizar (label, source, kind, nota del vecino, GPS, rumbo, duración…). */
  media: Media;
  /** Fotogramas en orden de idx, máx. LIMITS.MAX_FRAMES_PER_MEDIA. Puede venir vacío (solo nota). */
  frames: FrameImage[];
  /** Instante de referencia (ISO). Los motores no deben leer el reloj por su cuenta. */
  now: string;
}

export interface CommsAnalysisInput {
  incident: IncidentContext;
  /** Toda la bitácora del incidente, en orden de seq. */
  comms: CommEntry[];
  /** Análisis anterior, si existe (para continuidad). */
  previous: CommsAnalysis | null;
  now: string;
}

/** Medio con su análisis, tal como entra a la fusión. */
export interface FusionMedia {
  media: Media;
  /** Análisis del medio; null si aún no se analizó o falló. */
  analysis: MediaAnalysis | null;
  analysis_engine: AnalysisEngine | null;
}

export interface FusionInput {
  incident: IncidentContext;
  /** Todos los medios del incidente (ordenados por label), con o sin análisis. */
  media: FusionMedia[];
  comms: CommEntry[];
  commsAnalysis: CommsAnalysis | null;
  /** Hasta 6 fotogramas clave en total (nunca de medios demo ni SVG). */
  keyFrames: KeyFrameImage[];
  previousSituation: SituationReport | null;
  previousScene: SceneModel | null;
  now: string;
}

export interface Engine {
  readonly kind: AnalysisEngine;
  analyzeMedia(input: MediaAnalysisInput): Promise<MediaAnalysis>;
  analyzeComms(input: CommsAnalysisInput): Promise<CommsAnalysis>;
  fuseSituation(input: FusionInput): Promise<SituationReport>;
  fuseScene(input: FusionInput): Promise<SceneModel>;
}
