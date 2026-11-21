/** Contrato del panel de dron del puesto de mando. */
import type { DroneMission, Incident } from "@/lib/domain";
import type { MediaView, RuntimeMode } from "@/lib/contract";

export interface DronePanelProps {
  incident: Pick<Incident, "id" | "code" | "lat" | "lng" | "title" | "status">;
  missions: DroneMission[];
  /** Medios del incidente; el panel muestra los lotes source === "drone". */
  media: MediaView[];
  mode: RuntimeMode;
  /** Pide refrescar el snapshot tras desplegar/retornar. */
  onChanged: () => void;
  onOpenMedia?: (mediaLabel: string) => void;
  className?: string;
}
