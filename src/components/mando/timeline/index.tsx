"use client";

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { BellRing, Drone, History, LayoutList, Radio, Video } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { MediaView } from "@/lib/contract";
import { Badge, Button, EmptyState, Panel, TabPanel, Tabs, type TabItem } from "@/components/ui";
import { pluralize } from "@/lib/format";
import type { TimelinePanelProps } from "./types";
import {
  advanceSeen,
  clearFresh,
  countByFilter,
  filterEvents,
  groupTimeline,
  initSeen,
  TIMELINE_FILTERS,
  timelineFilterLabel,
  type SeenState,
  type TimelineFilter,
} from "./timeline-core";
import { BurstItem, EventItem, type RowHandlers } from "./TimelineRows";

export type { TimelinePanelProps } from "./types";

/** Tiempo que una fila nueva queda resaltada. */
const FRESH_MS = 6000;
/** Filas que se montan de entrada; el resto se pide con "Mostrar más". */
const PAGE_ROWS = 80;

const filterIcon: Record<TimelineFilter, LucideIcon> = {
  all: LayoutList,
  alerts: BellRing,
  media: Video,
  comms: Radio,
  drone: Drone,
};

const emptyByFilter: Record<Exclude<TimelineFilter, "all">, { title: string; description: string }> = {
  alerts: { title: "Sin alertas", description: "Aquí aparecen las alertas, advertencias y errores del incidente." },
  media: { title: "Sin videos ni fotos", description: "Aquí aparecen los medios recibidos y sus análisis." },
  comms: { title: "Sin eventos de radio", description: "Aquí aparecen las comunicaciones y alertas radiales." },
  drone: { title: "Sin actividad del dron", description: "Aquí aparecen las misiones del dron y sus avisos." },
};

/** Línea de tiempo del incidente: recientes arriba, filtros, resaltado de novedades y ráfagas del dron plegadas. */
export function TimelinePanel({ events, media, onOpenMedia, onOpenComm, onOpenMission, className }: TimelinePanelProps) {
  const baseId = useId();
  const tabsPrefix = `${baseId}-timeline`;
  const [filter, setFilter] = useState<TimelineFilter>("all");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [limit, setLimit] = useState(PAGE_ROWS);

  // Registro de vistos: se ajusta durante el render cuando cambia la lista (patrón de React para
  // derivar estado de props), así la primera carga no se resalta y las novedades sí.
  const [seenState, setSeenState] = useState<SeenState>(() => initSeen(events));
  let seen = seenState;
  if (seenState.source !== events) {
    seen = advanceSeen(seenState, events);
    setSeenState(seen);
  }
  const fresh = seen.fresh;

  useEffect(() => {
    if (fresh.size === 0) return;
    const timer = setTimeout(() => setSeenState((s) => clearFresh(s, fresh)), FRESH_MS);
    return () => clearTimeout(timer);
  }, [fresh]);

  const mediaById = useMemo(() => {
    const map = new Map<string, MediaView>();
    for (const m of media) map.set(m.id, m);
    return map;
  }, [media]);

  const { counts, hasCritical } = useMemo(() => countByFilter(events), [events]);
  const rows = useMemo(() => groupTimeline(filterEvents(events, filter)), [events, filter]);

  const handlers = useMemo<RowHandlers>(
    () => ({ onOpenMedia, onOpenComm, onOpenMission }),
    [onOpenMedia, onOpenComm, onOpenMission],
  );

  const toggle = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const changeFilter = (next: TimelineFilter) => {
    setFilter(next);
    setLimit(PAGE_ROWS);
  };

  const tabs: TabItem<TimelineFilter>[] = TIMELINE_FILTERS.map((id) => ({
    id,
    label: timelineFilterLabel[id],
    icon: filterIcon[id],
    count: counts[id],
    alert: id === "alerts" && hasCritical,
  }));

  const visible = rows.length > limit ? rows.slice(0, limit) : rows;
  const hidden = rows.length - visible.length;

  return (
    <Panel
      title="Línea de tiempo"
      icon={History}
      badge={
        events.length > 0 ? (
          <Badge>
            <span className="tabular">{pluralize(events.length, "evento")}</span>
          </Badge>
        ) : undefined
      }
      scroll
      flush
      className={className}
    >
      <div className="sticky top-0 z-10 bg-surface">
        <Tabs
          tabs={tabs}
          value={filter}
          onChange={changeFilter}
          size="sm"
          ariaLabel="Filtrar la línea de tiempo"
          idPrefix={tabsPrefix}
        />
      </div>
      <TabPanel id={filter} idPrefix={tabsPrefix} active keepMounted={false}>
        {events.length === 0 ? (
          <EmptyState
            icon={History}
            title="Todavía no hay eventos"
            description="Aquí aparecerán los videos recibidos, los análisis de la IA, las alertas, la radio y el dron, con los más recientes arriba."
          />
        ) : rows.length === 0 && filter !== "all" ? (
          <EmptyState compact icon={filterIcon[filter]} {...emptyByFilter[filter]} />
        ) : (
          <>
            <ul aria-label={`Eventos: ${timelineFilterLabel[filter]}`}>
              {visible.map((row) =>
                row.type === "event" ? (
                  <EventItem
                    key={row.key}
                    event={row.event}
                    media={row.event.media_id !== null ? (mediaById.get(row.event.media_id) ?? null) : null}
                    fresh={fresh.has(row.event.id)}
                    handlers={handlers}
                  />
                ) : (
                  <BurstItem
                    key={row.key}
                    row={row}
                    expanded={expanded.has(row.key)}
                    onToggle={toggle}
                    freshIds={fresh}
                    handlers={handlers}
                    listId={`${baseId}-${row.key}`}
                  />
                ),
              )}
            </ul>
            {hidden > 0 && (
              <div className="flex justify-center p-3">
                <Button size="sm" variant="ghost" onClick={() => setLimit((n) => n + PAGE_ROWS)}>
                  Mostrar {Math.min(hidden, PAGE_ROWS)} más ({hidden} {hidden === 1 ? "oculto" : "ocultos"})
                </Button>
              </div>
            )}
          </>
        )}
      </TabPanel>
    </Panel>
  );
}
