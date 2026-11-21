"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { ArrowLeft, CircleAlert, CircleCheck, LocateFixed, MapPinOff, Plus, RotateCw } from "lucide-react";
import { MediaUploader } from "@/components/report";
import { Button, Skeleton, Spinner } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { useGeolocation } from "@/lib/client/geo";
import type { PublicIncidentListResponse } from "@/lib/contract";
import type { IncidentType } from "@/lib/domain";
import { formatDistance } from "@/lib/format";
import { incidentTypeIcon } from "@/lib/labels";
import { CodeEntry } from "./CodeEntry";
import { NearbyIncidents } from "./NearbyIncidents";
import { PrivacyNote, RecordingTips } from "./RecordingTips";
import { TypePicker, reportTypeLabel } from "./TypePicker";

/** Sobre esta precisión (m) avisamos que la ubicación es aproximada. */
const ROUGH_ACCURACY_M = 200;

type NearbyKey = readonly ["public-nearby", number, number];

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

export interface ReportStartProps {
  /** ?code= que no tenía forma de código: se muestra en el campo con el error. */
  invalidCode?: string;
}

/** /reportar: ubicación → ¿es esta emergencia? → tipo → envío del video. */
export function ReportStart({ invalidCode }: ReportStartProps) {
  const { status: geoStatus, permission, request: requestLocation, position, error: geoError } = useGeolocation();

  const [skipLocation, setSkipLocation] = useState(false);
  const [wantsOther, setWantsOther] = useState(false);
  const [chosenType, setChosenType] = useState<IncidentType | null>(null);
  // Código con que quedó el primer envío: los siguientes ("Enviar otro video") van a la misma emergencia.
  const [submittedCode, setSubmittedCode] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // Si el permiso ya estaba dado no hace falta preguntar: se busca la ubicación al entrar.
  useEffect(() => {
    if (permission === "granted" && geoStatus === "idle") void requestLocation();
  }, [permission, geoStatus, requestLocation]);

  const nearbyKey: NearbyKey | null = position
    ? ["public-nearby", round4(position.lat), round4(position.lng)]
    : null;
  const nearby = useSWR<PublicIncidentListResponse, unknown, NearbyKey | null>(
    nearbyKey,
    ([, lat, lng]) => api.public.nearby(lat, lng),
    { revalidateOnFocus: false, shouldRetryOnError: false, keepPreviousData: true },
  );

  const pickType = (type: IncidentType) => {
    setChosenType(type);
    // La elección se hace abajo en la página; el paso siguiente empieza arriba.
    window.scrollTo({ top: 0 });
  };

  const restart = () => {
    setChosenType(null);
    setSubmittedCode(null);
    setDone(false);
    setWantsOther(false);
    window.scrollTo({ top: 0 });
  };

  const incidents = nearby.data?.incidents ?? [];
  const nearbyLoading = position !== null && nearby.data === undefined && !nearby.error;
  const hasLocationOutcome = geoStatus === "ready" || geoStatus === "error" || skipLocation;
  const showNearby = geoStatus === "ready" && incidents.length > 0 && !wantsOther;
  const showTypePicker = hasLocationOutcome && !nearbyLoading && !showNearby;

  if (chosenType) {
    const TypeIcon = incidentTypeIcon[chosenType];
    return (
      <div className="flex flex-col gap-5">
        <header className="flex flex-col gap-3">
          <h1 className="font-display text-3xl leading-none font-bold text-text">Envía tu video</h1>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-line bg-surface px-4 py-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent">
              <TypeIcon aria-hidden className="size-5" strokeWidth={2.25} />
            </span>
            <p className="min-w-0 flex-1 text-lg leading-tight font-semibold text-text">
              <span className="block text-sm font-normal text-muted">Qué está pasando</span>
              {reportTypeLabel(chosenType)}
            </p>
            {!submittedCode && (
              <Button variant="ghost" size="xl" onClick={() => setChosenType(null)} className="px-4">
                Cambiar
              </Button>
            )}
          </div>
        </header>
        <MediaUploader
          variant="vecino"
          typeHint={chosenType}
          incidentCode={submittedCode ?? undefined}
          onSubmitted={(r) => setSubmittedCode(r.incidentCode)}
          onDone={() => setDone(true)}
        />
        <RecordingTips />
        <PrivacyNote />
        {done && (
          <Button variant="ghost" size="xl" icon={ArrowLeft} fullWidth onClick={restart}>
            Volver al inicio
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-3xl leading-none font-bold text-text sm:text-4xl">
          Envía un video a Bomberos
        </h1>
        <p className="text-lg leading-snug text-muted">
          Tus imágenes ayudan a que Bomberos sepa con qué se va a encontrar antes de llegar.
        </p>
      </header>


      {/* Ubicación */}
      <section aria-labelledby="ubicacion-titulo" className="flex flex-col gap-3">
        <h2 id="ubicacion-titulo" className="sr-only">
          Tu ubicación
        </h2>
        {geoStatus === "idle" && !skipLocation && (
          <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
            <p className="text-lg leading-snug text-text">
              Necesitamos tu ubicación <strong className="font-semibold">para saber dónde es la emergencia</strong> y
              ver si Bomberos ya la tiene registrada.
            </p>
            <Button variant="primary" size="xl" icon={LocateFixed} fullWidth onClick={() => void requestLocation()}>
              Usar mi ubicación
            </Button>
            <Button variant="ghost" size="xl" fullWidth onClick={() => setSkipLocation(true)}>
              Seguir sin ubicación
            </Button>
          </div>
        )}

        {geoStatus === "locating" && (
          <div className="flex items-start gap-3 rounded-lg border border-line bg-surface p-4">
            <Spinner size="md" label="Buscando tu ubicación" className="mt-0.5" />
            <div className="min-w-0">
              <p className="text-lg leading-snug font-semibold text-text">Buscando tu ubicación…</p>
              <p className="mt-1 text-base leading-snug text-muted">Si el teléfono te pregunta, toca «Permitir».</p>
            </div>
          </div>
        )}

        {geoStatus === "error" && geoError && (
          <div className="flex flex-col gap-3 rounded-lg border border-warning/50 bg-warning-soft p-4">
            <div className="flex items-start gap-3">
              <MapPinOff aria-hidden className="mt-0.5 size-6 shrink-0 text-warning" />
              <div className="min-w-0">
                <p className="text-lg leading-snug font-semibold text-text">No tenemos tu ubicación</p>
                <p className="mt-1 text-base leading-snug text-text">{geoError.message}</p>
                <p className="mt-2 text-base leading-snug text-text">
                  Igual puedes enviar tu video: escribe el código de la emergencia si lo tienes, o elige qué está
                  pasando.
                </p>
              </div>
            </div>
            {geoError.code !== "unsupported" && geoError.code !== "insecure" && (
              <Button variant="secondary" size="xl" icon={RotateCw} fullWidth onClick={() => void requestLocation()}>
                Intentar de nuevo
              </Button>
            )}
          </div>
        )}

        {geoStatus === "ready" && position && (
          <p role="status" className="flex items-start gap-2.5 text-base leading-snug text-text">
            <CircleCheck aria-hidden className="mt-0.5 size-5 shrink-0 text-ok" />
            <span className="min-w-0">
              {position.accuracy_m > ROUGH_ACCURACY_M ? "Ubicación aproximada" : "Ubicación encontrada"}{" "}
              <span className="text-muted tabular">(± {formatDistance(position.accuracy_m)})</span>
            </span>
          </p>
        )}
      </section>

      {/* Emergencias cercanas */}
      {nearbyLoading && (
        <div aria-busy="true" className="flex flex-col gap-2.5">
          <p className="text-base text-muted" role="status">
            Revisando emergencias cerca de ti…
          </p>
          <Skeleton className="h-20 w-full rounded-lg" />
          <Skeleton className="h-20 w-full rounded-lg" />
        </div>
      )}

      {nearby.error !== undefined && position !== null && (
        <div role="alert" className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
          <p className="flex items-start gap-2.5 text-base leading-snug text-text">
            <CircleAlert aria-hidden className="mt-0.5 size-5 shrink-0 text-critical" />
            <span className="min-w-0">
              No pudimos revisar las emergencias cercanas. {errorMessage(nearby.error)} Igual puedes enviar tu video.
            </span>
          </p>
          <Button
            variant="secondary"
            size="xl"
            icon={RotateCw}
            fullWidth
            loading={nearby.isValidating}
            onClick={() => void nearby.mutate()}
          >
            Reintentar
          </Button>
        </div>
      )}

      {showNearby && (
        <section aria-labelledby="cercanas-titulo" className="flex flex-col gap-3">
          <div>
            <h2 id="cercanas-titulo" className="font-display text-2xl leading-tight font-bold text-text">
              ¿Es esta emergencia?
            </h2>
            <p className="mt-1 text-base leading-snug text-muted">
              Bomberos ya tiene {incidents.length === 1 ? "esta emergencia registrada" : "estas emergencias registradas"}{" "}
              cerca de ti. Si es la misma, tócala para enviar tu video.
            </p>
          </div>
          <NearbyIncidents incidents={incidents} labelledBy="cercanas-titulo" />
          <Button variant="secondary" size="xl" icon={Plus} fullWidth onClick={() => setWantsOther(true)}>
            Es otra emergencia
          </Button>
        </section>
      )}

      {showTypePicker && (
        <section aria-labelledby="tipo-titulo" className="flex flex-col gap-3">
          <div>
            <h2 id="tipo-titulo" className="font-display text-2xl leading-tight font-bold text-text">
              ¿Qué está pasando?
            </h2>
            {geoStatus === "ready" && incidents.length === 0 && !nearby.error && (
              <p className="mt-1 text-base leading-snug text-muted">
                No vemos emergencias registradas cerca de ti. Elige la que se parezca más.
              </p>
            )}
            {wantsOther && incidents.length > 0 && (
              <button
                type="button"
                onClick={() => setWantsOther(false)}
                className="mt-1 inline-flex min-h-11 items-center gap-1.5 text-base font-semibold text-accent underline underline-offset-4"
              >
                <ArrowLeft aria-hidden className="size-4" />
                Ver las emergencias cercanas
              </button>
            )}
          </div>
          <TypePicker labelledBy="tipo-titulo" onPick={pickType} />
        </section>
      )}

      <CodeEntry initialValue={invalidCode} initialInvalid={invalidCode !== undefined} />

      <RecordingTips />
      <PrivacyNote />
    </div>
  );
}
