/** Contrato de la línea de tiempo del incidente. */
import type { TimelineEvent } from "@/lib/domain";
import type { MediaView } from "@/lib/contract";

export interface TimelinePanelProps {
  /** Más recientes primero. */
  events: TimelineEvent[];
  media: MediaView[];
  onOpenMedia?: (mediaId: string) => void;
  onOpenComm?: (commId: string) => void;
  onOpenMission?: (missionId: string) => void;
  className?: string;
}
