/**
 * Vigía, el agente del puesto de mando: tipos de su memoria y de lo que muestra.
 * Puro (sin imports de servidor): lo usan el agente, las rutas y la interfaz.
 */
import type { Confidence } from "@/lib/domain";
import type { VigiaPriority } from "./rules";

export type { VigiaPriority } from "./rules";

/** Qué tipo de mensaje le da Vigía al OBAC. */
export type VigiaKind =
  | "presentacion"
  | "alerta"
  | "resumen"
  | "respuesta"
  | "pendiente"
  | "contradiccion"
  | "pedido_video"
  | "propuesta";

/** Un mensaje de Vigía (tarjeta en la mesa de mando y, si speak, su línea de radio por Zello). */
export interface VigiaUtterance {
  id: string;
  /** Secuencial por emergencia (la salida del puente pide ?after=<seq>). */
  seq: number;
  incident_id: string;
  at: string;
  /** Texto para la mesa de mando (puede ser detallado), ya pasado por las reglas duras. */
  text: string;
  /**
   * Lo que se dice por radio: una frase corta y precisa. null = solo pantalla. Ausente en
   * mensajes guardados antes de que existiera: ahí la radio decía `text`.
   */
  radio?: string | null;
  priority: VigiaPriority;
  kind: VigiaKind;
  /** true → `radio` va por voz (Zello). false → solo pantalla (sin línea de radio, límite de 20 s, silencio o propuesta). */
  speak: boolean;
  /** Etiquetas de la evidencia: "M3", "C12", "D1"… */
  evidence: string[];
  confidence: Confidence | null;
  /** "claude" = lo escribió el agente; "plantilla" = respaldo sin LLM. */
  engine: "claude" | "plantilla";
  /** Reglas duras que se aplicaron (para "por qué dijo esto"). */
  rules: string[];
  /** Solo en propuestas: el mensaje con claves para que el OBAC lo retransmita. */
  claves: string | null;
  /** Pregunta del OBAC a la que responde, si es una respuesta. */
  reply_to: string | null;
}

/** Una acción de Vigía en el mundo ("Lo que estoy haciendo"). */
export interface VigiaAction {
  id: string;
  at: string;
  kind: "pedido_video" | "bitacora" | "pendiente" | "escucha" | "propuesta" | "parte" | "silencio";
  text: string;
}

/** Entrada de la bitácora de Vigía: hora, qué, por qué y con qué evidencia. */
export interface VigiaLogEntry {
  id: string;
  at: string;
  what: string;
  why: string;
  evidence: string[];
}

/** Algo pedido por radio (o por el OBAC) que nadie ha confirmado. */
export interface VigiaPending {
  id: string;
  at: string;
  text: string;
  /** Quién lo pidió ("B-3"). */
  who: string;
  /** Clave o recurso ("2-2"), si se reconoce. */
  clave: string | null;
  /** Evidencia de origen ("C12"). */
  source: string;
  status: "abierto" | "resuelto";
  resolved_at: string | null;
  resolved_by: string | null;
  /** Última vez que Vigía lo recordó. */
  reminded_at: string | null;
}

/** Pedido de video a quienes están grabando cerca (página /reportar). */
export interface VigiaVideoRequest {
  id: string;
  at: string;
  /** Zona pedida, legible: "el lado C", "la parte trasera". */
  zone: string;
  /** Texto que ve el público (termina en "Sin acercarse."). */
  text: string;
  expires_at: string;
  /** Cuántas páginas de grabación lo recibieron (aprox.). */
  delivered: number;
}

/** Pregunta o respuesta del OBAC a Vigía. */
export interface VigiaQuestion {
  id: string;
  at: string;
  text: string;
  from: "mesa" | "zello";
  /** seq de la comunicación de origen (Zello). */
  comm_seq: number | null;
  /** Tarjeta de Vigía a la que responde el OBAC, si respondió desde una tarjeta. */
  reply_to: string | null;
  answered: boolean;
}

/** Cobertura de los videos por lado de la estructura principal. */
export interface VigiaSideCoverage {
  /** "A" (frente), "B", "C" (atrás), "D"; o "norte"/"sur"… si no se conoce la fachada. */
  side: string;
  /** Etiquetas de los medios que lo cubren. */
  media: string[];
}

export interface VigiaStatus {
  /** Una línea: "Escuchando 3 radios · mirando 5 videos · sin ver el lado C". */
  line: string;
  radios: number;
  videos: number;
  drones: number;
  /** Lados sin ningún video. */
  blind: string[];
  coverage: VigiaSideCoverage[];
  /** Vigía está pensando (turno en curso). */
  thinking: boolean;
}

