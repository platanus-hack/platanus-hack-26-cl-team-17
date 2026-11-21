"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  ArrowLeft,
  Box,
  CircleAlert,
  Drone,
  History,
  Images,
  LayoutList,
  Map as MapIcon,
  Radio,
  RotateCw,
  SearchX,
  ShieldAlert,
  WifiOff,
} from "lucide-react";
import {
  Badge,
  Button,
  EmptyState,
  SegmentedControl,
  Spinner,
  TabPanel,
  Tabs,
  useNow,
  useToast,
  type TabItem,
} from "@/components/ui";
import { MandoShell } from "@/components/shell";
import { Scene3D, type SceneSelection } from "@/components/scene3d";
import { TacticalMap } from "@/components/map";
import { CommsPanel } from "@/components/comms";
import { DronePanel, useSimulatedMissionTicker } from "@/components/drone";
import { CriticalStrip, SituationPanel } from "@/components/mando/situation";
import { TimelinePanel } from "@/components/mando/timeline";
import { ScenarioChip, scenarioVisible, useScenario } from "@/components/mando/scenario";
import { api, errorMessage, type ApiClientError } from "@/lib/client/api";
import { useIncidentSnapshot, useMe, useRuntimeMode } from "@/lib/client/use-live";
import type { IncidentSnapshot } from "@/lib/contract";
import type { DroneMission, EvidenceRef, PipelineStatus, TimelineEvent } from "@/lib/domain";
import { isTrappedAlarm } from "@/lib/labels";
import { cn } from "@/lib/cn";
import { IncidentHeader } from "./IncidentHeader";
import { IncidentSkeleton } from "./IncidentSkeleton";
import { MediaStrip } from "./MediaStrip";
import { MediaGrid } from "./MediaGrid";
import { MediaViewer } from "./MediaViewer";
import { ShareDialog } from "./ShareDialog";
import { AddMediaDialog } from "./AddMediaDialog";
import { useIncidentAlerts } from "./use-incident-alerts";
import { findMediaByLabel, type ActivityTab, type CenterView, type MediaViewerTarget } from "./types";

/** Props de la vista de mando de un incidente. */
export interface IncidentViewProps {
  id: string;
}

/** Zonas de la vista en teléfono (< 768 px), donde se muestran como pestañas. */
type MobileZone = "situacion" | "escena" | "actividad";

const NO_MISSIONS: DroneMission[] = [];
const ZONE_PREFIX = "zona";
const ACTIVITY_PREFIX = "actividad";
const DESKTOP_QUERY = "(min-width: 768px)";

/** Vista de mando de un incidente; se reinicia por completo al cambiar de incidente. */
export function IncidentView({ id }: IncidentViewProps) {
  return <IncidentScreen key={id} id={id} />;
}

/* ───────────── Utilidades locales ───────────── */

/** `matchMedia` como estado externo (false en el servidor y durante la hidratación). */
function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}

interface ActivityIds {
  timeline: string[];
  comms: string[];
  drone: string[];
}

type SeenState = Record<ActivityTab, ReadonlySet<string>>;

/**
 * Marca como vistos los ids de la pestaña que se está mirando. Devuelve el mismo objeto si nada
 * cambia (así se puede llamar en cada render sin provocar otro). La primera vez todo queda visto.
 */
function advanceSeen(prev: SeenState | null, ids: ActivityIds, viewing: ActivityTab | null): SeenState {
  if (!prev) {
    return { timeline: new Set(ids.timeline), comms: new Set(ids.comms), drone: new Set(ids.drone) };
  }
  if (!viewing) return prev;
  const current = prev[viewing];
  if (ids[viewing].every((x) => current.has(x))) return prev;
  return { ...prev, [viewing]: new Set([...current, ...ids[viewing]]) };
}

function isUnauthorized(err: ApiClientError | null): boolean {
  return err !== null && (err.status === 401 || err.code === "unauthorized");
}

/* ───────────── Pantalla ───────────── */

