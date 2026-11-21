/** Contrato del cargador de medios reutilizable (vecinos y puesto de mando). */
import type { IncidentType } from "@/lib/domain";

export interface MediaUploaderProps {
  /** Código del incidente al que se adjunta; si falta, el servidor busca uno cercano o crea uno sin verificar. */
  incidentCode?: string;
  /** Tipo sugerido si hay que crear un incidente nuevo. */
  typeHint?: IncidentType;
  /** true cuando lo usa el puesto de mando (video recibido por otra vía): el medio queda como source "responder". */
  asResponder?: boolean;
  /** "vecino" = pasos grandes y guiados para teléfono; "mando" = compacto, arrastrar y soltar. */
  variant: "vecino" | "mando";
  /** Se llama cuando los fotogramas ya están arriba y el análisis comenzó (el video puede seguir subiendo). */
  onSubmitted?: (result: { mediaId: string; incidentCode: string; createdIncident: boolean }) => void;
  /** Se llama al terminar todo (incluido el video original o su omisión). */
  onDone?: () => void;
  className?: string;
}
