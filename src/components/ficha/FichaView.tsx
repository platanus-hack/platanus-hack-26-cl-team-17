"use client";
/**
 * Ficha del incidente para el OBAC: mapa 3D a pantalla completa con lo crítico a la
 * izquierda, el historial del agente Vigía a la derecha y su último mensaje abajo al centro
 * (VigiaDock). La voz de Vigía sale solo por Zello: aquí no hay micrófono ni lectura en voz alta.
 * Pensada para leerse en 3 segundos desde 3 metros (tablet, notebook o proyector).
 *
 * Estados: normal · "llegando" (sin informe ni escena: ruta y unidades en camino) ·
 * "Vigía hablando" (su mensaje más reciente resaltado y el marcador pulsando). Para la demostración,
 * ?estado=llegando y ?estado=hablando los fuerzan sin tocar los datos.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type CSSProperties } from "react";
import dynamic from "next/dynamic";
import { usePathname, useRouter } from "next/navigation";
import { Box, Images, Map as MapIcon, Shapes } from "lucide-react";
import type { IncidentStatus, SceneModel } from "@/lib/domain";
import { api, errorMessage, type ApiClientError } from "@/lib/client/api";
import { useIncidentSnapshot } from "@/lib/client/use-live";
import { cn } from "@/lib/cn";
import { MediaViewer } from "@/components/mando/incident/MediaViewer";
import { findMediaByLabel, type MediaViewerTarget } from "@/components/mando/incident/types";
import { Scene3D, type SceneSelection } from "@/components/scene3d";
import { useToast } from "@/components/ui/Toast";
import { VigiaDock, useVigia } from "@/components/vigia";
import { agentMessages, buildFicha, type ChatMessage, type LngLat } from "./model";
import { placeUnitsOnRoute, useStreetRoute } from "./street-route";
import { FichaHealth } from "./health";
import { CriticalPanel, GLASS, MediaGridPanel, TopBar, VigiaPanel, useNow } from "./parts";
import type { MapView } from "./map/FichaMap";

const FichaMap = dynamic(() => import("./map/FichaMap"), { ssr: false });

export type FichaDemoState = "llegando" | "hablando" | null;

type Tab = MapView | "scheme" | "media";

const TABS: { key: Tab; label: string; icon: typeof Box }[] = [
  { key: "3d", label: "Mapa 3D", icon: Box },
  { key: "scheme", label: "Esquema", icon: Shapes },
  { key: "plan", label: "Planta", icon: MapIcon },
  { key: "media", label: "Medios", icon: Images },
];

/** Marcador de la ficha (P1, H2, F0, M1…) → entidad del esquema técnico, para resaltarla en los dos. */
function selectionFor(focus: string | null, scene: SceneModel | null): SceneSelection | null {
  if (!focus || !scene) return null;
  if (scene.people?.some((p) => p.id === focus)) return { kind: "person", id: focus };
  if (scene.hazards?.some((h) => h.id === focus)) return { kind: "hazard", id: focus };
  if (scene.vehicles?.some((v) => v.id === focus)) return { kind: "vehicle", id: focus };
  const fire = /^F(\d+)$/.exec(focus);
  if (fire) {
    const f = scene.fire_zones?.[Number(fire[1])];
    return f ? { kind: "fire", id: f.id } : null;
  }
  if (/^M\d+$/.test(focus)) return { kind: "camera", id: focus };
  return null;
}

/* Tamaño de ventana sin efectos: el layout cambia entre notebook y tablet horizontal. */
function subscribeResize(cb: () => void) {
  window.addEventListener("resize", cb);
  return () => window.removeEventListener("resize", cb);
}
const getWidth = () => window.innerWidth;
const getServerWidth = () => 1440;

const NO_ROUTE: LngLat[] = [];

function isUnauthorized(err: ApiClientError | null): boolean {
  return err !== null && (err.status === 401 || err.code === "unauthorized");
}
const GAP = 16;
const TOP = 16 + 56 + 12;

