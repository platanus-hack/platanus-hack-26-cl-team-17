"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { CircleCheck, FlaskConical, Inbox, ListFilter, Map as MapIcon, Play, Plus, RefreshCw, ShieldAlert, WifiOff } from "lucide-react";
import { MandoShell } from "@/components/shell";
import { Badge, Button, EmptyState, SegmentedControl, Skeleton, TimeAgo } from "@/components/ui";
import { OverviewMap } from "@/components/map";
import { useIncidentList, useMe, useRuntimeMode } from "@/lib/client/use-live";
import { errorMessage } from "@/lib/client/api";
import type { IncidentSummary } from "@/lib/contract";
import { cn } from "@/lib/cn";
import { CitizenReportCard } from "./CitizenReportCard";
import { DashboardHeader } from "./DashboardHeader";
import { DemoMenu, useSeedDemo, useToggleScenario } from "./DemoMenu";
import { IncidentCard, incidentCardDomId } from "./IncidentCard";
import { NewIncidentDialog } from "./NewIncidentDialog";
import {
  dashboardCounts,
  filterCounts,
  filterIncidents,
  isIncidentFilter,
  sortByUrgency,
  splitUnverifiedCitizen,
  type IncidentFilter,
} from "./urgency";

/* ───────────── Filtro persistido en sessionStorage ───────────── */

const FILTER_KEY = "vigia:mando-filter";
const DEFAULT_FILTER: IncidentFilter = "active";
const filterListeners = new Set<() => void>();
// Respaldo en memoria si sessionStorage no está disponible (modo privado, bloqueado).
let memoryFilter: IncidentFilter = DEFAULT_FILTER;

function readFilter(): IncidentFilter {
  try {
    const v = window.sessionStorage.getItem(FILTER_KEY);
    if (isIncidentFilter(v)) return v;
  } catch {
    /* sin almacenamiento: queda el valor en memoria */
  }
  return memoryFilter;
}

function writeFilter(v: IncidentFilter): void {
  memoryFilter = v;
  try {
    window.sessionStorage.setItem(FILTER_KEY, v);
  } catch {
    /* sin almacenamiento: solo en memoria */
  }
  filterListeners.forEach((l) => l());
}

function subscribeFilter(l: () => void): () => void {
  filterListeners.add(l);
  return () => filterListeners.delete(l);
}

/** Filtro del tablero, sin desajuste de hidratación (el servidor ve el valor por defecto). */
function usePersistedFilter(): [IncidentFilter, (v: IncidentFilter) => void] {
  const value = useSyncExternalStore(subscribeFilter, readFilter, () => DEFAULT_FILTER);
  return [value, writeFilter];
}

/* ───────────── Textos por filtro ───────────── */

const FILTER_LABEL: Record<IncidentFilter, string> = {
  active: "Activos",
  controlled: "Controlados",
  closed: "Cerrados",
  all: "Todos",
};

const FILTER_EMPTY: Record<IncidentFilter, { title: string; description: string }> = {
  active: { title: "No hay incidentes activos", description: "Revisa Controlados o Cerrados, o crea uno nuevo." },
  controlled: { title: "No hay incidentes controlados", description: "Los incidentes pasan aquí cuando el oficial a cargo los marca como controlados." },
  closed: { title: "No hay incidentes cerrados", description: "Los incidentes cerrados y los reportes descartados aparecen aquí." },
  all: { title: "No hay incidentes", description: "Crea uno nuevo o carga datos de demostración." },
};

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

const NO_INCIDENTS: IncidentSummary[] = [];