function IncidentScreen({ id }: IncidentViewProps) {
  const router = useRouter();
  const pathname = usePathname();
  const { toast } = useToast();
  const { snapshot, error, refresh, lastUpdatedAt, stale } = useIncidentSnapshot(id);
  const { staff } = useMe();
  const { mode: runtimeMode } = useRuntimeMode();
  const mode = snapshot?.mode ?? runtimeMode;
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const scenario = useScenario();

  const refreshNow = useCallback(() => {
    refresh().catch(() => {
      /* el error queda en el estado del sondeo */
    });
  }, [refresh]);

  // Las misiones simuladas vuelan aunque la pestaña "Dron" no esté a la vista.
  useSimulatedMissionTicker(snapshot?.missions ?? NO_MISSIONS, refreshNow);

  /* Estado de la interfaz */
  const [centerView, setCenterView] = useState<CenterView>("scene");
  const [mapMounted, setMapMounted] = useState(false);
  const [activityTab, setActivityTab] = useState<ActivityTab>("timeline");
  const [mobileZone, setMobileZone] = useState<MobileZone>("situacion");
  const [viewer, setViewer] = useState<MediaViewerTarget | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [addMediaOpen, setAddMediaOpen] = useState(false);
  const [selection, setSelection] = useState<SceneSelection | null>(null);
  const [highlightSeq, setHighlightSeq] = useState<number | null>(null);

  // Último snapshot para los manejadores estables (los paneles no se re-renderizan por callbacks nuevos).
  const latest = useRef<IncidentSnapshot | null>(snapshot);
  useEffect(() => {
    latest.current = snapshot;
  }, [snapshot]);

  /* Navegación por evidencia */
  const showActivity = useCallback((tab: ActivityTab) => {
    setActivityTab(tab);
    setMobileZone("actividad");
  }, []);

  const openMediaById = useCallback((mediaId: string, frame?: number | null) => {
    setViewer({ mediaId, frame: frame ?? null });
  }, []);

  const openMediaByLabel = useCallback(
    (label: string, frame?: number | null) => {
      const media = findMediaByLabel(latest.current?.media ?? [], label);
      if (!media) {
        toast({ id: `missing-media:${label}`, title: `No encontramos el medio ${label.trim().toUpperCase()}`, tone: "warning" });
        return;
      }
      setViewer({ mediaId: media.id, frame: frame !== undefined && frame !== null && frame >= 0 ? frame : null });
    },
    [toast],
  );

  const openCommSeq = useCallback(
    (seq: number) => {
      showActivity("comms");
      if (!(latest.current?.comms ?? []).some((c) => c.seq === seq)) {
        toast({ id: `missing-comm:${seq}`, title: `No encontramos la comunicación C${seq}`, tone: "warning" });
      }
      // Volver a pedir la misma entrada debe volver a llevarla a la vista: se suelta y se vuelve a marcar.
      setHighlightSeq(null);
      requestAnimationFrame(() => setHighlightSeq(seq));
    },
    [showActivity, toast],
  );

  const onEvidence = useCallback(
    (ref: EvidenceRef) => {
      const tag = ref.ref.trim().toUpperCase();
      if (tag.startsWith("M")) {
        openMediaByLabel(tag, ref.frame);
      } else if (tag.startsWith("C")) {
        const seq = Number(tag.slice(1));
        if (Number.isInteger(seq) && seq > 0) openCommSeq(seq);
      }
    },
    [openMediaByLabel, openCommSeq],
  );

  const onOpenComm = useCallback(
    (commId: string) => {
      const comm = (latest.current?.comms ?? []).find((c) => c.id === commId);
      if (comm) openCommSeq(comm.seq);
      else showActivity("comms");
    },
    [openCommSeq, showActivity],
  );

  const onOpenMission = useCallback(() => showActivity("drone"), [showActivity]);

  const onOpenMediaLabel = useCallback((label: string, frame?: number) => openMediaByLabel(label, frame), [openMediaByLabel]);

  const onReanalyze = useCallback(() => {
    api.incidents
      .analyze(id, {})
      .then(() => {
        refreshNow();
        toast({ title: "Análisis solicitado", tone: "info" });
      })
      .catch((err: unknown) => {
        toast({ title: "No se pudo pedir el análisis", description: errorMessage(err), tone: "critical", duration: 8000 });
      });
  }, [id, refreshNow, toast]);

  const onCenterView = useCallback((v: CenterView) => {
    setCenterView(v);
    if (v === "map") setMapMounted(true);
  }, []);

  /* Avisos de alertas críticas nuevas */
  const onViewAlert = useCallback(
    (event: TimelineEvent) => {
      if (event.media_id) openMediaById(event.media_id);
      else if (event.comm_id) onOpenComm(event.comm_id);
      else if (event.mission_id) showActivity("drone");
      else showActivity("timeline");
    },
    [openMediaById, onOpenComm, showActivity],
  );
  const onViewTrapped = useCallback(() => setMobileZone("situacion"), []);
  useIncidentAlerts(snapshot, { onView: onViewAlert, onViewTrapped });

  /* Contadores de novedades por pestaña de actividad */
  const activityIds = useMemo<ActivityIds | null>(
    () =>
      snapshot
        ? {
            timeline: snapshot.events.map((e) => e.id),
            comms: snapshot.comms.map((c) => c.id),
            drone: snapshot.missions.map((m) => m.id),
          }
        : null,
    [snapshot],
  );
  const [seen, setSeen] = useState<SeenState | null>(null);
  const activityVisible = isDesktop || mobileZone === "actividad";
  if (activityIds) {
    const next = advanceSeen(seen, activityIds, activityVisible ? activityTab : null);
    if (next !== seen) setSeen(next);
  }
  const unseen = (tab: ActivityTab): number =>
    seen && activityIds ? activityIds[tab].reduce((n, x) => (seen[tab].has(x) ? n : n + 1), 0) : 0;
  const newTimeline = unseen("timeline");
  const newComms = unseen("comms");
  const newDrone = unseen("drone");
  const newCritical =
    seen !== null && snapshot !== null && snapshot.events.some((e) => e.severity === "critical" && !seen.timeline.has(e.id));

  /* Sesión vencida → iniciar sesión y volver aquí */
  const unauthorized = isUnauthorized(error);
  useEffect(() => {
    if (unauthorized) router.replace(`/login?next=${encodeURIComponent(pathname || `/mando/${id}`)}`);
  }, [unauthorized, router, pathname, id]);

  /* Título del documento con el estado de atrapados */
  const incident = snapshot?.incident ?? null;
  const docTitle = incident
    ? isTrappedAlarm(incident.situation?.trapped.status)
      ? `● ATRAPADOS — ${incident.title} · Vigía`
      : `${incident.title} · Vigía`
    : null;
  useEffect(() => {
    const original = document.title;
    return () => {
      document.title = original;
    };
  }, []);
  useEffect(() => {
    if (!docTitle) return;
    document.title = docTitle;
    // Los metadatos de la ruta pueden llegar después del primer efecto en una navegación del cliente.
    const late = window.setTimeout(() => {
      document.title = docTitle;
    }, 600);
    return () => window.clearTimeout(late);
  }, [docTitle]);

  /* ───────────── Estados sin datos ───────────── */

  if (!snapshot || !incident) {
    return (
      <MandoShell title="Incidente" back={{ href: "/mando", label: "Incidentes" }} mode={mode} staff={staff}>
        <NoSnapshotState error={error} unauthorized={unauthorized} onRetry={refreshNow} />
      </MandoShell>
    );
  }

  const fusion = incident.pipeline;
  const fusionRunning = fusion.fusion_status === "running";
  const demo = incident.origin === "demo";

  const activityTabs: TabItem<ActivityTab>[] = [
    {
      id: "timeline",
      label: "Línea de tiempo",
      icon: History,
      count: newTimeline > 0 ? newTimeline : undefined,
      alert: newCritical,
    },
    { id: "comms", label: "Comunicaciones", icon: Radio, count: newComms > 0 ? newComms : undefined },
    { id: "drone", label: "Dron", icon: Drone, count: newDrone > 0 ? newDrone : undefined },
  ];
  const newActivity = newTimeline + newComms + newDrone;
  const mobileTabs: TabItem<MobileZone>[] = [
    { id: "situacion", label: "Situación", icon: LayoutList },
    { id: "escena", label: "Escena", icon: Box, count: snapshot.media.length > 0 ? snapshot.media.length : undefined },
    {
      id: "actividad",
      label: "Actividad",
      icon: History,
      count: newActivity > 0 ? newActivity : undefined,
      alert: newCritical,
    },
  ];

  /** Atributos de una zona: es pestaña solo en teléfono (en escritorio todas están a la vista). */
  const zoneProps = (zone: MobileZone) => ({
    id: `${ZONE_PREFIX}-panel-${zone}`,
    role: isDesktop ? undefined : "tabpanel",
    "aria-labelledby": isDesktop ? undefined : `${ZONE_PREFIX}-tab-${zone}`,
  });

  return (
    <MandoShell
      title={incident.title}
      subtitle={incident.address || undefined}
      back={{ href: "/mando", label: "Incidentes" }}
      mode={mode}
      staff={staff}
    >
      <div className="flex h-full min-h-0 flex-col overflow-y-auto md:overflow-hidden">
        {stale && <StaleBanner lastUpdatedAt={lastUpdatedAt} />}
        {scenario.incidentId === incident.id && scenarioVisible(scenario) && (
          <ScenarioChip scenario={scenario} onDismiss={scenario.dismiss} variant="inline" className="shrink-0" />
        )}

        <IncidentHeader
          incident={incident}
          mode={snapshot.mode}
          onShare={() => setShareOpen(true)}
          onAddMedia={() => setAddMediaOpen(true)}
          onChanged={refreshNow}
          className="shrink-0"
        />

        <CriticalStrip
          incident={incident}
          mediaCount={snapshot.media.length}
          onEvidence={onEvidence}
          mode={snapshot.mode}
          className="shrink-0"
        />

        <div className="sticky top-0 z-10 shrink-0 bg-bg md:hidden">
          <Tabs
            tabs={mobileTabs}
            value={mobileZone}
            onChange={setMobileZone}
            idPrefix={ZONE_PREFIX}
            ariaLabel="Zonas del incidente"
            fullWidth
            size="sm"
          />
        </div>

        <div
          className={cn(
            "grid gap-2 p-2",
            "md:min-h-0 md:flex-1 md:grid-cols-[minmax(0,1fr)_340px] md:grid-rows-[minmax(0,1.3fr)_minmax(0,1fr)]",
            "xl:grid-cols-[360px_minmax(0,1fr)_380px] xl:grid-rows-1",
          )}
        >
          {/* IZQUIERDA · situación */}
          <section
            {...zoneProps("situacion")}
            aria-label="Situación"
            className={cn(
              "flex min-h-0 flex-col max-md:h-[75dvh]",
              "md:col-start-1 md:row-start-2 xl:row-start-1",
              mobileZone !== "situacion" && "max-md:hidden",
            )}
          >
            <div className="min-h-0 flex-1 overflow-y-auto">
              <SituationPanel
                incident={incident}
                media={snapshot.media}
                comms={snapshot.comms}
                onEvidence={onEvidence}
                onReanalyze={onReanalyze}
                mode={snapshot.mode}
                className="h-full"
              />
            </div>
          </section>

          {/* CENTRO · escena, mapa y medios */}
          <section
            {...zoneProps("escena")}
            aria-label="Escena"
            className={cn(
              "flex min-h-0 flex-col gap-2 max-md:h-[75dvh]",
              "md:col-start-1 md:row-start-1 xl:col-start-2",
              mobileZone !== "escena" && "max-md:hidden",
            )}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <SegmentedControl<CenterView>
                ariaLabel="Vista central"
                value={centerView}
                onChange={onCenterView}
                options={[
                  { value: "scene", label: "Reconstrucción 3D", icon: Box },
                  { value: "map", label: "Mapa", icon: MapIcon },
                  { value: "media", label: `Medios (${snapshot.media.length})`, icon: Images },
                ]}
              />
              <PipelineHint status={fusion.fusion_status} error={fusion.fusion_error} />
            </div>

            <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg border border-line bg-surface">
              <CenterLayer active={centerView === "scene"}>
                <Scene3D
                  scene={incident.scene}
                  incident={incident}
                  media={snapshot.media}
                  missions={snapshot.missions}
                  engine={incident.scene_engine}
                  updatedAt={incident.scene_updated_at}
                  updating={fusionRunning}
                  selection={selection}
                  onSelect={setSelection}
                  onOpenMedia={onOpenMediaLabel}
                  className="h-full w-full"
                />
              </CenterLayer>
              <CenterLayer active={centerView === "map"}>
                {mapMounted && (
                  <TacticalMap
                    incident={incident}
                    scene={incident.scene}
                    media={snapshot.media}
                    missions={snapshot.missions}
                    theme="dark"
                    onOpenMedia={onOpenMediaLabel}
                    className="h-full w-full"
                  />
                )}
              </CenterLayer>
              <CenterLayer active={centerView === "media"} scroll>
                <MediaGrid media={snapshot.media} onOpen={setViewer} mode={snapshot.mode} demo={demo} className="p-2" />
              </CenterLayer>
            </div>

            <MediaStrip media={snapshot.media} selectedId={viewer?.mediaId ?? null} onOpen={setViewer} className="shrink-0" />
          </section>

          {/* DERECHA · actividad */}
          <section
            {...zoneProps("actividad")}
            aria-label="Actividad"
            className={cn(
              "flex min-h-0 flex-col overflow-hidden rounded-lg border border-line bg-surface max-md:h-[75dvh]",
              "md:col-start-2 md:row-span-2 md:row-start-1 xl:col-start-3 xl:row-span-1",
              mobileZone !== "actividad" && "max-md:hidden",
            )}
          >
            <Tabs
              tabs={activityTabs}
              value={activityTab}
              onChange={setActivityTab}
              idPrefix={ACTIVITY_PREFIX}
              ariaLabel="Actividad del incidente"
              fullWidth
              size="sm"
              className="shrink-0"
            />
            <TabPanel id="timeline" idPrefix={ACTIVITY_PREFIX} active={activityTab === "timeline"} className="min-h-0 flex-1 overflow-y-auto">
              <TimelinePanel
                events={snapshot.events}
                media={snapshot.media}
                onOpenMedia={openMediaById}
                onOpenComm={onOpenComm}
                onOpenMission={onOpenMission}
                className="h-full"
              />
            </TabPanel>
            <TabPanel id="comms" idPrefix={ACTIVITY_PREFIX} active={activityTab === "comms"} className="min-h-0 flex-1 overflow-y-auto">
              <CommsPanel
                incidentId={incident.id}
                comms={snapshot.comms}
                analysis={incident.comms_analysis}
                engine={incident.comms_engine}
                analysisUpdatedAt={incident.comms_analysis_updated_at}
                pipeline={incident.pipeline}
                onChanged={refreshNow}
                highlightSeq={highlightSeq}
                className="h-full"
              />
            </TabPanel>
            <TabPanel id="drone" idPrefix={ACTIVITY_PREFIX} active={activityTab === "drone"} className="min-h-0 flex-1 overflow-y-auto">
              <DronePanel
                incident={incident}
                missions={snapshot.missions}
                media={snapshot.media}
                mode={snapshot.mode}
                onChanged={refreshNow}
                onOpenMedia={onOpenMediaLabel}
                className="h-full"
              />
            </TabPanel>
          </section>
        </div>
      </div>

      <MediaViewer
        incidentId={incident.id}
        media={snapshot.media}
        target={viewer}
        onClose={() => setViewer(null)}
        onChanged={refreshNow}
        mode={snapshot.mode}
        demo={demo}
      />
      <ShareDialog open={shareOpen} onClose={() => setShareOpen(false)} incident={incident} share={snapshot.share} />
      <AddMediaDialog
        open={addMediaOpen}
        onClose={() => setAddMediaOpen(false)}
        incidentCode={incident.code}
        onDone={refreshNow}
      />
    </MandoShell>
  );
}

