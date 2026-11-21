"use client";

import { useState } from "react";
import { CircleHelp, ExternalLink, MapPin, Megaphone, ShieldCheck, Video, X } from "lucide-react";
import { Badge, Button, Card, ConfirmDialog, TimeAgo, useToast } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import type { IncidentSummary } from "@/lib/contract";
import { incidentTypeIcon, incidentTypeLabel, labelOr, severityLabel, severityTone } from "@/lib/labels";
import { pluralize } from "@/lib/format";
import { ReportMeta, TrappedBadge } from "./IncidentCard";

/** Props de `CitizenReportCard`. */
export interface CitizenReportCardProps {
  incident: IncidentSummary;
  /** Se llama tras verificar o descartar (para refrescar la lista). */
  onChanged: () => void;
}

/** Reporte ciudadano sin verificar: abrir, verificar o descartar (cierra el incidente). */
export function CitizenReportCard({ incident: i, onChanged }: CitizenReportCardProps) {
  const { toast } = useToast();
  const [verifying, setVerifying] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const TypeIcon = incidentTypeIcon[i.type] ?? CircleHelp;
  const titleId = `citizen-report-${i.id}`;

  const verify = async () => {
    setVerifying(true);
    try {
      await api.incidents.patch(i.id, { verified: true });
      toast({ title: "Reporte verificado", description: i.title || i.address, tone: "ok" });
      onChanged();
    } catch (err) {
      toast({ title: "No se pudo verificar el reporte", description: errorMessage(err), tone: "critical" });
    } finally {
      setVerifying(false);
    }
  };

  const discard = async () => {
    setDiscarding(true);
    try {
      await api.incidents.patch(i.id, { status: "closed" });
      setConfirmOpen(false);
      toast({ title: "Reporte descartado", description: "El incidente quedó cerrado.", tone: "neutral" });
      onChanged();
    } finally {
      setDiscarding(false);
    }
  };

  return (
    <Card tone="critical" padding="sm" role="group" className="border-critical/40" aria-labelledby={titleId}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
        <div className="min-w-0 flex-1">
          <p id={titleId} className="label-caps flex items-center gap-1.5 text-xs text-critical">
            <Megaphone aria-hidden="true" className="size-3.5" />
            Reporte ciudadano sin verificar
          </p>
          <p className="mt-1 flex min-w-0 items-center gap-1.5 font-display text-base font-semibold">
            <TypeIcon aria-hidden="true" className="size-4 shrink-0" />
            <span className="truncate">{i.title || labelOr(incidentTypeLabel, i.type)}</span>
          </p>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-sm text-muted">
            <span className="inline-flex min-w-0 items-center gap-1">
              <MapPin aria-hidden="true" className="size-3.5 shrink-0" />
              <span className="truncate">{i.address || "Sin dirección"}</span>
            </span>
            <TimeAgo iso={i.created_at} />
            <span className="inline-flex items-center gap-1">
              <Video aria-hidden="true" className="size-3.5" />
              {pluralize(i.media_count, "medio", "medios")}
            </span>
          </div>
          {/* Lo que la IA ya ve importa aunque el reporte no esté verificado (nunca se descartan víctimas). */}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <TrappedBadge status={i.trapped_status} size="md" />
            {i.severity && (
              <Badge tone={severityTone[i.severity] ?? "neutral"} size="md">
                Gravedad {labelOr(severityLabel, i.severity).toLowerCase()}
              </Badge>
            )}
            {i.trapped_status !== null && <ReportMeta incident={i} />}
          </div>
          {i.headline && <p className="mt-1.5 line-clamp-2 text-sm text-text">{i.headline}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="ghost" icon={ExternalLink} href={`/mando/${encodeURIComponent(i.id)}`}>
            Abrir
          </Button>
          <Button size="sm" variant="primary" icon={ShieldCheck} loading={verifying} disabled={discarding} onClick={verify}>
            Verificar
          </Button>
          <Button size="sm" variant="secondary" icon={X} disabled={verifying} onClick={() => setConfirmOpen(true)}>
            Descartar
          </Button>
        </div>
      </div>
      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={discard}
        title="¿Descartar este reporte?"
        description="El incidente quedará cerrado."
        confirmLabel="Descartar"
        danger
        loading={discarding}
      />
    </Card>
  );
}
