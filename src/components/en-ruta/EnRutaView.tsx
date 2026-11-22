"use client";

import { useCallback, useState, type CSSProperties, type ReactNode } from "react";
import { Info, Link2Off, RotateCw, SearchX, WifiOff, type LucideIcon } from "lucide-react";
import type { BriefingSnapshot } from "@/lib/contract";
import type { EvidenceRef } from "@/lib/domain";
import { Spinner, useNow } from "@/components/ui";
import { errorMessage } from "@/lib/client/api";
import { useBriefing } from "@/lib/client/use-live";
import { useBriefingUpdates, useBriefingVoice, useWakeLock } from "./hooks";
import { BriefingTopBar } from "./BriefingTopBar";
import { AccessSection, HazardsSection, SummarySection, UnknownsSection, VoiceControls } from "./BriefingSections";
import { KeyFrameViewer, KeyFramesSection } from "./KeyFrames";
import { MapSection, SceneSection } from "./PlaceSection";
import { TrappedPanel, TrappedPending } from "./TrappedPanel";
import { UpdateBanner } from "./UpdateBanner";
import { VigiaSection, useBriefingVigia, useNewVigia } from "./VigiaSection";

/** Alto contraste para leer a un metro en movimiento: texto secundario y líneas más oscuros que en el mando. */
const HIGH_CONTRAST = {
  "--v-muted": "#3f4754",
  "--v-line": "#d3d7de",
  "--v-line-strong": "#a9b0bb",
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
          <p className="font-display text-3xl font-bold text-text">Cargando briefing…</p>
        </div>
      </Screen>
    );
  }

  return <BriefingScreen briefing={briefing} shareKey={shareKey} stale={stale} lastUpdatedAt={lastUpdatedAt} />;
}

/**
 * Orden pensado para un vistazo de 5 segundos en el carro: personas atrapadas, peligros y lo
 * último de Vigía en la primera pantalla (en horizontal, peligros y Vigía arriba a la derecha).
 * Los controles de voz quedan fijos abajo.
 */
function BriefingScreen({
  briefing,
  shareKey,
  stale,
  lastUpdatedAt,
}: {
  briefing: BriefingSnapshot;
  shareKey: string | null;
  stale: boolean;
  lastUpdatedAt: number | null;
}) {
  const now = useNow(1000);
  const wakeLock = useWakeLock();
  const updates = useBriefingUpdates(briefing);
  const voice = useBriefingVoice(briefing, updates);
  const vigia = useBriefingVigia(briefing.incident.id, shareKey);
  const newVigia = useNewVigia(vigia);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

  const { incident, situation, key_frames: keyFrames } = briefing;

  const findFrame = useCallback(
    (e: EvidenceRef) => keyFrames.findIndex((k) => k.media_label === e.ref && k.frame === e.frame),
    [keyFrames],
  );

  return (
    <Screen>
      <BriefingTopBar
        incident={incident}
        stale={stale}
        lastUpdatedAt={lastUpdatedAt}
        now={now}
        wakeLock={wakeLock}
      >
        <UpdateBanner
          changes={[...newVigia.fresh.map((m) => ({ text: `Vigía: ${m.text}` })), ...updates.pending]}
          seq={updates.seq + newVigia.fresh.length * 1000}
          onDismiss={() => {
            updates.dismiss();
            newVigia.dismiss();
          }}
        />
      </BriefingTopBar>

      <main className="mx-auto max-w-[1400px] px-4 pt-4 pb-60 lg:px-6">
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
                {/* Una columna (vertical): peligros y Vigía justo bajo atrapados. */}
                <div className="flex flex-col gap-4 lg:hidden">
                  <HazardsSection hazards={situation.hazards} />
                  <VigiaSection id="vigia" messages={vigia} now={now} />
                </div>
                <SummarySection
                  situation={situation}
                  engine={incident.situation_engine}
                  updatedAt={incident.situation_updated_at}
                  now={now}
                />
                <AccessSection access={situation.access} />
                <UnknownsSection unknowns={situation.unknowns} contradictions={situation.contradictions} />
              </>
            ) : (
              <>
                <TrappedPending mediaCount={briefing.media_count} />
                <div className="lg:hidden">
                  <VigiaSection id="vigia" messages={vigia} now={now} />
                </div>
                {voice.supported && (
                  <p className="rounded-lg border border-line bg-surface p-4 text-lg leading-snug text-text">
                    Activa abajo «Leer cada actualización» para escuchar el análisis apenas llegue.
                  </p>
                )}
              </>
            )}
          </div>

          <div className="flex min-w-0 flex-col gap-4 lg:gap-5">
            {/* Dos columnas (horizontal): peligros y Vigía arriba a la derecha, en la primera pantalla. */}
            <div className="hidden flex-col gap-5 lg:flex">
              {situation && <HazardsSection id="peligros-lado" hazards={situation.hazards} />}
              <VigiaSection id="vigia-lado" messages={vigia} now={now} />
            </div>
            {(situation || keyFrames.length > 0) && (
              <KeyFramesSection frames={keyFrames} mediaCount={briefing.media_count} onOpen={setViewerIndex} />
            )}
            {briefing.scene && <SceneSection briefing={briefing} />}
            <MapSection incident={incident} />
          </div>
        </div>
      </main>

      <footer className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-bg/95 pb-[env(safe-area-inset-bottom)] backdrop-blur supports-[backdrop-filter]:bg-bg/85">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5 lg:px-6">
          <VoiceControls voice={voice} />
          <p className="flex min-w-[16rem] flex-1 items-start gap-2 text-base leading-snug text-text">
            <Info aria-hidden className="mt-0.5 size-5 shrink-0 text-info" />
            <span className="min-w-0">
              Información generada por IA a partir de videos y radio; puede contener errores. Confirma al llegar.
            </span>
          </p>
        </div>
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
        <h1 className="mt-4 font-display text-4xl leading-tight font-bold text-text">{title}</h1>
        <p className="mt-3 text-xl leading-snug text-muted">{children}</p>
        {action}
      </div>
    </Screen>
  );
}
