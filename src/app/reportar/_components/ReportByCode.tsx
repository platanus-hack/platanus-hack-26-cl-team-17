"use client";

import type { ReactNode } from "react";
import useSWR from "swr";
import { ArrowLeft, Ban, CircleAlert, MapPin, RotateCw, SearchX, WifiOff, type LucideIcon } from "lucide-react";
import { MediaUploader } from "@/components/report";
import { VideoRequestBanner } from "@/components/vigia/VideoRequestBanner";
import { Button, Skeleton, TimeAgo } from "@/components/ui";
import { ApiClientError, api, errorMessage } from "@/lib/client/api";
import type { PublicIncident } from "@/lib/contract";
import { incidentTypeIcon } from "@/lib/labels";
import { cn } from "@/lib/cn";
import { CodeEntry } from "./CodeEntry";
import { PrivacyNote, RecordingTips } from "./RecordingTips";
import { reportTypeLabel } from "./TypePicker";

export interface ReportByCodeProps {
  /** Código ya normalizado ("VG-7K3Q"), o null si lo que venía en la URL no tenía forma de código. */
  code: string | null;
  /** Lo que venía en la URL, para mostrarlo cuando no sirve. */
  rawCode: string;
}

type IncidentKey = readonly ["public-incident", string];

/** /reportar/[code]: valida el código y muestra el cargador adjunto a esa emergencia. */
export function ReportByCode({ code, rawCode }: ReportByCodeProps) {
  const key: IncidentKey | null = code ? ["public-incident", code] : null;
  const { data, error, isLoading, isValidating, mutate } = useSWR<
    { incident: PublicIncident },
    unknown,
    IncidentKey | null
  >(key, ([, c]) => api.public.byCode(c), {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    shouldRetryOnError: false,
  });

  if (!code) return <NotFound shownCode={rawCode} />;

  if (isLoading || (error !== undefined && isValidating && !data)) return <LoadingState code={code} />;

  if (error !== undefined && !data) {
    const status = error instanceof ApiClientError ? error.status : 0;
    if (status === 404) return <NotFound shownCode={code} />;
    if (status === 409) return <Closed code={code} />;
    const offline = error instanceof ApiClientError && error.code === "network";
    return <LoadError message={errorMessage(error)} offline={offline} retry={() => void mutate()} />;
  }

  if (!data) return <LoadingState code={code} />;

  return <Ready incident={data.incident} />;
}

function Ready({ incident }: { incident: PublicIncident }) {
  const Icon = incidentTypeIcon[incident.type];
  const address = incident.address.trim();
  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
        <p className="label-caps text-sm text-muted">
          Emergencia <span className="font-mono tracking-wider text-text">{incident.code}</span>
        </p>
        <div className="flex items-start gap-3.5">
          <span className="flex size-12 shrink-0 items-center justify-center rounded-md bg-critical-soft text-critical">
            <Icon aria-hidden className="size-7" strokeWidth={2.25} />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="font-display text-2xl leading-tight font-bold break-words text-text">
              {incident.title || reportTypeLabel(incident.type)}
            </h1>
            <p className="mt-0.5 text-base text-muted">{reportTypeLabel(incident.type)}</p>
          </div>
        </div>
        <p className="flex items-start gap-2 text-lg leading-snug text-text">
          <MapPin aria-hidden className="mt-1 size-5 shrink-0 text-muted" />
          <span className="min-w-0 break-words">{address || "Dirección por confirmar"}</span>
        </p>
        <p className="text-sm text-muted">
          Avisada <TimeAgo iso={incident.created_at} />
        </p>
      </header>
      <VideoRequestBanner code={incident.code} />
      {/* El botón de grabar va arriba: en un iPhone tiene que verse sin desplazarse ("dos toques y está grabando"). */}
      <MediaUploader variant="vecino" incidentCode={incident.code} />
      <RecordingTips />
      <PrivacyNote />
      <Button href="/reportar" variant="ghost" size="xl" icon={ArrowLeft} fullWidth>
        No es esta emergencia
      </Button>
    </div>
  );
}

function LoadingState({ code }: { code: string }) {
  return (
    <div className="flex flex-col gap-5" aria-busy="true">
      <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
        <p role="status" className="label-caps text-sm text-muted">
          Buscando la emergencia <span className="font-mono tracking-wider text-text">{code}</span>…
        </p>
        <div className="flex items-start gap-3.5">
          <Skeleton className="size-12 shrink-0 rounded-md" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton className="h-7 w-4/5" />
            <Skeleton className="h-4 w-2/5" />
          </div>
        </div>
        <Skeleton className="h-5 w-full" />
      </div>
      <Skeleton className="h-36 w-full rounded-lg" />
      <Skeleton className="h-14 w-full rounded-md" />
    </div>
  );
}

/** Estado de problema: icono + título (h1) + explicación + acciones. */
function Problem({
  icon: Icon,
  tone,
  title,
  children,
  actions,
}: {
  icon: LucideIcon;
  tone: "critical" | "warning" | "neutral";
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-5">
      <div
        role="alert"
        className={cn(
          "flex flex-col gap-3 rounded-lg border p-4",
          tone === "critical" && "border-critical/40 bg-surface",
          tone === "warning" && "border-warning/50 bg-warning-soft",
          tone === "neutral" && "border-line bg-surface",
        )}
      >
        <div className="flex items-start gap-3">
          <Icon
            aria-hidden
            className={cn(
              "mt-0.5 size-7 shrink-0",
              tone === "critical" && "text-critical",
              tone === "warning" && "text-warning",
              tone === "neutral" && "text-muted",
            )}
          />
          <div className="min-w-0">
            <h1 className="font-display text-2xl leading-tight font-bold text-text">{title}</h1>
            {children && <div className="mt-1.5 text-base leading-snug text-text">{children}</div>}
          </div>
        </div>
        {actions}
      </div>
    </div>
  );
}

function NotFound({ shownCode }: { shownCode: string }) {
  return (
    <div className="flex flex-col gap-5">
      <Problem icon={SearchX} tone="warning" title="No encontramos esa emergencia. Revisa el código.">
        {shownCode && (
          <p>
            Buscamos <span className="font-mono font-semibold tracking-wider break-all">{shownCode}</span>. Fíjate en
            letras parecidas, como la B y el 8, o la S y el 5.
          </p>
        )}
      </Problem>
      <CodeEntry label="Escribe el código otra vez" />
      <Button href="/reportar" variant="secondary" size="xl" icon={ArrowLeft} fullWidth>
        Enviar sin código
      </Button>
    </div>
  );
}

function Closed({ code }: { code: string }) {
  return (
    <Problem
      icon={Ban}
      tone="neutral"
      title="Esta emergencia ya fue cerrada"
      actions={
        <Button href="/reportar" variant="primary" size="xl" fullWidth>
          Avisar de otra emergencia
        </Button>
      }
    >
      <p>
        Bomberos ya cerró la emergencia <span className="font-mono font-semibold tracking-wider">{code}</span> y no
        recibe más videos.
      </p>
    </Problem>
  );
}

function LoadError({ message, offline, retry }: { message: string; offline: boolean; retry: () => void }) {
  return (
    <Problem
      icon={offline ? WifiOff : CircleAlert}
      tone="critical"
      title="No pudimos abrir la emergencia"
      actions={
        <Button variant="primary" size="xl" icon={RotateCw} fullWidth onClick={retry}>
          Reintentar
        </Button>
      }
    >
      <p>{message}</p>
    </Problem>
  );
}
