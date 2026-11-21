"use client";

import { memo } from "react";
import {
  CircleAlert,
  CircleDashed,
  CircleHelp,
  Drone,
  FlaskConical,
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
      variant="soft"
      size={size}
      icon={trappedIcon[status]}
      pulse={alarm}
    >
      Atrapados: {labelOr(trappedStatusLabel, status)}
    </Badge>
  );
}

/** Confianza del informe y aviso de simulación junto al estado de atrapados (lo que dice la IA siempre muestra cuánto confía). */
export function ReportMeta({ incident: i, compact = false }: { incident: IncidentSummary; compact?: boolean }) {
  const confidence = i.situation_confidence ?? null;
  const simulated = i.situation_engine === "simulated" && i.origin !== "demo";
  if (!confidence && !simulated) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {confidence && <ConfidenceMeter level={confidence} size="sm" showLabel={!compact} />}
      {simulated &&
        (compact ? (
          <span className="inline-flex text-warning" title="Informe del motor de reglas, no del modelo de IA">
            <FlaskConical aria-hidden="true" className="size-3.5" />
            <span className="sr-only">Simulado</span>
          </span>
        ) : (
          <Badge tone="warning" icon={FlaskConical} title="Informe del motor de reglas, no del modelo de IA">
            Simulado
          </Badge>
        ))}
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

/** Tarjeta de un incidente para el tablero (al estilo de un post de X); enlaza a `/mando/<id>`. */
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
        className={cn("flex items-start gap-3", selected && "bg-surface-2/60", closed && "opacity-70")}
      >
        <span
          className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-surface-2 text-text"
          title={labelOr(incidentTypeLabel, i.type)}
        >
          <TypeIcon aria-hidden="true" className="size-[18px]" />
          <span className="sr-only">{labelOr(incidentTypeLabel, i.type)}</span>
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <h3 className="min-w-0 flex-1 truncate text-[15px] leading-5 font-bold">{i.title || "Sin título"}</h3>
            <span className="sr-only">{closed ? "Duración" : "Tiempo transcurrido"}</span>
            <Elapsed since={i.created_at} until={closed ? i.updated_at : null} className="shrink-0 text-sm text-muted" />
          </div>
          <p className="truncate text-[15px] leading-5 text-muted">{i.address || "Sin dirección"}</p>

          <div className="mt-2 flex flex-wrap items-center gap-2">
            <TrappedBadge status={i.trapped_status} size="md" />
            {i.trapped_status !== null && <ReportMeta incident={i} compact />}
            {/* La gravedad ya va en el color del borde; el texto queda para lectores de pantalla. */}
            {i.severity && <span className="sr-only">Gravedad {labelOr(severityLabel, i.severity).toLowerCase()}</span>}
            <span className="sr-only">{labelOr(incidentStatusLabel, i.status)}</span>

            <span className="ml-auto inline-flex items-center gap-3 text-xs text-muted">
              {!i.verified && (
                <span className="inline-flex text-warning" title="Sin verificar">
                  <CircleDashed aria-hidden="true" className="size-3.5" />
                  <span className="sr-only">Sin verificar</span>
                </span>
              )}
              {i.origin === "demo" && (
                <span className="inline-flex" title="Datos ficticios de demostración">
                  <FlaskConical aria-hidden="true" className="size-3.5" />
                  <span className="sr-only">Demo</span>
                </span>
              )}
              <Count icon={Video} n={i.media_count} label={pluralize(i.media_count, "medio", "medios")} />
              <Count icon={Radio} n={i.comms_count} label={pluralize(i.comms_count, "comunicación", "comunicaciones")} />
              {i.active_missions > 0 && (
                <span className="text-drone">
                  <Count icon={Drone} n={i.active_missions} label={pluralize(i.active_missions, "dron activo", "drones activos")} />
                </span>
              )}
            </span>
          </div>
        </div>
      </Card>
    </div>
  );
});
