/** Contrato del panel de comunicaciones del puesto de mando. */
import type { AnalysisEngine, CommEntry, CommsAnalysis, PipelineState } from "@/lib/domain";

export interface CommsPanelProps {
  incidentId: string;
  comms: CommEntry[];
  analysis: CommsAnalysis | null;
  engine: AnalysisEngine | null;
  analysisUpdatedAt: string | null;
  pipeline: PipelineState;
  /** Pide refrescar el snapshot tras agregar una entrada. */
  onChanged: () => void;
  /** Entrada a resaltar y llevar a la vista (cuando el usuario hace clic en una evidencia "C12"). */
  highlightSeq?: number | null;
  className?: string;
}