/** Tablero del puesto de mando: incidentes por urgencia, reportes sin verificar y mapa general. */
export function DashboardView() {
  const router = useRouter();
  const list = useIncidentList();
  const runtime = useRuntimeMode();
  const { staff } = useMe();
  const { refresh } = list;
  const [filter, setFilter] = usePersistedFilter();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [pinnedId, setPinnedId] = useState<string | null>(null);

  const onChanged = useCallback(() => {
    void refresh();
  }, [refresh]);
  const { seed, seeding } = useSeedDemo(onChanged);
  const { toggle: toggleScenario, running: scenarioRunning } = useToggleScenario();

  const incidents = list.incidents ?? NO_INCIDENTS;
  const loaded = list.incidents !== null;
  const sorted = useMemo(() => sortByUrgency(incidents), [incidents]);
  const counts = useMemo(() => dashboardCounts(incidents), [incidents]);
  const perFilter = useMemo(() => filterCounts(incidents), [incidents]);
  const visible = useMemo(() => filterIncidents(sorted, filter), [sorted, filter]);
  const { unverified, rest } = useMemo(() => splitUnverifiedCitizen(visible), [visible]);

  const selectedId = hoveredId ?? pinnedId;

  // Sin sesión del personal: al inicio de sesión, volviendo aquí después.
  const unauthorized = list.error?.status === 401;
  useEffect(() => {
    if (unauthorized) router.replace("/login?next=" + encodeURIComponent("/mando"));
  }, [unauthorized, router]);

  const onMapSelect = useCallback((id: string) => {
    setPinnedId(id);
    document
      .getElementById(incidentCardDomId(id))
      ?.scrollIntoView({ block: "nearest", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }, []);

  const filterOptions = useMemo(
    () =>
      (Object.keys(FILTER_LABEL) as IncidentFilter[]).map((value) => ({
        value,
        label: (
          <span className="inline-flex items-center gap-1.5">
            {FILTER_LABEL[value]}
            {loaded && <span className="tabular text-xs text-muted">{perFilter[value]}</span>}
          </span>
        ),
      })),
    [loaded, perFilter],
  );

  const showBanner = loaded && (list.stale || list.error !== null) && !unauthorized;

  let body: ReactNode;
  if (!loaded && list.error) {
    body = (
      <EmptyState
        icon={list.error.status === 403 || unauthorized ? ShieldAlert : WifiOff}
        title={unauthorized ? "Tu sesión expiró" : list.error.status === 403 ? "No tienes acceso al puesto de mando" : "No se pudo cargar la lista de incidentes"}
        description={unauthorized ? "Te llevamos a iniciar sesión…" : errorMessage(list.error)}
        action={
          unauthorized ? undefined : (
            <Button icon={RefreshCw} onClick={() => void refresh()}>
              Reintentar
            </Button>
          )
        }
      />
    );
  } else if (!loaded) {
    body = (
      <ul aria-label="Cargando incidentes" aria-busy="true" className="flex flex-col gap-2">
        {[0, 1, 2, 3].map((k) => (
          <li key={k} className="rounded-lg border border-line bg-surface p-2.5">
            <Skeleton className="h-3 w-1/3" />
            <Skeleton className="mt-2 h-5 w-2/3" />
            <Skeleton className="mt-1.5 h-3.5 w-1/2" />
            <Skeleton className="mt-3 h-8 w-56" />
          </li>
        ))}
      </ul>
    );
  } else if (incidents.length === 0) {
    body = (
      <EmptyState
        icon={Inbox}
        title="No hay incidentes registrados"
        description={
          <>
            Crea uno con <strong>Nuevo incidente</strong>, o prueba Vigía con incidentes de demostración o un simulacro en
            vivo. Son <strong>datos ficticios</strong>, rotulados como DEMO.
          </>
        }
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <Button icon={FlaskConical} loading={seeding} onClick={() => void seed()}>
              Cargar incidentes de demostración
            </Button>
            <Button icon={Play} onClick={toggleScenario} disabled={scenarioRunning}>
              {scenarioRunning ? "Simulacro en curso" : "Iniciar simulacro en vivo"}
            </Button>
          </div>
        }
      />
    );
  } else if (visible.length === 0) {
    body = (
      <EmptyState
        compact
        icon={filter === "active" ? CircleCheck : ListFilter}
        title={FILTER_EMPTY[filter].title}
        description={FILTER_EMPTY[filter].description}
        action={
          filter !== "all" ? (
            <Button size="sm" variant="ghost" onClick={() => setFilter("all")}>
              Ver todos ({incidents.length})
            </Button>
          ) : undefined
        }
      />
    );
  } else {
    body = (
      <div className="flex flex-col gap-5">
        {unverified.length > 0 && (
          <section aria-labelledby="unverified-heading" className="flex flex-col gap-2">
            <h2 id="unverified-heading" className="label-caps flex items-center gap-2 text-xs text-critical">
              Reporte ciudadano sin verificar
              <Badge tone="critical" size="sm">
                {unverified.length}
              </Badge>
            </h2>
            <ul className="flex flex-col gap-2">
              {unverified.map((i) => (
                <li
                  key={i.id}
                  id={incidentCardDomId(i.id)}
                  className={cn("scroll-my-4 rounded-lg", selectedId === i.id && "ring-2 ring-accent")}
                  onMouseEnter={() => setHoveredId(i.id)}
                  onMouseLeave={() => setHoveredId(null)}
                >
                  <CitizenReportCard incident={i} onChanged={onChanged} />
                </li>
              ))}
            </ul>
          </section>
        )}
        {rest.length > 0 && (
          <section aria-labelledby="incidents-heading" className="flex flex-col gap-2">
            <h2 id="incidents-heading" className="label-caps text-xs text-muted">
              {FILTER_LABEL[filter]} · por urgencia
            </h2>
            <ul className="flex flex-col gap-2">
              {rest.map((i) => (
                <li key={i.id}>
                  <IncidentCard incident={i} selected={selectedId === i.id} onHover={setHoveredId} />
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    );
  }

  return (
    <MandoShell
      title="Incidentes"
      mode={list.mode ?? runtime.mode}
      staff={staff}
      actions={
        <>
          <DemoMenu onSeeded={onChanged} />
          <Button variant="primary" icon={Plus} onClick={() => setDialogOpen(true)}>
            <span className="max-sm:sr-only">Nuevo incidente</span>
          </Button>
        </>
      }
    >
      <div className="relative flex h-full min-h-0 flex-col overflow-y-auto lg:grid lg:grid-cols-[1fr_420px] lg:overflow-hidden">
        <div className="relative min-w-0 lg:h-full lg:min-h-0 lg:overflow-y-auto">
          <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4">
            {(loaded || !list.error) && <DashboardHeader counts={counts} loading={!loaded} />}

            {showBanner && (
              <div
                role="status"
                className="flex items-center gap-2 rounded-md border border-warning/40 bg-warning-soft px-3 py-1.5 text-sm text-warning"
              >
                <WifiOff aria-hidden="true" className="size-4 shrink-0" />
                <span className="min-w-0 flex-1">No se pudo actualizar la lista · reintentando…</span>
                {list.lastUpdatedAt !== null && (
                  <span className="shrink-0 text-xs text-muted">
                    Última actualización <TimeAgo iso={new Date(list.lastUpdatedAt).toISOString()} />
                  </span>
                )}
              </div>
            )}

            <div className="overflow-x-auto">
              <SegmentedControl
                ariaLabel="Filtrar incidentes por estado"
                options={filterOptions}
                value={filter}
                onChange={setFilter}
              />
            </div>

            {body}
          </div>
        </div>

        <section
          aria-label="Mapa de incidentes"
          className="relative order-first h-64 shrink-0 border-b border-line bg-surface-2 lg:order-none lg:h-full lg:border-b-0 lg:border-l"
        >
          <MapIcon aria-hidden="true" className="absolute left-1/2 top-1/2 size-8 -translate-1/2 text-faint" />
          <OverviewMap
            incidents={visible}
            selectedId={selectedId}
            onSelect={onMapSelect}
            theme="dark"
            className="relative h-full w-full"
          />
        </section>
      </div>

      <NewIncidentDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
    </MandoShell>
  );
}
