"use client";

import { memo, type ReactNode } from "react";
import { ChevronDown, Drone, OctagonAlert, Radio, TriangleAlert } from "lucide-react";
import type { TimelineEvent } from "@/lib/domain";
import type { MediaView } from "@/lib/contract";
import { Badge, Button, TimeAgo, toneSolidBg, toneSoftBg, toneText } from "@/components/ui";
import { cn } from "@/lib/cn";
import { formatClock, formatDateTime, pluralize } from "@/lib/format";
import {
  mediaKindLabel,
  mediaSourceIcon,
  timelineKindIcon,
  timelineKindLabel,
  timelineSeverityLabel,
  timelineSeverityTone,
} from "@/lib/labels";
import type { TimelineBurstRow } from "./timeline-core";

export interface RowHandlers {
  onOpenMedia?: (mediaId: string) => void;
  onOpenComm?: (commId: string) => void;
  onOpenMission?: (missionId: string) => void;
}

function EventTime({ at }: { at: string }) {
  return (
    <div className="flex shrink-0 flex-col items-end gap-0.5 text-right">
      {/* La hora depende de la zona del navegador; el servidor puede renderizar otra. */}
      <time dateTime={at} title={formatDateTime(at)} suppressHydrationWarning className="font-mono tabular text-xs text-text">
        {formatClock(at, { seconds: true })}
      </time>
      <TimeAgo iso={at} className="text-[11px] text-muted" />
    </div>
  );
}

function FreshBadge() {
  return (
    <Badge tone="accent" variant="solid" className="animate-fade-in">
      Nuevo
    </Badge>
  );
}

function SeverityBadge({ severity }: { severity: TimelineEvent["severity"] }) {
  if (severity === "critical") {
    return (
      <Badge tone="critical" variant="solid" icon={OctagonAlert}>
        {timelineSeverityLabel.critical}
      </Badge>
    );
  }
  if (severity === "warning") {
    return (
      <Badge tone="warning" icon={TriangleAlert}>
        {timelineSeverityLabel.warning}
      </Badge>
    );
  }
  return null;
}

function References({ event, media, handlers }: { event: TimelineEvent; media: MediaView | null; handlers: RowHandlers }) {
  const { onOpenMedia, onOpenComm, onOpenMission } = handlers;
  const items: ReactNode[] = [];

  if (event.media_id !== null) {
    if (media) {
      const MediaIcon = mediaSourceIcon[media.source];
      const what = `${mediaKindLabel[media.kind]} ${media.label}`;
      items.push(
        onOpenMedia ? (
          <Button
            key="media"
            size="sm"
            variant="secondary"
            icon={MediaIcon}
            aria-label={`Abrir ${what}`}
            onClick={() => onOpenMedia(media.id)}
          >
            {media.label}
          </Button>
        ) : (
          <Badge key="media" icon={MediaIcon} title={what}>
            {media.label}
          </Badge>
        ),
      );
    } else {
      // El medio referido no está en la lista: se muestra atenuado y sin acción.
      items.push(
        <Badge key="media" variant="outline" className="opacity-60" title="Este medio no está disponible">
          Medio no disponible
        </Badge>,
      );
    }
  }

  if (event.comm_id !== null) {
    const commId = event.comm_id;
    items.push(
      onOpenComm ? (
        <Button key="comm" size="sm" variant="secondary" icon={Radio} aria-label="Abrir la comunicación radial" onClick={() => onOpenComm(commId)}>
          Radio
        </Button>
      ) : (
        <Badge key="comm" icon={Radio}>
          Radio
        </Badge>
      ),
    );
  }

  if (event.mission_id !== null) {
    const missionId = event.mission_id;
    items.push(
      onOpenMission ? (
        <Button key="mission" size="sm" variant="secondary" icon={Drone} aria-label="Abrir la misión del dron" onClick={() => onOpenMission(missionId)}>
          Misión
        </Button>
      ) : (
        <Badge key="mission" tone="drone" icon={Drone}>
          Misión
        </Badge>
      ),
    );
  }

  if (items.length === 0) return null;
  return <div className="mt-1.5 flex flex-wrap items-center gap-1.5">{items}</div>;
}

export interface EventItemProps {
  event: TimelineEvent;
  /** null si el evento no cita medio o el medio no existe. */
  media: MediaView | null;
  fresh: boolean;
  handlers: RowHandlers;
  nested?: boolean;
}

