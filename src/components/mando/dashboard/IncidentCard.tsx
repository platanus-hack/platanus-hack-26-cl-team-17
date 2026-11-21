"use client";

import { memo } from "react";
import {
  CircleAlert,
  CircleDashed,
  CircleHelp,
  Drone,
  FlaskConical,
  MapPin,
  Radio,
  ShieldCheck,
  Siren,
  Video,
  type LucideIcon,
} from "lucide-react";
import { Badge, Card, ConfidenceMeter, Elapsed, type Tone } from "@/components/ui";
import type { IncidentSummary } from "@/lib/contract";
import type { TrappedStatus } from "@/lib/domain";
import {
  incidentStatusLabel,
  incidentStatusTone,
  incidentTypeIcon,
  incidentTypeLabel,
  isTrappedAlarm,
  labelOr,
  severityLabel,
  severityTone,
  trappedStatusLabel,
  trappedTone,
} from "@/lib/labels";
import { pluralize } from "@/lib/format";
import { cn } from "@/lib/cn";

/** Props de `IncidentCard`. */
export interface IncidentCardProps {
  incident: IncidentSummary;
  /** Resaltada (sincronizada con el mapa). */
  selected?: boolean;
  /** Se llama con el id al pasar el cursor o enfocar, y con null al salir. */
  onHover?: (id: string | null) => void;
}

/** Id del elemento DOM de la tarjeta (para desplazarla a la vista desde el mapa). */
export function incidentCardDomId(id: string): string {
  return `incident-card-${id}`;
}

const trappedIcon: Record<TrappedStatus, LucideIcon> = {
  confirmed: Siren,
  probable: Siren,
  possible: CircleAlert,
  no_evidence: CircleHelp,
  cleared_by_unit: ShieldCheck,
};

/** Insignia grande del estado de personas atrapadas; sin análisis nunca se lee como "seguro". */
export function TrappedBadge({ status, size = "lg" }: { status: TrappedStatus | null; size?: "md" | "lg" }) {
  if (status === null || !Object.prototype.hasOwnProperty.call(trappedTone, status)) {
    return (
      <Badge tone="neutral" variant="outline" size={size} icon={CircleDashed} title="Personas atrapadas: aún no hay análisis">
        Atrapados: sin análisis aún
      </Badge>
    );
  }
  const alarm = isTrappedAlarm(status);
  return (
    <Badge
      tone={trappedTone[status]}
      variant={alarm ? "solid" : "soft"}
      size={size}
      icon={trappedIcon[status]}
      pulse={alarm}
    >
      Atrapados: {labelOr(trappedStatusLabel, status)}
    </Badge>
  );
}

/** Confianza del informe y aviso de simulación junto al estado de atrapados (lo que dice la IA siempre muestra cuánto confía). */
export function ReportMeta({ incident: i }: { incident: IncidentSummary }) {
  const confidence = i.situation_confidence ?? null;
  const simulated = i.situation_engine === "simulated" && i.origin !== "demo";
  if (!confidence && !simulated) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {confidence && <ConfidenceMeter level={confidence} size="sm" />}
      {simulated && (
        <Badge tone="warning" icon={FlaskConical} title="Informe del motor de reglas, no del modelo de IA">
          Simulado
        </Badge>
      )}
    </span>
  );
}

function stripeTone(i: IncidentSummary): Tone {
  if (i.status === "closed") return "neutral";
  if (isTrappedAlarm(i.trapped_status)) return "critical";
  return i.severity ? (severityTone[i.severity] ?? "neutral") : "neutral";
}

function Count({ icon: Icon, n, label }: { icon: LucideIcon; n: number; label: string }) {
  return (
    <span className="inline-flex items-center gap-1" title={label}>
      <Icon aria-hidden="true" className="size-3.5" />
      <span aria-hidden="true" className="tabular">
        {n}
      </span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** Tarjeta densa de un incidente para el tablero; enlaza a `/mando/<id>`. */
export const IncidentCard = memo(function IncidentCard({ incident: i, selected = false, onHover }: IncidentCardProps) {
  const TypeIcon = incidentTypeIcon[i.type] ?? CircleHelp;
  const closed = i.status === "closed";

  return (
    <div
      id={incidentCardDomId(i.id)}
      className="scroll-my-4"
      onMouseEnter={onHover ? () => onHover(i.id) : undefined}
      onMouseLeave={onHover ? () => onHover(null) : undefined}
      onFocus={onHover ? () => onHover(i.id) : undefined}
      onBlur={onHover ? () => onHover(null) : undefined}
    >
      <Card
        href={`/mando/${encodeURIComponent(i.id)}`}
        tone={stripeTone(i)}
        selected={selected}
        padding="sm"
        className={cn("flex flex-col gap-2", selected && "bg-surface-2/60", closed && "opacity-80")}
      >
        <div className="flex items-center gap-2 text-xs text-muted">
          <TypeIcon aria-hidden="true" className="size-4 shrink-0 text-text" />
          <span className="label-caps truncate">{labelOr(incidentTypeLabel, i.type)}</span>
          <span className="font-mono text-faint">{i.code}</span>
          <span className="ml-auto inline-flex items-center gap-1.5">
            <span className="sr-only">{closed ? "Duración" : "Tiempo transcurrido"}</span>
            <Elapsed since={i.created_at} until={closed ? i.updated_at : null} className="text-sm text-text" />
          </span>
        </div>

        <div className="min-w-0">
          <h3 className="truncate font-display text-lg font-semibold leading-tight">{i.title || "Sin título"}</h3>
          <p className="flex min-w-0 items-center gap-1 text-sm text-muted">
            <MapPin aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="truncate">{i.address || "Sin dirección"}</span>
          </p>
        </div>

        {i.headline && <p className="line-clamp-2 text-sm text-text">{i.headline}</p>}

        <div className="flex flex-wrap items-center gap-1.5">
          <TrappedBadge status={i.trapped_status} />
          {i.severity && (
            <Badge tone={severityTone[i.severity] ?? "neutral"} size="md">
              Gravedad {labelOr(severityLabel, i.severity).toLowerCase()}
            </Badge>
          )}
          {i.trapped_status !== null && <ReportMeta incident={i} />}
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted">
          <Badge tone={incidentStatusTone[i.status] ?? "neutral"} variant="outline" dot>
            {labelOr(incidentStatusLabel, i.status)}
          </Badge>
          {!i.verified && (
            <Badge tone="warning" variant="outline">
              Sin verificar
            </Badge>
          )}
          {i.origin === "demo" && (
            <Badge tone="info" icon={FlaskConical} title="Datos ficticios de demostración">
              Demo
            </Badge>
          )}
          <span className="ml-auto inline-flex items-center gap-3">
            <Count icon={Video} n={i.media_count} label={pluralize(i.media_count, "medio", "medios")} />
            <Count icon={Radio} n={i.comms_count} label={pluralize(i.comms_count, "comunicación", "comunicaciones")} />
            {i.active_missions > 0 && (
              <span className="text-drone">
                <Count icon={Drone} n={i.active_missions} label={pluralize(i.active_missions, "dron activo", "drones activos")} />
              </span>
            )}
          </span>
        </div>
      </Card>
    </div>
  );
});
