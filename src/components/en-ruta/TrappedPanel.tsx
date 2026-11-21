"use client";

import { ChevronDown, HelpCircle, ImageIcon, MapPin, ShieldCheck, Siren, TriangleAlert, type LucideIcon } from "lucide-react";
import type { EvidenceRef, SituationReport, TrappedStatus } from "@/lib/domain";
import { ConfidenceMeter } from "@/components/ui";
import { cn } from "@/lib/cn";
import { pluralize } from "@/lib/format";
import { labelOr, likelihoodLabel, likelihoodTone, trappedStatusShort, trappedTone } from "@/lib/labels";
import { trappedCountText } from "./briefing-diff";

const STATUS_ICON: Record<TrappedStatus, LucideIcon> = {
  confirmed: Siren,
  probable: Siren,
  possible: TriangleAlert,
  no_evidence: HelpCircle,
  cleared_by_unit: ShieldCheck,
};

const PANEL_TONE = {
  critical: "border-critical bg-critical-soft",
  warning: "border-warning bg-warning-soft",
  info: "border-info/60 bg-info-soft",
  ok: "border-ok/60 bg-ok-soft",
} as const;

const TEXT_TONE = {
  critical: "text-critical",
  warning: "text-warning",
  info: "text-info",
  ok: "text-ok",
} as const;

type PanelTone = keyof typeof PANEL_TONE;

function panelTone(status: TrappedStatus): PanelTone {
  const t = trappedTone[status];
  return t === "critical" || t === "warning" || t === "ok" ? t : "info";
}

/** Aclaración obligatoria según el estado: nada de esto se lee como "no hay nadie". */
const STATUS_NOTE: Partial<Record<TrappedStatus, string>> = {
  no_evidence:
    "Que no se vea a nadie en las imágenes NO descarta víctimas. Busca y confirma al llegar.",
  cleared_by_unit: "Lo informó por radio una unidad en el lugar.",
  possible: "Hay indicios o un aviso sin corroborar. Trátalo como posible víctima.",
};

export function evidenceLabel(e: EvidenceRef): string {
  return e.frame >= 0 ? `${e.ref} · fotograma ${e.frame + 1}` : e.ref;
}

