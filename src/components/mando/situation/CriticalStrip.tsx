"use client";
/**
 * Franja crítica: responde "¿hay personas atrapadas?" en un segundo y a 2 m de distancia.
 * Nunca muestra un estado que el informe no trae: sin informe, lo dice.
 */
import { useId, useState } from "react";
import {
  CircleHelp,
  Hourglass,
  MapPin,
  ScanEye,
  ShieldCheck,
  Siren,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { Badge, ConfidenceMeter, Spinner } from "@/components/ui";
import { toneBorder, toneSoftBg, toneSolidBg, toneText, type Tone } from "@/components/ui/tone";
import { SimulatedNotice } from "@/components/shell/SimulatedNotice";
import type { SituationReport, TrappedStatus } from "@/lib/domain";
import {
  incidentTypeIcon,
  incidentTypeLabel,
  labelOr,
  likelihoodLabel,
  likelihoodTone,
  severityLabel,
  severityTone,
} from "@/lib/labels";
import { cn } from "@/lib/cn";
import type { CriticalStripProps } from "./types";
import { EvidenceChips, PipelineStatusLine, UpdatedAgo } from "./parts";
import { divergentType, noSituationMessage, TRAPPED_DISPLAY, trappedCountText } from "./model";

/** Tono de la franja; sin evidencia queda neutra (nunca verde ni "segura"). */
const stripTone: Record<TrappedStatus, Tone> = {
  confirmed: "critical",
  probable: "critical",
  possible: "warning",
  no_evidence: "neutral",
  cleared_by_unit: "ok",
};

const stripIcon: Record<TrappedStatus, LucideIcon> = {
  confirmed: Siren,
  probable: Siren,
  possible: TriangleAlert,
  no_evidence: CircleHelp,
  cleared_by_unit: ShieldCheck,
};

/** Más de esto y el fundamento se pliega a una línea. */
const BASIS_FOLD_CHARS = 90;

export function CriticalStrip({ incident, mediaCount, onEvidence, mode, className }: CriticalStripProps) {
  const situation = incident.situation;
  if (!situation) {
    return <EmptyStrip incident={incident} mediaCount={mediaCount} className={className} />;
  }
  return <ReportStrip incident={incident} situation={situation} onEvidence={onEvidence} mode={mode} className={className} />;
}

/* ─────────────────────────── Sin informe ─────────────────────────── */

function EmptyStrip({ incident, mediaCount, className }: Pick<CriticalStripProps, "incident" | "mediaCount" | "className">) {
  const failed = incident.pipeline.fusion_status === "error";
  const working = !failed && mediaCount > 0;
  return (
    <section
      aria-label="Personas atrapadas"
      data-trapped="none"
      className={cn("rounded-lg border border-line bg-surface", className)}
    >
      <div className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:gap-4">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span className="flex size-12 shrink-0 items-center justify-center rounded-md border border-line bg-surface-2 text-muted">
            {working ? <Spinner size="md" label="Analizando" /> : <Hourglass aria-hidden="true" className="size-6" />}
          </span>
          <div className="min-w-0">
            <p className="label-caps text-xs text-muted">Personas atrapadas · sin informe aún</p>
            <p aria-live="polite" className="font-display text-2xl font-semibold leading-tight text-text sm:text-3xl">
              {failed ? "No hay informe de situación" : noSituationMessage(mediaCount)}
            </p>
            <p className="text-sm text-muted">Mientras no haya análisis no se descartan víctimas.</p>
          </div>
        </div>
        <PipelineStatusLine pipeline={incident.pipeline} className="sm:max-w-[45%]" />
      </div>
    </section>
  );
}

/* ─────────────────────────── Con informe ─────────────────────────── */

interface ReportStripProps {
  incident: CriticalStripProps["incident"];
  situation: SituationReport;
  onEvidence: CriticalStripProps["onEvidence"];
  mode: CriticalStripProps["mode"];
  className?: string;
}

function ReportStrip({ incident, situation, onEvidence, mode, className }: ReportStripProps) {
  const { trapped } = situation;
  const status = trapped.status;
  const tone = stripTone[status] ?? "neutral";
  const Icon = stripIcon[status] ?? CircleHelp;
  const display = TRAPPED_DISPLAY[status] ?? TRAPPED_DISPLAY.no_evidence;
  const alarm = status === "confirmed" || status === "probable";
  const count = trappedCountText(trapped);
  const locations = trapped.locations.map((l) => l.trim()).filter(Boolean);
  const seenType = divergentType(incident, situation);
  const SeenIcon = seenType ? incidentTypeIcon[seenType] : ScanEye;
  const simulated = incident.situation_engine === "simulated";

  return (
    <section
      aria-label="Personas atrapadas y estado del incidente"
      data-trapped={status}
      className={cn(
        "rounded-lg border",
        tone === "neutral" ? "border-line-strong bg-surface" : cn(toneSoftBg[tone], toneBorder[tone]),
        className,
      )}
    >
      <div className="flex flex-col gap-2 p-3 lg:flex-row lg:gap-4">
        {/* Izquierda: atrapados */}
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex min-w-0 items-start gap-3">
            <span
              className={cn(
                "flex size-12 shrink-0 items-center justify-center rounded-md",
                tone === "neutral" ? "border border-line bg-surface-2 text-muted" : cn(toneSolidBg[tone], "text-on-solid"),
                alarm && "animate-pulse-critical",
              )}
            >
              <Icon aria-hidden="true" className="size-7" />
            </span>
            <div className="min-w-0">
              <p className="label-caps text-xs text-muted">Personas atrapadas</p>
              <p
                aria-live="polite"
                className={cn(
                  "font-display text-3xl leading-none font-bold xl:text-4xl",
                  tone === "neutral" ? "text-text" : toneText[tone],
                )}
              >
                {display.primary}
                {display.qualifier ? " " : null}
                {display.qualifier ? (
                  <span className="ml-2 align-middle text-lg font-semibold tracking-normal text-text xl:text-xl">
                    — {display.qualifier}
                  </span>
                ) : null}
              </p>
              {count || locations.length > 0 ? (
                <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-base font-semibold text-text">
                  {count ? <span className="tabular">{count}</span> : null}
                  {locations.length > 0 ? (
                    <span className="inline-flex min-w-0 items-center gap-1 font-medium">
                      <MapPin aria-hidden="true" className="size-4 shrink-0 text-muted" />
                      <span className="line-clamp-2 min-w-0">{locations.join(" · ")}</span>
                    </span>
                  ) : null}
                </p>
              ) : null}
            </div>
          </div>
          <Basis text={trapped.basis} />
          <EvidenceChips
            refs={trapped.evidence}
            onEvidence={onEvidence}
            size="md"
            label="Evidencia sobre personas atrapadas"
          />
        </div>

        {/* Derecha: gravedad, lesionados, titular y estado del análisis */}
        <div className="flex min-w-0 flex-col gap-2 border-line lg:w-[42%] lg:max-w-xl lg:border-l lg:pl-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge size="lg" tone={severityTone[situation.severity] ?? "neutral"} variant="solid">
              Gravedad {labelOr(severityLabel, situation.severity)}
            </Badge>
            <Badge size="md" tone={likelihoodTone[situation.injured.status] ?? "neutral"}>
              Lesionados: {labelOr(likelihoodLabel, situation.injured.status)}
              {situation.injured.count_estimate > 0 ? ` · ~${Math.round(situation.injured.count_estimate)}` : ""}
            </Badge>
          </div>
          {situation.headline.trim() ? (
            <p className="text-base leading-snug font-semibold text-text xl:text-lg">{situation.headline}</p>
          ) : null}
          {seenType ? (
            <p className="inline-flex items-center gap-1.5 text-sm text-warning">
              <SeenIcon aria-hidden="true" className="size-4 shrink-0" />
              <span>
                La IA ve: <strong className="font-semibold">{incidentTypeLabel[seenType].toLowerCase()}</strong>
                <span className="text-muted"> (registrado como {labelOr(incidentTypeLabel, incident.type).toLowerCase()})</span>
              </span>
            </p>
          ) : null}
          <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <ConfidenceMeter level={situation.overall_confidence} size="sm" />
            <UpdatedAgo iso={incident.situation_updated_at} />
            <PipelineStatusLine pipeline={incident.pipeline} />
          </div>
          {simulated ? (
            <SimulatedNotice compact what="Este informe" mode={mode} demo={incident.origin === "demo"} />
          ) : null}
        </div>
      </div>
    </section>
  );
}

/** Fundamento del estado en una línea, expandible. */
function Basis({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const basis = text.trim();
  if (!basis) return null;
  const foldable = basis.length > BASIS_FOLD_CHARS;
  return (
    <div className="flex min-w-0 items-start gap-2 text-sm">
      <p id={id} className={cn("min-w-0 flex-1 text-muted", foldable && !open && "truncate")}>
        <span className="font-semibold text-text">Fundamento:</span> {basis}
      </p>
      {foldable ? (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((v) => !v)}
          className="shrink-0 rounded px-1 font-semibold text-accent hover:underline"
        >
          {open ? "Ver menos" : "Ver más"}
        </button>
      ) : null}
    </div>
  );
}
