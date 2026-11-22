"use client";

import { memo, type ReactNode } from "react";
import { ChevronDown, Drone, OctagonAlert, Radio, TriangleAlert, type LucideIcon } from "lucide-react";
import type { TimelineEvent } from "@/lib/domain";
import type { MediaView } from "@/lib/contract";
import { Badge, toneSolidBg, toneSoftBg, toneText } from "@/components/ui";
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

function EventTime({ at, title }: { at: string; title?: string }) {
  return (
    // La hora depende de la zona del navegador; el servidor puede renderizar otra.
    <time
      dateTime={at}
      title={title ?? formatDateTime(at)}
      suppressHydrationWarning
      className="shrink-0 pt-0.5 font-mono tabular text-[11px] text-muted"
    >
      {formatClock(at, { seconds: true })}
    </time>
  );
}

function FreshBadge() {
  return (
    <Badge tone="accent" variant="solid" className="animate-fade-in">
      Nuevo
    </Badge>
  );
}

/** Severidad con ícono y texto, sin caja salvo lo crítico. */
function SeverityMark({ severity }: { severity: TimelineEvent["severity"] }) {
  if (severity === "critical") {
    return (
      <Badge tone="critical" icon={OctagonAlert}>
        {timelineSeverityLabel.critical}
      </Badge>
    );
  }
  if (severity === "warning") {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-medium text-warning">
        <TriangleAlert aria-hidden="true" className="size-3 shrink-0" />
        {timelineSeverityLabel.warning}
      </span>
    );
  }
  return null;
}

const refChip = "inline-flex h-6 max-w-full items-center gap-1 rounded-full border border-line px-2 text-xs font-medium";

function RefButton({ icon: Icon, label, ariaLabel, onClick }: { icon: LucideIcon; label: string; ariaLabel: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={onClick}
      className={cn(refChip, "text-text transition-colors hover:border-line-strong hover:bg-surface-2")}
    >
      <Icon aria-hidden="true" className="size-3 shrink-0" />
      {label}
    </button>
  );
}

function RefTag({ icon: Icon, label, title, unavailable = false }: { icon?: LucideIcon; label: string; title?: string; unavailable?: boolean }) {
  return (
    <span title={title} className={cn(refChip, unavailable ? "border-dashed text-faint opacity-60" : "text-text")}>
      {Icon ? <Icon aria-hidden="true" className="size-3 shrink-0" /> : null}
      {label}
    </span>
  );
}

function references(event: TimelineEvent, media: MediaView | null, handlers: RowHandlers): ReactNode[] {
  const { onOpenMedia, onOpenComm, onOpenMission } = handlers;
  const items: ReactNode[] = [];

  if (event.media_id !== null) {
    if (media) {
      const what = `${mediaKindLabel[media.kind]} ${media.label}`;
      const icon = mediaSourceIcon[media.source];
      items.push(
        onOpenMedia ? (
          <RefButton key="media" icon={icon} label={media.label} ariaLabel={`Abrir ${what}`} onClick={() => onOpenMedia(media.id)} />
        ) : (
          <RefTag key="media" icon={icon} label={media.label} title={what} />
        ),
      );
    } else {
      // El medio referido no está en la lista: se muestra atenuado y sin acción.
      items.push(<RefTag key="media" label="Medio no disponible" title="Este medio no está disponible" unavailable />);
    }
  }

  if (event.comm_id !== null) {
    const commId = event.comm_id;
    items.push(
      onOpenComm ? (
        <RefButton key="comm" icon={Radio} label="Radio" ariaLabel="Abrir la comunicación radial" onClick={() => onOpenComm(commId)} />
      ) : (
        <RefTag key="comm" icon={Radio} label="Radio" />
      ),
    );
  }

  if (event.mission_id !== null) {
    const missionId = event.mission_id;
    items.push(
      onOpenMission ? (
        <RefButton key="mission" icon={Drone} label="Misión" ariaLabel="Abrir la misión del dron" onClick={() => onOpenMission(missionId)} />
      ) : (
        <RefTag key="mission" icon={Drone} label="Misión" />
      ),
    );
  }

  return items;
}

export interface EventItemProps {
  event: TimelineEvent;
  /** null si el evento no cita medio o el medio no existe. */
  media: MediaView | null;
  fresh: boolean;
  handlers: RowHandlers;
  nested?: boolean;
}

/** Fila de un evento: ícono por tipo, color por severidad, título y detalle en 2 líneas, referencias y hora. */
export const EventItem = memo(function EventItem({ event, media, fresh, handlers, nested = false }: EventItemProps) {
  const tone = timelineSeverityTone[event.severity];
  const Icon = timelineKindIcon[event.kind];
  const critical = event.severity === "critical";
  const refs = references(event, media, handlers);
  const hasMeta = event.severity === "warning" || critical || fresh || refs.length > 0;

  return (
    <li
      data-event-id={event.id}
      data-fresh={fresh || undefined}
      className={cn(
        "relative flex gap-2.5 border-b border-line py-2.5 pr-3 transition-colors duration-1000",
        nested ? "pl-8" : "pl-3",
        fresh ? "bg-accent-soft animate-enter" : critical && toneSoftBg.critical,
      )}
    >
      {tone !== "neutral" && <span aria-hidden="true" className={cn("absolute inset-y-0 left-0 w-0.5", toneSolidBg[tone])} />}
      <Icon aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0", toneText[tone])} />
      <div className="min-w-0 flex-1">
        <span className="sr-only">{timelineKindLabel[event.kind]}:</span>
        <p className={cn("line-clamp-2 text-sm leading-snug text-text", critical ? "font-semibold" : "font-medium")}>
          {event.title}
        </p>
        {event.detail !== "" && <p className="mt-0.5 line-clamp-2 text-sm leading-snug text-muted">{event.detail}</p>}
        {hasMeta && (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <SeverityMark severity={event.severity} />
            {fresh && <FreshBadge />}
            {refs}
          </div>
        )}
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
  const range = `${formatClock(row.oldestAt, { seconds: true })} – ${formatClock(row.newestAt, { seconds: true })}`;

  return (
    <li className="border-b border-line">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={listId}
        onClick={() => onToggle(row.key)}
        className={cn(
          "flex w-full gap-2.5 py-2.5 pl-3 pr-3 text-left transition-colors duration-1000 hover:bg-surface-2",
          "focus-visible:-outline-offset-2",
          freshCount > 0 && !expanded && "bg-accent-soft",
        )}
      >
        <Drone aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted" />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-medium leading-snug text-text">
              {pluralize(row.events.length, "evento de rutina del dron", "eventos de rutina del dron")}
            </span>
            {missions > 1 && <span className="text-xs text-muted">· {pluralize(missions, "misión", "misiones")}</span>}
            {freshCount > 0 && (
              <Badge tone="accent" variant="solid">
                {pluralize(freshCount, "nuevo", "nuevos")}
              </Badge>
            )}
          </span>
          <span className="mt-0.5 block truncate text-sm text-muted">Último: {latest.title}</span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1">
          <EventTime at={row.newestAt} title={range} />
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
