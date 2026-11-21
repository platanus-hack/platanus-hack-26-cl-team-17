/**
 * Tipos internos de los datos de demostración.
 *
 * Una vitrina (`ShowcaseSpec`) describe un incidente ficticio completo con
 * tiempos RELATIVOS a su inicio; `seed.ts` lo convierte en llamadas al Store.
 * Las coordenadas de cámaras y posiciones se dan en metros locales (ENU,
 * x = Este, y = Norte) respecto de la ubicación del incidente, igual que la escena.
 */
import type {
  CommsAnalysis,
  IncidentStatus,
  IncidentType,
  MediaAnalysis,
  MediaKind,
  MissionPattern,
  SceneModel,
  SituationReport,
  SmokeColor,
  SmokeVolume,
  TimelineKind,
  TimelineSeverity,
  VehicleKind,
  VehicleState,
} from "@/lib/domain";
import type { FileStorage, Store } from "@/lib/store/types";

/* ───────────── Dependencias inyectables (pruebas sin Next ni pipeline) ───────────── */

export interface DemoPipeline {
  processMedia(mediaId: string, opts?: { force?: boolean }): Promise<void>;
  requestFusion(incidentId: string, opts?: { force?: boolean }): Promise<void>;
  requestCommsAnalysis(incidentId: string): Promise<void>;
}

export interface DemoDeps {
  store: Store;
  files: FileStorage;
  pipeline: DemoPipeline;
  /** Reloj en milisegundos (inyectable para pruebas deterministas). */
  now: () => number;
  /** Agenda trabajo para después de responder (en las rutas: `after()` de Next). */
  defer: (task: () => Promise<void>) => void;
  /** Ancla la escena sembrada al mapa real (OSM); debe resolver siempre. Sin inyectar, no se ancla. */
  anchorScene?: (scene: SceneModel, incident: { lat: number; lng: number; type: IncidentType }) => Promise<SceneModel>;
}

/* ───────────── Pósters (bocetos SVG rotulados como demostración) ───────────── */

export type PosterView = "front" | "side" | "rear" | "corner" | "aerial";
export type PosterPosition = "left" | "center" | "right";
export type PosterIntensity = "none" | "light" | "moderate" | "heavy";

export interface PosterVehicle {
  kind: VehicleKind;
  state: VehicleState;
  /** Posición horizontal en el cuadro (0 = borde izquierdo, 1 = derecho). */
  x: number;
  burning?: boolean;
  /** Etiqueta corta junto al vehículo, p. ej. "V2 · volcado". */
  tag?: string;
}

export interface PosterSpec {
  /** Qué tipo de escena se dibuja. */
  scene: "structure" | "collision";
  view: PosterView;
  /** Rótulo superior, p. ej. "M1 · Vecino · vereda de enfrente". */
  caption: string;
  /** Hora local que se imprime en el cuadro, "HH:MM:SS". */
  clock: string;
  /** Estructura (scene = "structure"). */
  floors?: number;
  /** "house" = vivienda con techo a dos aguas; "apartment" = bloque de techo plano. */
  building?: "house" | "apartment";
  fire?: { floor: number; position: PosterPosition; intensity: PosterIntensity };
  smoke?: { color: SmokeColor; volume: SmokeVolume; position: PosterPosition };
  /** Persona visible en ventana o balcón. */
  person?: { floor: number; position: PosterPosition; balcony?: boolean };
  /** Edificaciones vecinas visibles a los lados. */
  exposures?: { left?: boolean; right?: boolean };
  /** Vehículos (colisiones, o carros bomba en la llegada). */
  vehicles?: PosterVehicle[];
  /** Elementos de contexto dibujados como pictogramas sobrios. */
  extras?: (
    | "gas_cylinders"
    | "power_lines"
    | "hydrant"
    | "fuel_spill"
    | "fire_engine"
    | "traffic_queue"
    | "crowd"
    | "roof_damage"
  )[];
  /** Nombre de calle rotulado en el cuadro (texto visible). */
  street?: string;
  /** Semilla para pequeñas variaciones deterministas entre fotogramas del mismo medio. */
  variant: number;
}

/* ───────────── Vitrinas ───────────── */

export interface DemoFrameSpec {
  /** Segundo del video del que "se extrajo" el fotograma. */
  t_s: number;
  poster: PosterSpec;
}