/** Fila de un evento: ícono por tipo, color por severidad, texto, referencias y hora. */
export const EventItem = memo(function EventItem({ event, media, fresh, handlers, nested = false }: EventItemProps) {
  const tone = timelineSeverityTone[event.severity];
  const Icon = timelineKindIcon[event.kind];
  const strong = event.severity === "critical" || event.severity === "warning";

  return (
    <li
      data-event-id={event.id}
      data-fresh={fresh || undefined}
      className={cn(
        "relative flex gap-2.5 border-b border-line py-2.5 pr-3 transition-colors duration-1000",
        nested ? "pl-8" : "pl-3",
        fresh ? "bg-accent-soft animate-enter" : strong && toneSoftBg[tone],
      )}
    >
      {tone !== "neutral" && <span aria-hidden="true" className={cn("absolute inset-y-0 left-0 w-0.5", toneSolidBg[tone])} />}
      <Icon aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0", toneText[tone])} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="sr-only">{timelineKindLabel[event.kind]}:</span>
          <p className={cn("min-w-0 text-sm leading-snug text-text", strong && "font-semibold")}>{event.title}</p>
          <SeverityBadge severity={event.severity} />
          {fresh && <FreshBadge />}
        </div>
        {event.detail !== "" && <p className="mt-0.5 line-clamp-3 text-sm leading-snug text-muted">{event.detail}</p>}
        <References event={event} media={media} handlers={handlers} />
      </div>
      <EventTime at={event.at} />
    </li>
  );
});

export interface BurstItemProps {
  row: TimelineBurstRow;
  expanded: boolean;
  onToggle: (key: string) => void;
  freshIds: ReadonlySet<string>;
  handlers: RowHandlers;
  listId: string;
}

/** Racha de eventos de rutina del dron, plegada en una fila expandible. */
export const BurstItem = memo(function BurstItem({ row, expanded, onToggle, freshIds, handlers, listId }: BurstItemProps) {
  const freshCount = row.events.reduce((n, e) => (freshIds.has(e.id) ? n + 1 : n), 0);
  const latest = row.events[0];
  const missions = row.missionIds.length;

  return (
    <li className="border-b border-line">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={listId}
        onClick={() => onToggle(row.key)}
        className={cn(
          "relative flex w-full gap-2.5 py-2.5 pl-3 pr-3 text-left transition-colors duration-1000 hover:bg-surface-2",
          "focus-visible:-outline-offset-2",
          freshCount > 0 && !expanded && "bg-accent-soft",
        )}
      >
        <span aria-hidden="true" className={cn("absolute inset-y-0 left-0 w-0.5", toneSolidBg.drone)} />
        <Drone aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-drone" />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-medium leading-snug text-text">
              {pluralize(row.events.length, "evento de rutina del dron", "eventos de rutina del dron")}
            </span>
            {missions > 1 && <Badge tone="drone">{pluralize(missions, "misión", "misiones")}</Badge>}
            {freshCount > 0 && (
              <Badge tone="accent" variant="solid">
                {pluralize(freshCount, "nuevo", "nuevos")}
              </Badge>
            )}
          </span>
          <span className="mt-0.5 block truncate text-sm text-muted">Último: {latest.title}</span>
          <span className="mt-0.5 block font-mono tabular text-[11px] text-muted" suppressHydrationWarning>
            {formatClock(row.oldestAt, { seconds: true })} – {formatClock(row.newestAt, { seconds: true })}
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1">
          <TimeAgo iso={row.newestAt} className="text-[11px] text-muted" />
          <span className="inline-flex items-center gap-1 text-xs text-muted">
            {expanded ? "Ocultar" : "Ver"}
            <ChevronDown aria-hidden="true" className={cn("size-3.5 transition-transform", expanded && "rotate-180")} />
          </span>
        </span>
      </button>
      {/* Siempre presente para que aria-controls apunte a algo; las filas solo se montan al abrir. */}
      <ul id={listId} hidden={!expanded} aria-label="Eventos de rutina del dron" className="border-t border-line bg-surface-2/40">
        {expanded &&
          row.events.map((e) => (
            <EventItem key={e.id} event={e} media={null} fresh={freshIds.has(e.id)} handlers={handlers} nested />
          ))}
      </ul>
    </li>
  );
});
