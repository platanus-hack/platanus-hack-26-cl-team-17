"use client";
/**
 * Franja crítica: responde "¿hay personas atrapadas?" en un segundo y a 2 m de distancia.
 * Nunca muestra un estado que el informe no trae: sin informe, lo dice.
 */
import { useId, useState } from "react";
import {
  ChevronDown,
  CircleHelp,
  Hourglass,
  MapPin,
  ScanEye,
  ShieldCheck,
  Siren,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { Badge, ConfidenceMeter, Spinner, TimeAgo } from "@/components/ui";
import { toneSoftBg, toneText, type Tone } from "@/components/ui/tone";
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
import { EvidenceChips, PipelineStatusLine } from "./parts";
import { divergentType, noSituationMessage, TRAPPED_DISPLAY, trappedCountText, uniqueLocations } from "./model";

/** Tono del estado; sin evidencia queda neutro (nunca verde ni "seguro"). */
const stripTone: Record<TrappedStatus, Tone> = {
  confirmed: "critical",
  probable: "critical",
  possible: "warning",
  no_evidence: "neutral",
  cleared_by_unit: "ok",
};

/** Borde izquierdo: el único color de la franja además del estado. */
const stripEdge: Record<TrappedStatus, string> = {
  confirmed: "border-l-critical",
  probable: "border-l-critical",
  possible: "border-l-warning",
  no_evidence: "border-l-line-strong",
  cleared_by_unit: "border-l-ok",
};

const stripIcon: Record<TrappedStatus, LucideIcon> = {
  confirmed: Siren,
  probable: Siren,
  possible: TriangleAlert,
  no_evidence: CircleHelp,
  cleared_by_unit: ShieldCheck,
};

/** Lugares y chips visibles antes de plegar en "+N". */
const MAX_PLACES = 2;
const MAX_CHIPS = 3;

export function CriticalStrip({ incident, mediaCount, onEvidence, className }: CriticalStripProps) {
  const situation = incident.situation;
  if (!situation) {
    return <EmptyStrip incident={incident} mediaCount={mediaCount} className={className} />;
  }
  return <ReportStrip incident={incident} situation={situation} onEvidence={onEvidence} className={className} />;
}

/* ─────────────────────────── Sin informe ─────────────────────────── */

function EmptyStrip({ incident, mediaCount, className }: Pick<CriticalStripProps, "incident" | "mediaCount" | "className">) {
  const failed = incident.pipeline.fusion_status === "error";
  const working = !failed && mediaCount > 0;
  return (
    <section
      aria-label="Personas atrapadas"
      data-trapped="none"
      className={cn("@container rounded-lg border border-l-[3px] border-line border-l-line-strong bg-surface", className)}
    >
      <div className="flex flex-col gap-2 p-3 @xl:flex-row @xl:items-center @xl:gap-4">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted">
            {working ? <Spinner size="sm" label="Analizando" /> : <Hourglass aria-hidden="true" className="size-5" />}
          </span>
          <div className="min-w-0">
            <p className="text-xs text-muted">Personas atrapadas · sin informe aún</p>
            <p aria-live="polite" className="font-display text-xl leading-tight font-semibold text-text">
              {failed ? "No hay informe de situación" : noSituationMessage(mediaCount)}
            </p>
            <p className="text-sm text-muted">Mientras no haya análisis no se descartan víctimas.</p>
          </div>
        </div>
        <PipelineStatusLine pipeline={incident.pipeline} className="@xl:max-w-[45%]" />
      </div>
    </section>
  );
}

/* ─────────────────────────── Con informe ─────────────────────────── */

interface ReportStripProps {
  incident: CriticalStripProps["incident"];
  situation: SituationReport;
  onEvidence: CriticalStripProps["onEvidence"];
  className?: string;
}

function ReportStrip({ incident, situation, onEvidence, className }: ReportStripProps) {
  const [whyOpen, setWhyOpen] = useState(false);
  const whyId = useId();
  const { trapped, injured } = situation;
  const status = trapped.status;
  const tone = stripTone[status] ?? "neutral";
  const Icon = stripIcon[status] ?? CircleHelp;
  const display = TRAPPED_DISPLAY[status] ?? TRAPPED_DISPLAY.no_evidence;
  const alarm = status === "confirmed" || status === "probable";
  const count = trappedCountText(trapped);
  const places = uniqueLocations(trapped.locations);
  const shownPlaces = places.slice(0, MAX_PLACES);
  const morePlaces = places.length - shownPlaces.length;
  const basis = trapped.basis.trim();
  const seenType = divergentType(incident, situation);
  const SeenIcon = seenType ? incidentTypeIcon[seenType] : ScanEye;
  // Sin evidencia de lesionados se lee atenuado, pero el texto mantiene "(no descarta)".
  const injuredTone = injured.status === "no_evidence" ? "neutral" : (likelihoodTone[injured.status] ?? "neutral");

  return (
    <section
      aria-label="Personas atrapadas y estado del incidente"
      data-trapped={status}
      className={cn("@container rounded-lg border border-l-[3px] border-line bg-surface", stripEdge[status], className)}
    >
      <div className="flex flex-col gap-3 p-3 @3xl:flex-row @3xl:items-start @3xl:gap-6">
        {/* Izquierda: atrapados */}
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span
            className={cn(
              "flex size-10 shrink-0 items-center justify-center rounded-full",
              toneSoftBg[tone],
              tone === "neutral" ? "text-muted" : toneText[tone],
              alarm && "animate-pulse-critical",
            )}
          >
            <Icon aria-hidden="true" className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-xs text-muted">Personas atrapadas</p>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <p
                aria-live="polite"
                className={cn(
                  "font-display text-3xl leading-none font-bold",
                  tone === "neutral" ? "text-text" : toneText[tone],
                )}
              >
                {display.primary}
                {display.qualifier ? " " : null}
                {display.qualifier ? (
                  <span className="text-base font-semibold tracking-normal text-text">— {display.qualifier}</span>
                ) : null}
              </p>
              {count ? <span className="tabular text-base font-semibold text-text">{count}</span> : null}
              {shownPlaces.length > 0 ? (
                <span title={trapped.locations.join(" · ")} className="inline-flex min-w-0 items-center gap-1 text-sm text-muted">
                  <MapPin aria-hidden="true" className="size-3.5 shrink-0" />
                  <span className="min-w-0 truncate">
                    {shownPlaces.join(" · ")}
                    {morePlaces > 0 ? ` +${morePlaces}` : null}
                  </span>
                </span>
              ) : null}
            </div>
            {trapped.evidence.length > 0 || basis ? (
              <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5">
                <EvidenceChips
                  refs={trapped.evidence}
                  onEvidence={onEvidence}
                  max={MAX_CHIPS}
                  label="Evidencia sobre personas atrapadas"
                />
                {basis ? (
                  <button
                    type="button"
                    aria-expanded={whyOpen}
                    aria-controls={whyId}
                    onClick={() => setWhyOpen((v) => !v)}
                    className="inline-flex h-7 items-center gap-0.5 rounded-md px-1.5 text-xs font-medium text-muted transition-colors hover:bg-surface-2 hover:text-text"
                  >
                    Por qué
                    <ChevronDown aria-hidden="true" className={cn("size-3.5 transition-transform", whyOpen && "rotate-180")} />
                  </button>
                ) : null}
              </div>
            ) : null}
            {basis ? (
              <p id={whyId} hidden={!whyOpen} className="mt-1.5 text-sm text-muted">
                {basis}
              </p>
            ) : null}
          </div>
        </div>

        {/* Derecha: gravedad, lesionados, titular y estado del análisis */}
        <div className="flex min-w-0 flex-col gap-1.5 @3xl:w-[40%] @3xl:max-w-xl">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Badge size="md" tone={severityTone[situation.severity] ?? "neutral"}>
              Gravedad {labelOr(severityLabel, situation.severity)}
            </Badge>
            <span className="text-sm text-muted">
              Lesionados:{" "}
              <span className={cn(injuredTone !== "neutral" && cn("font-medium", toneText[injuredTone]))}>
                {labelOr(likelihoodLabel, injured.status)}
                {injured.count_estimate > 0 ? ` · ~${Math.round(injured.count_estimate)}` : ""}
              </span>
            </span>
          </div>
          {situation.headline.trim() ? (
            <p className="line-clamp-2 text-base leading-snug font-medium text-text">{situation.headline}</p>
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
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
            <ConfidenceMeter level={situation.overall_confidence} size="sm" />
            {incident.situation_updated_at ? (
              <>
                <span aria-hidden="true">·</span>
                <TimeAgo iso={incident.situation_updated_at} />
              </>
            ) : null}
            <PipelineStatusLine pipeline={incident.pipeline} />
          </div>
        </div>
      </div>
    </section>
  );
}