export interface DemoMediaSpec {
  /** "demo" para medios de vecinos ficticios; "drone" para lotes del dron (siempre ligados a la misión de la vitrina). */
  source: "demo" | "drone";
  kind: MediaKind;
  /** Posición de la cámara en metros locales respecto del incidente. */
  camera: { x: number; y: number };
  accuracy_m: number | null;
  heading_deg: number | null;
  duration_s: number | null;
  /** Segundos desde el inicio del incidente en que se grabó. */
  captured_at_s: number;
  /** Segundos desde el inicio en que llegó (evento media_received). */
  received_at_s: number;
  /** Segundos desde el inicio en que quedó analizado (evento media_analyzed). */
  analyzed_at_s: number;
  reporter_note: string;
  /** 2 a 4 fotogramas; `frames[i]` es el índice i que cita la IA. */
  frames: DemoFrameSpec[];
  /** Análisis hecho a mano; sus `frame_refs`/`key_frames` deben existir en `frames`. */
  analysis: MediaAnalysis;
  /** Solo lotes de dron: altura de vuelo de los cuadros. */
  drone_alt_m?: number;
}

export interface DemoCommSpec {
  /** Segundos desde el inicio. Las entradas van en orden: su posición define C1, C2… */
  at_s: number;
  channel: string;
  speaker: string;
  text: string;
}

export interface DemoEventSpec {
  at_s: number;
  kind: TimelineKind;
  severity: TimelineSeverity;
  title: string;
  detail: string;
  /** Índice (0-based) en `media` → media_id; etiqueta resultante M<i+1>. */
  media?: number;
  /** Número seq de comunicaciones (1-based) → comm_id. */
  comm_seq?: number;
  /** true → mission_id de la misión de la vitrina. */
  mission?: boolean;
}

export interface DemoMissionSpec {
  pattern: MissionPattern;
  radius_m: number;
  altitude_m: number;
  speed_ms: number;
  /** Despegue en metros locales (p. ej. { x: 0, y: -300 }). */
  home: { x: number; y: number };
  /** Segundos desde el inicio en que se desplegó y en que despegó. */
  created_at_s: number;
  started_at_s: number;
  /** Batería al despegar; la simulación la descuenta hasta el momento de sembrar (sigue en órbita). */
  battery_start_pct: number;
}

export interface ShowcaseSpec {
  /** Título único; `seedDemo` lo usa para no duplicar. */
  title: string;
  type: IncidentType;
  address: string;
  lat: number;
  lng: number;
  description: string;
  status: IncidentStatus;
  /** Minutos transcurridos desde el inicio al momento de sembrar. */
  started_min_ago: number;
  media: DemoMediaSpec[];
  comms: DemoCommSpec[];
  comms_analysis: CommsAnalysis;
  situation: SituationReport;
  scene: SceneModel;
  mission: DemoMissionSpec | null;
  /** Línea de tiempo adicional (alertas, informe/escena actualizados, comunicaciones relevantes).
   *  `seed.ts` agrega por su cuenta: incident_created, comms (uno por entrada de radio),
   *  media_received/analyzed y drone. Un evento "comms" con comm_seq reemplaza el título del automático. */
  events: DemoEventSpec[];
}

/* ───────────── Simulacro en vivo ───────────── */

/** Medio del simulacro: los instantes se miden respecto del momento en que corre el paso. */
export type ScenarioMediaSpec = Omit<
  DemoMediaSpec,
  "captured_at_s" | "received_at_s" | "analyzed_at_s"
> & {
  /** Segundos antes de ejecutar el paso en que se grabó. */
  captured_ago_s: number;
};

export interface ScenarioCommSpec {
  channel: string;
  speaker: string;
  /** Texto único dentro del guion: sirve de llave para no duplicar al reintentar un paso. */
  text: string;
}

export interface ScenarioEventSpec {
  kind: TimelineKind;
  severity: TimelineSeverity;
  /** Título único dentro del guion (llave de idempotencia). */
  title: string;
  detail: string;
}

export interface ScenarioStepSpec {
  /** Qué ocurre, en español, para el chip del simulacro: "Llega video de vecino". */
  label: string;
  /** Espera antes del paso siguiente (3–8 s). */
  wait_s: number;
  comms?: ScenarioCommSpec[];
  /** Medio de vecino (source "demo"); el análisis va precargado y luego corre processMedia. */
  media?: ScenarioMediaSpec;
  /** Despliega el dron simulado (máx. una misión por simulacro). */
  mission?: { pattern: MissionPattern; radius_m: number; altitude_m: number; speed_ms: number };
  /** Lote de cuadros del dron (source "drone") ligado a la misión del simulacro. */
  drone_media?: ScenarioMediaSpec;
  events?: ScenarioEventSpec[];
  /** Cambio de estado del incidente (p. ej. "controlled" al cierre). */
  status?: IncidentStatus;
}

export interface ScenarioScript {
  /** El paso 0 crea este incidente (origin "demo"). */
  incident: {
    type: IncidentType;
    title: string;
    address: string;
    lat: number;
    lng: number;
    description: string;
  };
  /** steps[0] corre junto con la creación del incidente. */
  steps: ScenarioStepSpec[];
}