/** Parte final exportable para Viper. */
export interface VigiaParte {
  at: string;
  text: string;
  fields: Record<string, string>;
}

/** Hasta dónde ya miró Vigía cada fuente. */
export interface VigiaCursors {
  comm_seq: number;
  /** Medios ya vistos por id → status visto ("analyzed", "failed"…). */
  media: Record<string, string>;
  situation_at: string | null;
  /** Hallazgos del informe ya vistos (título normalizado) y último estado de personas atrapadas. */
  seen_insights: string[];
  trapped_status: string | null;
  /** Contradicciones del informe ya avisadas. */
  seen_contradictions: string[];
  /** Última detección en vivo vista, por misión. */
  live_seq: Record<string, number>;
  /** Etiquetas críticas que YOLO ya vio en vivo y Vigía ya consideró, por misión. */
  live_alerted: Record<string, string[]>;
  /** Últimas observaciones del observador en vivo ya vistas, por misión (hora de la observación). */
  live_insights: Record<string, string>;
  last_clock_at: string | null;
  last_turn_at: string | null;
}

export interface VigiaState {
  incident_id: string;
  /** Aumenta con cada cambio (sondeo barato de la mesa de mando). */
  rev: number;
  created_at: string;
  updated_at: string;
  seq: number;
  utterances: VigiaUtterance[];
  actions: VigiaAction[];
  log: VigiaLogEntry[];
  pending: VigiaPending[];
  video_requests: VigiaVideoRequest[];
  questions: VigiaQuestion[];
  silenced: boolean;
  last_spoken_at: string | null;
  introduced: boolean;
  cursors: VigiaCursors;
  status: VigiaStatus;
  parte: VigiaParte | null;
  last_error: string | null;
  /** La mesa pidió "Vigía sin IA": plantillas, y la fusión y la radio por reglas, hasta que lo apague. */
  ai_off: boolean;
}

/** Lo que recibe la mesa de mando (GET /api/incidents/[id]/vigia). */
export interface VigiaView {
  unchanged?: false;
  rev: number;
  engine: "claude" | "plantilla";
  silenced: boolean;
  status: VigiaStatus;
  /** Más recientes primero. */
  utterances: VigiaUtterance[];
  actions: VigiaAction[];
  pending: VigiaPending[];
  video_requests: VigiaVideoRequest[];
  log: VigiaLogEntry[];
  parte: VigiaParte | null;
  /** "Vigía sin IA" activado desde la mesa. */
  ai_off: boolean;
  /** Por qué falló la última vuelta con Claude (null si la última salió bien). */
  last_error: string | null;
  server_time: string;
}

export interface VigiaUnchanged {
  unchanged: true;
  rev: number;
  server_time: string;
}

/** Salida para el puente Zello (GET /api/incidents/[id]/vigia/salida?after=<seq>). */
/** Lo que se dice (o se diría) por radio de un mensaje. */
export function radioText(u: Pick<VigiaUtterance, "text" | "radio">): string {
  return u.radio ?? u.text;
}

export interface VigiaSalida {
  items: VigiaUtterance[];
  last_seq: number;
}

/** Pedido de video para la página pública de grabación. */
export interface PublicVideoRequest {
  id: string;
  text: string;
  zone: string;
  at: string;
  expires_at: string;
}

export const MAX_UTTERANCES = 200;
export const MAX_ACTIONS = 60;
export const MAX_LOG = 400;
export const MAX_QUESTIONS = 60;

export function emptyVigiaState(incidentId: string, now: string): VigiaState {
  return {
    incident_id: incidentId,
    rev: 0,
    created_at: now,
    updated_at: now,
    seq: 0,
    utterances: [],
    actions: [],
    log: [],
    pending: [],
    video_requests: [],
    questions: [],
    silenced: false,
    last_spoken_at: null,
    introduced: false,
    cursors: {
      comm_seq: 0,
      media: {},
      situation_at: null,
      seen_insights: [],
      trapped_status: null,
      seen_contradictions: [],
      live_seq: {},
      live_alerted: {},
      live_insights: {},
      last_clock_at: null,
      last_turn_at: null,
    },
    status: { line: "Vigía, en el puesto de mando", radios: 0, videos: 0, drones: 0, blind: [], coverage: [], thinking: false },
    parte: null,
    last_error: null,
    ai_off: false,
  };
}
