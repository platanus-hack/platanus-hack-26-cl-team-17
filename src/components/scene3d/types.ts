/**
 * Contrato del visor de reconstrucción espacial. Lo consume /mando/[id] y /en-ruta/[id].
 *
 * Mapeo de coordenadas (escena ENU en metros → three.js, Y arriba):
 *   three.x =  scene.x (Este)      three.y = scene.z (altura)      three.z = -scene.y (Norte hacia -Z)
 * Rumbos: 0 = Norte, sentido horario.
 */
import type { DroneMission, Incident, SceneModel } from "@/lib/domain";
import type { MediaView } from "@/lib/contract";

export type SceneEntityKind =
  | "structure"
  | "fire"
  | "smoke"
  | "person"
  | "vehicle"
  | "hazard"
  | "access"
  | "road"
  | "camera"
  | "drone";

export interface SceneSelection {
  kind: SceneEntityKind;
  /** id de la entidad en SceneModel; para cámaras el media_ref ("M2"); para dron el id de misión. */
  id: string;
}

export interface Scene3DProps {
  scene: SceneModel | null;
  incident: Pick<Incident, "id" | "lat" | "lng" | "type" | "title">;
  /** Para dibujar cámaras/frustums con miniatura y abrir el medio al hacer clic. */
  media: MediaView[];
  /** Traza y posición actual de los drones (lat/lng → local con toLocal). */
  missions: DroneMission[];
  updatedAt: string | null;
  /** true mientras el pipeline está recalculando la escena. */
  updating?: boolean;
  selection?: SceneSelection | null;
  onSelect?: (sel: SceneSelection | null) => void;
  /** Abrir un medio (y opcionalmente un fotograma) desde una cámara o una evidencia. */
  onOpenMedia?: (mediaLabel: string, frame?: number) => void;
  /** Versión reducida sin panel de capas ni inspector (para la tablet en ruta). */
  compact?: boolean;
  className?: string;
}
