"use client";

import { useCallback, useState, type CSSProperties, type ReactNode } from "react";
import { FlaskConical, Info, Link2Off, RotateCw, SearchX, WifiOff, type LucideIcon } from "lucide-react";
import type { BriefingSnapshot } from "@/lib/contract";
import type { EvidenceRef } from "@/lib/domain";
import { Spinner, useNow } from "@/components/ui";
import { errorMessage } from "@/lib/client/api";
import { useBriefing } from "@/lib/client/use-live";
import { isSimulated } from "./briefing-diff";
import { useBriefingUpdates, useBriefingVoice, useWakeLock } from "./hooks";
import { BriefingTopBar } from "./BriefingTopBar";
import { AccessSection, HazardsSection, SummarySection, UnknownsSection, VoiceControls } from "./BriefingSections";
import { KeyFrameViewer, KeyFramesSection } from "./KeyFrames";
import { MapSection, SceneSection } from "./PlaceSection";
import { TrappedPanel, TrappedPending } from "./TrappedPanel";
import { UpdateBanner } from "./UpdateBanner";

/** Alto contraste para leer a un metro en movimiento: texto secundario y líneas más claros que en el mando. */
const HIGH_CONTRAST = {
  "--v-muted": "#c3cfdb",
  "--v-line": "#2d3f53",
  "--v-line-strong": "#4a6079",
} as CSSProperties;

const STALE_AFTER_MS = 20_000;

export interface EnRutaViewProps {
  id: string;
  /** Clave de solo lectura del enlace (?k=); null si falta. */
  shareKey: string | null;
}

/** Tablet del carro bomba: briefing en ruta con sondeo, voz, aviso de cambios y pantalla encendida. */
export function EnRutaView({ id, shareKey }: EnRutaViewProps) {
  const { briefing, error, refresh, lastUpdatedAt, stale } = useBriefing(id, shareKey, { staleAfterMs: STALE_AFTER_MS });
  const status = error?.status ?? 0;

  if (status === 400 || status === 401 || status === 403) {
    return (
      <Problem icon={Link2Off} title="Enlace inválido o vencido">
        Pide uno nuevo al puesto de mando.
      </Problem>
    );
  }
  if (status === 404) {
    // El servidor responde 404 tanto si la emergencia no existe como si la clave no calza (no revela cuál).
    return (
      <Problem icon={SearchX} title="Emergencia no encontrada">
        No encontramos esta emergencia con este enlace: puede estar mal copiado o vencido. Pide uno nuevo al puesto de
        mando.
      </Problem>
    );
  }
  if (!briefing) {
    if (error) {
      return (
        <Problem
          icon={WifiOff}
          title="No pudimos cargar el briefing"
          action={
            <button
              type="button"
              onClick={() => void refresh()}
              className="mt-6 inline-flex min-h-14 items-center gap-2.5 rounded-md bg-accent px-6 text-lg font-bold text-on-solid"
            >
              <RotateCw aria-hidden className="size-5" />
              Reintentar
            </button>
          }
        >
          {errorMessage(error)} Seguimos intentando automáticamente.
        </Problem>
      );
    }
    return (
      <Screen>
        <div role="status" className="flex min-h-dvh flex-col items-center justify-center gap-4 px-6 text-center">
          <Spinner size="lg" label="Cargando briefing" />
          <p className="font-display text-3xl font-bold tracking-wide text-text">Cargando briefing…</p>
        </div>
      </Screen>
    );
  }

  return <BriefingScreen briefing={briefing} stale={stale} lastUpdatedAt={lastUpdatedAt} />;
}