/* ───────────── Piezas ───────────── */

/** Capa de la vista central: todas quedan montadas; la inactiva se oculta sin perder su tamaño. */
function CenterLayer({ active, scroll = false, children }: { active: boolean; scroll?: boolean; children: ReactNode }) {
  return (
    <div
      aria-hidden={active ? undefined : true}
      inert={!active}
      className={cn("absolute inset-0", scroll && "overflow-y-auto", !active && "invisible")}
    >
      {children}
    </div>
  );
}

/** Estado del análisis de fusión junto al conmutador central. */
function PipelineHint({ status, error }: { status: PipelineStatus; error: string | null }) {
  if (status === "running") {
    return (
      <span role="status" className="inline-flex items-center gap-1.5 text-xs text-muted">
        <Spinner size="xs" label="Actualizando análisis" />
        Actualizando análisis…
      </span>
    );
  }
  if (status === "pending") {
    return (
      <span role="status" className="text-xs text-muted">
        Análisis en cola
      </span>
    );
  }
  if (status === "error") {
    return (
      <Badge tone="critical" icon={CircleAlert} title={error ?? undefined}>
        Error en el último análisis
      </Badge>
    );
  }
  return null;
}

/** Banner persistente cuando el sondeo no logra actualizar los datos. */
function StaleBanner({ lastUpdatedAt }: { lastUpdatedAt: number | null }) {
  const now = useNow(1000);
  let since = "";
  if (now !== null && lastUpdatedAt !== null) {
    const s = Math.max(0, Math.round((now - lastUpdatedAt) / 1000));
    since = s < 120 ? ` desde hace ${s} s` : ` desde hace ${Math.floor(s / 60)} min`;
  }
  return (
    <div
      role="status"
      className="flex shrink-0 items-center gap-2 border-b border-warning/40 bg-warning-soft px-3 py-1.5 text-sm text-warning md:px-4"
    >
      <WifiOff aria-hidden="true" size={16} className="shrink-0" />
      <span>
        Sin conexión con el servidor{since} · los datos pueden estar desactualizados
      </span>
    </div>
  );
}