export function FichaView({ id, demoState = null }: { id: string; demoState?: FichaDemoState }) {
  const { snapshot, error, refresh, stale, lastUpdatedAt } = useIncidentSnapshot(id);
  const agent = useVigia(id);
  const now = useNow(2000);
  const toast = useToast();
  const router = useRouter();
  const pathname = usePathname();
  // Sesión vencida → iniciar sesión y volver a la ficha.
  const unauthorized = isUnauthorized(error);
  useEffect(() => {
    if (unauthorized) router.replace(`/login?next=${encodeURIComponent(pathname || `/mando/${id}`)}`);
  }, [unauthorized, router, pathname, id]);
  const width = useSyncExternalStore(subscribeResize, getWidth, getServerWidth);
  const compact = width < 1320;
  const panelL = compact ? 296 : 330;
  const panelR = compact ? 310 : 350;

  const [tab, setTab] = useState<Tab>("3d");
  const [picked, setPicked] = useState<string | null>(null);
  const [openCamera, setOpenCamera] = useState<string | null>(null);
  const [viewer, setViewer] = useState<MediaViewerTarget | null>(null);
  const [busy, setBusy] = useState(false);
  /** Selección propia del esquema (clic en una entidad); si no hay, sigue al foco de la ficha. */
  const [schemeSel, setSchemeSel] = useState<SceneSelection | null>(null);
  /** El estado forzado "hablando" dura hasta que el OBAC toca algo. */
  const [demoActive, setDemoActive] = useState(demoState === "hablando");

  const ficha = useMemo(() => (snapshot ? buildFicha(snapshot, { forceArriving: demoState === "llegando" }) : null), [snapshot, demoState]);
  // Historial del agente; sin mensajes del agente todavía, el resumen de radio y el informe.
  const agentChat = useMemo(
    () => agentMessages(agent.view?.utterances ?? [], snapshot?.incident.scene ?? null),
    [agent.view, snapshot],
  );
  const chat = useMemo(() => (agentChat.length ? agentChat : (ficha?.chat ?? [])), [agentChat, ficha]);
  const street = useStreetRoute(ficha?.map.route ?? NO_ROUTE);
  const mapModel = useMemo(
    () =>
      ficha
        ? {
            ...ficha.map,
            route: street.route,
            pins: ficha.arriving ? placeUnitsOnRoute(ficha.map.pins, street.route, street.durationS) : ficha.map.pins,
          }
        : null,
    [ficha, street.route, street.durationS],
  );

  // "Vigía hablando" forzado: la última burbuja de Vigía que nombra algo del mapa.
  const demoSpeakingId = useMemo(() => {
    if (!demoActive) return null;
    const withFocus = [...chat].reverse().find((m) => m.from === "vigia" && m.focus);
    return withFocus?.id ?? null;
  }, [demoActive, chat]);
  // El mensaje del agente de los últimos 20 s cuenta como "hablando" (su marcador pulsa).
  const latest = agentChat[agentChat.length - 1];
  const freshId = latest && now !== null && now - new Date(latest.at).getTime() < 20_000 ? latest.id : null;
  const speakingId = freshId ?? demoSpeakingId;
  const speakingMsg = speakingId ? chat.find((m) => m.id === speakingId) : null;
  const focus = speakingMsg?.focus ?? picked;

  // Lo elegido en una tarjeta pulsa unos segundos.
  useEffect(() => {
    if (!picked) return;
    const t = window.setTimeout(() => setPicked(null), 6000);
    return () => window.clearTimeout(t);
  }, [picked]);

  useEffect(() => {
    if (snapshot) document.title = `${snapshot.incident.code} · Ficha · Vigía`;
  }, [snapshot]);

  const onPick = useCallback((m: ChatMessage) => {
    setDemoActive(false);
    if (m.focus) setPicked(m.focus);
  }, []);

  const patch = useCallback(
    async (body: { status?: IncidentStatus; verified?: boolean }, failTitle: string) => {
      setBusy(true);
      try {
        await api.incidents.patch(id, body);
        refresh();
      } catch (err) {
        toast.toast({ tone: "critical", title: failTitle, description: errorMessage(err) });
      } finally {
        setBusy(false);
      }
    },
    [id, refresh, toast],
  );

  if (!snapshot || !ficha || !mapModel) {
    return (
      <div data-ficha className="fixed inset-0 grid place-items-center bg-f-wash">
        <p className="text-[17px] text-f-muted">{error ? errorMessage(error) : "Cargando la ficha…"}</p>
      </div>
    );
  }

  const gapLeft = GAP + panelL + GAP;
  const gapRight = GAP + panelR + GAP;
  const padding = { top: TOP + 52, right: gapRight, bottom: 110, left: gapLeft };
  const citizen = snapshot.media.filter((m) => m.source !== "drone");
  const incident = snapshot.incident;
  const openByLabel = (label: string, frame?: number) => {
    const m = findMediaByLabel(snapshot.media, label);
    if (m) setViewer({ mediaId: m.id, frame: frame ?? null });
  };
  // El esquema técnico ocupa el fondo; su barra y su HUD se ubican en el hueco entre paneles.
  const schemeSafeT = TOP + 52;
  const schemeSafeB = 100;
  const schemeVars = {
    "--scene-chrome-pos": "absolute",
    "--scene-chrome-radius": "12px",
    "--scene-chrome-shadow": "0 8px 24px rgb(33 32 28 / 0.12)",
    "--scene-safe-t": `${schemeSafeT}px`,
    "--scene-safe-l": `${gapLeft}px`,
    "--scene-safe-r": `${gapRight}px`,
    "--scene-safe-b": `${schemeSafeB}px`,
    "--scene-hud-t": `${schemeSafeT + 44}px`,
    "--scene-hud-l": `${gapLeft}px`,
    "--scene-hud-r": `${gapRight}px`,
    "--scene-hud-b": `${schemeSafeB + 26}px`,
  } as CSSProperties;

  return (
    <div data-ficha className="fixed inset-0 overflow-hidden bg-f-wash font-sans text-f-ink">
      <FichaMap
        model={mapModel}
        view={tab === "plan" ? "plan" : "3d"}
        focus={focus}
        padding={padding}
        media={citizen}
        openCamera={openCamera}
        onOpenCamera={(pinId) => {
          setDemoActive(false);
          setOpenCamera(pinId);
        }}
        onOpenMedia={(mediaId) => setViewer({ mediaId })}
        frameRoute={ficha.arriving}
      />

      {tab === "scheme" && (
        <div className="absolute inset-0 z-[5]" style={schemeVars}>
          <Scene3D
            scene={ficha.arriving ? null : incident.scene}
            incident={incident}
            media={snapshot.media}
            missions={snapshot.missions}
            engine={incident.scene_engine}
            updatedAt={incident.scene_updated_at}
            updating={incident.pipeline?.fusion_status === "running"}
            selection={schemeSel ?? selectionFor(focus, incident.scene)}
            onSelect={(sel) => {
              setDemoActive(false);
              setSchemeSel(sel);
            }}
            onOpenMedia={openByLabel}
            className="h-full w-full rounded-none border-0"
          />
        </div>
      )}

      <TopBar
        header={ficha.header}
        onStatus={(status) => void patch({ status }, "No se pudo cambiar el estado")}
        onVerify={() => void patch({ verified: true }, "No se pudo verificar el incidente")}
        technicalHref={`/mando/${encodeURIComponent(id)}/tecnica`}
        busy={busy}
        compact={compact}
        alerts={<FichaHealth stale={stale} lastUpdatedAt={lastUpdatedAt} vigia={agent.view} />}
      />

      {/* Pestañas del mapa, discretas, arriba a la izquierda del hueco */}
      <div role="tablist" aria-label="Vista del mapa" className={cn(GLASS, "absolute z-20 flex gap-0.5 rounded-xl p-1")} style={{ top: TOP, left: gapLeft }}>
        {TABS.map((t) => {
          const Icon = t.icon;
          const on = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => setTab(t.key)}
              className={cn(
                "inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[14px] font-semibold transition-colors",
                on ? "bg-f-wash text-f-ink" : "text-f-muted hover:text-f-ink",
              )}
            >
              <Icon className="size-4" aria-hidden="true" />
              {t.label}
              {t.key === "media" && citizen.length > 0 && <span className="text-f-faint">{citizen.length}</span>}
            </button>
          );
        })}
      </div>

      <CriticalPanel
        cards={ficha.cards}
        findings={ficha.findings}
        arriving={ficha.arriving}
        focus={focus}
        onFocus={(f) => {
          setDemoActive(false);
          setSchemeSel(null);
          setPicked(f);
        }}
        style={{ top: TOP, left: GAP, width: panelL, maxHeight: `calc(100% - ${TOP + GAP}px)` }}
      />

      <VigiaPanel
        chat={ficha.arriving ? agentChat : chat}
        speakingId={speakingId}
        timeline={ficha.timeline}
        arriving={ficha.arriving}
        onPick={onPick}
        style={{ top: TOP, right: GAP, bottom: GAP, width: panelR }}
      />

      {tab === "media" && (
        <MediaGridPanel media={citizen} onOpen={(mediaId) => setViewer({ mediaId })} style={{ top: TOP + 56, left: gapLeft, right: gapRight, bottom: 110 }} />
      )}

      {/* Vigía (agente): un mensaje a la vez, abajo al centro del hueco; su voz sale por Zello. */}
      <VigiaDock incidentId={id} className="absolute z-30" style={{ left: gapLeft, right: gapRight, bottom: 24 }} />

      <MediaViewer
        incidentId={id}
        media={snapshot.media}
        target={viewer}
        onClose={() => setViewer(null)}
        onChanged={refresh}
        mode={snapshot.mode}
        demo={snapshot.incident.origin === "demo"}
      />
    </div>
  );
}
