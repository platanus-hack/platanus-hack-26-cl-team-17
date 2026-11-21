"use client";
/**
 * Vista técnica de un incidente (/mando/[id]/tecnica): la vista completa de siempre (radio,
 * dron, 3DGS, compartir, agregar videos) con la banda de estado de los sistemas arriba, y el
 * detalle del diagnóstico encima cuando se abre. ?diagnostico=1 lo abre de entrada (para dejarlo
 * fijo en una pantalla durante la demo).
 */
import { useCallback, useState } from "react";
import { IncidentView } from "@/components/mando/incident";
import { DiagnosticsBand } from "./DiagnosticsBand";
import { DiagnosticsDetail } from "./DiagnosticsDetail";
import type { SubsystemId } from "./model";
import { useLiveDiagnostics } from "./use-diagnostics";

const PARAM = "diagnostico";

/** Refleja el detalle abierto en la URL sin navegar (se puede recargar o compartir así). */
function syncUrl(open: boolean): void {
  const params = new URLSearchParams(window.location.search);
  if (open) params.set(PARAM, "1");
  else params.delete(PARAM);
  const qs = params.toString();
  window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`);
}

/** Banda conectada al diagnóstico en vivo: se vuelve a dibujar sola, sin tocar la vista del incidente. */
function LiveBand({
  incidentId,
  open,
  onOpen,
  onClose,
}: {
  incidentId: string;
  open: boolean;
  onOpen: (focus: SubsystemId | null) => void;
  onClose: () => void;
}) {
  const { items, offline } = useLiveDiagnostics(incidentId);
  return <DiagnosticsBand items={items} offline={offline} open={open} onOpen={onOpen} onClose={onClose} />;
}

export interface TechnicalViewProps {
  id: string;
  /** El detalle parte abierto (?diagnostico=1). */
  initialOpen?: boolean;
}

export function TechnicalView({ id, initialOpen = false }: TechnicalViewProps) {
  const [open, setOpen] = useState(initialOpen);
  const [focus, setFocus] = useState<SubsystemId | null>(null);

  const onOpen = useCallback((next: SubsystemId | null) => {
    setFocus(next);
    setOpen(true);
    syncUrl(true);
  }, []);
  const onClose = useCallback(() => {
    setOpen(false);
    setFocus(null);
    syncUrl(false);
  }, []);

  return (
    <IncidentView
      id={id}
      banner={<LiveBand incidentId={id} open={open} onOpen={onOpen} onClose={onClose} />}
      overlay={open ? <DiagnosticsDetail incidentId={id} focus={focus} onClose={onClose} /> : null}
    />
  );
}