/** Carga, error o redirección cuando aún no hay snapshot. */
function NoSnapshotState({
  error,
  unauthorized,
  onRetry,
}: {
  error: ApiClientError | null;
  unauthorized: boolean;
  onRetry: () => void;
}) {
  const back = (
    <Button href="/mando" icon={ArrowLeft}>
      Volver a incidentes
    </Button>
  );

  if (unauthorized) {
    return (
      <div role="status" className="flex h-full items-center justify-center gap-2 p-6 text-sm text-muted">
        <Spinner size="sm" label="Redirigiendo" />
        Tu sesión venció. Te llevamos a iniciar sesión…
      </div>
    );
  }
  // Con error se muestra el error aunque el sondeo reintente (si no, alternaría con el esqueleto).
  if (error) {
    if (error.status === 404 || error.code === "not_found") {
      return (
        <EmptyState
          icon={SearchX}
          title="No encontramos este incidente"
          description="Puede que el enlace esté incompleto o que el incidente ya no exista."
          action={back}
          className="h-full"
        />
      );
    }
    if (error.status === 403 || error.code === "forbidden") {
      return (
        <EmptyState
          icon={ShieldAlert}
          title="No tienes acceso a este incidente"
          description={errorMessage(error)}
          action={back}
          className="h-full"
        />
      );
    }
    return (
      <EmptyState
        icon={WifiOff}
        title="No pudimos cargar el incidente"
        description={errorMessage(error)}
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <Button variant="primary" icon={RotateCw} onClick={onRetry}>
              Reintentar
            </Button>
            {back}
          </div>
        }
        className="h-full"
      />
    );
  }
  return <IncidentSkeleton />;
}
