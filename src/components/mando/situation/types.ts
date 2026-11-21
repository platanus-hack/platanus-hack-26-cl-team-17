/** Contrato de los paneles de situación del puesto de mando (informe fusionado por la IA). */
import type { CommEntry, EvidenceRef, Incident } from "@/lib/domain";
import type { MediaView, RuntimeMode } from "@/lib/contract";

/** Franja crítica bajo la barra superior: estado de personas atrapadas, severidad, titular y estado del análisis. */
export interface CriticalStripProps {
  incident: Incident;
  mediaCount: number;
  /** Clic en la evidencia que respalda el estado de atrapados. */
  onEvidence?: (ref: EvidenceRef) => void;
  /** Modo de la instancia: ajusta el texto del aviso de simulación (opcional). */
  mode?: RuntimeMode | null;
  className?: string;
}

/** Columna de situación: hallazgos, peligros, acceso, acciones sugeridas, contradicciones, incógnitas y briefing. */
export interface SituationPanelProps {
  incident: Incident;
  media: MediaView[];
  comms: CommEntry[];
  /** El usuario hizo clic en una evidencia ("M3" fotograma 2, o "C12"). */
  onEvidence: (ref: EvidenceRef) => void;
  /** Forzar una nueva fusión. */
  onReanalyze: () => void;
  /** Modo de la instancia: ajusta la explicación del rótulo "Simulado" del pie (opcional). */
  mode?: RuntimeMode | null;
  className?: string;
}
