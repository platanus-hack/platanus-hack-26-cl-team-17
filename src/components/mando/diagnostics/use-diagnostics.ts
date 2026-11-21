"use client";
/**
 * Diagnóstico en vivo para la banda y el detalle de la vista técnica. Cada componente lo usa
 * por su cuenta (SWR comparte la caché y no duplica la consulta) para que el reloj de cada
 * segundo y el sondeo de cada 3 s no vuelvan a dibujar la vista del incidente.
 */
import { useMemo } from "react";
import { useNow } from "@/components/ui";
import { errorMessage } from "@/lib/client/api";
import { useIncidentDiagnostics } from "@/lib/client/use-live";
import type { IncidentDiagnostics } from "@/lib/contract";
import { agoText, subsystems, type SubsystemStatus } from "./model";

export interface LiveDiagnostics {
  d: IncidentDiagnostics | null;
  /** Hora del servidor estimada ahora (se mueve cada segundo). */
  nowMs: number;
  items: SubsystemStatus[] | null;
  /** El diagnóstico no se pudo actualizar (null = al día). */
  offline: { since: string | null; message: string } | null;
  lastUpdatedAt: number | null;
}

export function useLiveDiagnostics(incidentId: string): LiveDiagnostics {
  const { diagnostics: d, error, stale, lastUpdatedAt } = useIncidentDiagnostics(incidentId);
  const clientNow = useNow(1000);
  // Desfase entre el reloj del servidor y el de este equipo, medido en la última respuesta.
  const offset = d && lastUpdatedAt !== null ? Date.parse(d.server_time) - lastUpdatedAt : 0;
  const nowMs = clientNow !== null ? clientNow + offset : d ? Date.parse(d.server_time) : 0;
  const items = useMemo(() => (d ? subsystems(d, nowMs) : null), [d, nowMs]);

  let offline: LiveDiagnostics["offline"] = null;
  if (stale || (error && error.code !== "aborted")) {
    const since = lastUpdatedAt !== null && clientNow !== null ? agoText(new Date(lastUpdatedAt).toISOString(), clientNow) : null;
    offline = {
      since: since ? `(último dato ${since})` : null,
      message: error ? errorMessage(error) : "El servidor no responde al diagnóstico.",
    };
  }
  return { d, nowMs, items, offline, lastUpdatedAt };
}