/** PERSONAS ATRAPADAS en tamaño enorme: estado, cantidad, dónde, por qué y con qué evidencia. */
export function TrappedPanel({
  situation,
  onOpenEvidence,
  canOpenEvidence,
}: {
  situation: SituationReport;
  /** Abre la imagen clave que respalda una evidencia (si existe). */
  onOpenEvidence: (e: EvidenceRef) => void;
  canOpenEvidence: (e: EvidenceRef) => boolean;
}) {
  const { trapped, injured } = situation;
  const tone = panelTone(trapped.status);
  const Icon = STATUS_ICON[trapped.status] ?? HelpCircle;
  const count = trappedCountText(trapped);
  const alarm = trapped.status === "confirmed" || trapped.status === "probable";
  const note = STATUS_NOTE[trapped.status];
  const injuredTone = likelihoodTone[injured.status];

  return (
    <section aria-labelledby="atrapados" className={cn("rounded-lg border-2 p-4 lg:p-5", PANEL_TONE[tone])}>
      <h2 id="atrapados" className="label-caps text-xl text-text lg:text-2xl">
        Personas atrapadas
      </h2>
      <p className={cn("mt-1 flex items-center gap-3 font-display text-5xl leading-none font-bold lg:text-6xl", TEXT_TONE[tone])}>
        <span aria-hidden className={cn("shrink-0 rounded-full p-1", alarm && "animate-pulse-critical")}>
          <Icon className="size-10 lg:size-12" strokeWidth={2.5} />
        </span>
        <span className="min-w-0 break-words">{labelOr(trappedStatusShort, trapped.status, "SIN DATO")}</span>
      </p>
      {count && <p className="mt-2 font-display text-3xl leading-tight font-bold text-text lg:text-4xl">{count}</p>}
      {note && <p className="mt-2 text-xl leading-snug font-semibold text-text">{note}</p>}

      {trapped.locations.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1.5">
          {trapped.locations.map((loc) => (
            <li key={loc} className="flex items-start gap-2 text-xl leading-snug text-text lg:text-2xl">
              <MapPin aria-hidden className="mt-1 size-6 shrink-0" />
              <span className="min-w-0">{loc}</span>
            </li>
          ))}
        </ul>
      )}

      {/* El fundamento y la evidencia van plegados: en movimiento se lee estado, cantidad y dónde. */}
      {(trapped.basis.trim() || trapped.evidence.length > 0) && (
        <details className="group mt-3">
          <summary className="flex min-h-12 cursor-pointer list-none items-center gap-2 rounded-md text-lg font-semibold text-text [&::-webkit-details-marker]:hidden">
            <ChevronDown aria-hidden className="size-6 shrink-0 transition-transform group-open:rotate-180" />
            Por qué y evidencia
            {trapped.evidence.length > 0 && <span className="font-normal text-muted">({trapped.evidence.length})</span>}
          </summary>
          {trapped.basis.trim() && <p className="mt-2 text-lg leading-snug text-muted">{trapped.basis}</p>}

          {trapped.evidence.length > 0 && (
            <ul aria-label="Evidencia" className="mt-3 flex flex-wrap gap-2">
              {trapped.evidence.map((e, i) => {
                const label = evidenceLabel(e);
                const content = (
                  <>
                    <span className="font-mono font-semibold">{label}</span>
                    {e.note.trim() && <span className="text-muted"> — {e.note}</span>}
                  </>
                );
                return (
                  <li key={`${e.ref}-${e.frame}-${i}`} className="max-w-full">
                    {canOpenEvidence(e) ? (
                      <button
                        type="button"
                        onClick={() => onOpenEvidence(e)}
                        className="inline-flex max-w-full items-start gap-1.5 rounded-md border border-line-strong bg-surface px-2.5 py-1.5 text-left text-base leading-snug text-text hover:border-text"
                      >
                        <ImageIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
                        <span className="min-w-0">{content}</span>
                      </button>
                    ) : (
                      <span className="inline-block max-w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-base leading-snug text-text">
                        {content}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </details>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line-strong/60 pt-3">
        <p className="text-lg text-text">
          <span className="font-semibold">Lesionados:</span>{" "}
          <span className={cn(TEXT_TONE[injuredTone === "critical" || injuredTone === "warning" ? injuredTone : "info"], "font-semibold")}>
            {labelOr(likelihoodLabel, injured.status)}
          </span>
          {injured.count_estimate > 0 && <> · {pluralize(Math.round(injured.count_estimate), "persona")}</>}
          {injured.detail.trim() && <span className="text-muted"> — {injured.detail}</span>}
        </p>
        <span className="ml-auto">
          <ConfidenceMeter level={situation.overall_confidence} className="text-base!" />
        </span>
      </div>
    </section>
  );
}

/** Lugar de PERSONAS ATRAPADAS mientras no hay análisis: nunca queda vacío ni "sin víctimas". */
export function TrappedPending({ mediaCount }: { mediaCount: number }) {
  return (
    <section aria-labelledby="atrapados" className="rounded-lg border-2 border-info/60 bg-info-soft p-4 lg:p-5">
      <h2 id="atrapados" className="label-caps text-xl text-text lg:text-2xl">
        Personas atrapadas
      </h2>
      <p className="mt-1 flex items-center gap-3 font-display text-4xl leading-none font-bold text-info lg:text-5xl">
        <HelpCircle aria-hidden className="size-10 shrink-0" strokeWidth={2.5} />
        SIN ANÁLISIS AÚN
      </p>
      <p className="mt-3 text-xl leading-snug font-semibold text-text">
        Aún no hay análisis. Llegará apenas los vecinos o el dron envíen imágenes.
      </p>
      <p className="mt-2 text-lg leading-snug text-muted">
        {mediaCount > 0
          ? `Ya llegaron ${pluralize(mediaCount, "video o foto", "videos o fotos")}; el análisis está en curso.`
          : "Todavía no llegan videos ni fotos de esta emergencia."}{" "}
        No se descarta nada: confirma al llegar.
      </p>
    </section>
  );
}