function BriefingScreen({
  briefing,
  stale,
  lastUpdatedAt,
}: {
  briefing: BriefingSnapshot;
  stale: boolean;
  lastUpdatedAt: number | null;
}) {
  const now = useNow(1000);
  const wakeLock = useWakeLock();
  const updates = useBriefingUpdates(briefing);
  const voice = useBriefingVoice(briefing);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

  const { incident, situation, key_frames: keyFrames } = briefing;
  const simulated = isSimulated(briefing);

  const findFrame = useCallback(
    (e: EvidenceRef) => keyFrames.findIndex((k) => k.media_label === e.ref && k.frame === e.frame),
    [keyFrames],
  );

  return (
    <Screen>
      <BriefingTopBar
        incident={incident}
        simulated={simulated}
        stale={stale}
        lastUpdatedAt={lastUpdatedAt}
        now={now}
        wakeLock={wakeLock}
      >
        <UpdateBanner changes={updates.pending} seq={updates.seq} onDismiss={updates.dismiss} />
      </BriefingTopBar>

      <main className="mx-auto max-w-[1400px] px-4 pt-4 pb-32 lg:px-6">
        {simulated && (
          <p
            role="note"
            className="mb-4 flex items-start gap-3 rounded-lg border-2 border-warning bg-warning-soft p-3 text-lg leading-snug text-text"
          >
            <FlaskConical aria-hidden className="mt-0.5 size-6 shrink-0 text-warning" />
            <span className="min-w-0">
              <strong className="font-bold text-warning">SIMULADO.</strong> Este briefing es de demostración: no proviene
              de videos reales. No lo uses para decidir.
            </span>
          </p>
        )}

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:items-start lg:gap-5">
          <div className="flex min-w-0 flex-col gap-4 lg:gap-5">
            {situation ? (
              <>
                <TrappedPanel
                  situation={situation}
                  canOpenEvidence={(e) => findFrame(e) >= 0}
                  onOpenEvidence={(e) => {
                    const i = findFrame(e);
                    if (i >= 0) setViewerIndex(i);
                  }}
                />
                <SummarySection
                  situation={situation}
                  engine={incident.situation_engine}
                  updatedAt={incident.situation_updated_at}
                  now={now}
                  voice={voice}
                />
                <HazardsSection hazards={situation.hazards} />
                <AccessSection access={situation.access} />
                <UnknownsSection unknowns={situation.unknowns} contradictions={situation.contradictions} />
              </>
            ) : (
              <>
                <TrappedPending mediaCount={briefing.media_count} />
                {voice.supported && (
                  <div className="rounded-lg border border-line bg-surface p-4">
                    <p className="text-lg leading-snug text-text">
                      Activa la lectura automática para escuchar el análisis apenas llegue.
                    </p>
                    <VoiceControls voice={voice} className="mt-3" />
                  </div>
                )}
              </>
            )}
          </div>

          <div className="flex min-w-0 flex-col gap-4 lg:gap-5">
            {(situation || keyFrames.length > 0) && (
              <KeyFramesSection frames={keyFrames} mediaCount={briefing.media_count} onOpen={setViewerIndex} />
            )}
            {briefing.scene && <SceneSection briefing={briefing} />}
            <MapSection incident={incident} />
          </div>
        </div>
      </main>

      <footer className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-bg/95 pb-[env(safe-area-inset-bottom)] backdrop-blur supports-[backdrop-filter]:bg-bg/85">
        <p className="mx-auto flex max-w-[1400px] items-start gap-2 px-4 py-2.5 text-base leading-snug text-text lg:px-6">
          <Info aria-hidden className="mt-0.5 size-5 shrink-0 text-info" />
          <span className="min-w-0">
            Información generada por IA a partir de videos y radio; puede contener errores. Confirma al llegar.
          </span>
        </p>
      </footer>

      <KeyFrameViewer
        frames={keyFrames}
        index={viewerIndex}
        onChange={setViewerIndex}
        onClose={() => setViewerIndex(null)}
      />
    </Screen>
  );
}

function Screen({ children }: { children: ReactNode }) {
  return (
    <div data-theme="mando" style={HIGH_CONTRAST} className="min-h-dvh bg-bg font-sans text-text">
      {children}
    </div>
  );
}

function Problem({
  icon: Icon,
  title,
  action,
  children,
}: {
  icon: LucideIcon;
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Screen>
      <div role="alert" className="mx-auto flex min-h-dvh max-w-xl flex-col items-center justify-center px-6 text-center">
        <Icon aria-hidden className="size-16 text-warning" strokeWidth={2} />
        <h1 className="mt-4 font-display text-4xl leading-tight font-bold tracking-wide text-text">{title}</h1>
        <p className="mt-3 text-xl leading-snug text-muted">{children}</p>
        {action}
      </div>
    </Screen>
  );
}
