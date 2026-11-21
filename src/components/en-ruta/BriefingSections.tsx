"use client";

import {
  AudioLines,
  CircleHelp,
  Droplets,
  Flag,
  Megaphone,
  Navigation,
  OctagonAlert,
  Route,
  Square,
  TriangleAlert,
  Volume2,
  VolumeX,
} from "lucide-react";
import type { AnalysisEngine, SituationReport } from "@/lib/domain";
import { ConfidenceMeter } from "@/components/ui";
import { cn } from "@/lib/cn";
import { timeAgo } from "@/lib/format";
import {
  analysisEngineLabel,
  hazardKindIcon,
  hazardKindLabel,
  hazardSeverityLabel,
  labelOr,
  severityLabel,
  severityTone,
} from "@/lib/labels";
import { sortHazards } from "./briefing-diff";
import type { BriefingVoice } from "./hooks";
import { BriefSection, Pill, type PillTone } from "./parts";

const SEVERITY_PILL: Record<string, PillTone> = { critical: "critical", warning: "warning", info: "info", ok: "ok" };

/* ───────────── Voz ───────────── */

/** "Leer briefing" y el interruptor de lectura automática; oculto si el navegador no tiene voz. */
export function VoiceControls({ voice, className }: { voice: BriefingVoice; className?: string }) {
  if (!voice.supported) return null;
  return (
    <div className={cn("flex flex-wrap items-stretch gap-2", className)}>
      {voice.speaking ? (
        <button
          type="button"
          onClick={voice.stop}
          className="inline-flex min-h-14 items-center gap-2.5 rounded-md border border-transparent bg-text px-5 text-lg font-bold text-bg"
        >
          <Square aria-hidden className="size-5" fill="currentColor" />
          Detener lectura
        </button>
      ) : voice.canRead ? (
        <button
          type="button"
          onClick={voice.read}
          className="inline-flex min-h-14 items-center gap-2.5 rounded-md border border-transparent bg-accent px-5 text-lg font-bold text-on-solid hover:bg-accent/90"
        >
          <Volume2 aria-hidden className="size-6" />
          Leer briefing
        </button>
      ) : null}
      <button
        type="button"
        role="switch"
        aria-checked={voice.autoRead}
        onClick={() => voice.setAutoRead(!voice.autoRead)}
        className={cn(
          "inline-flex min-h-14 flex-1 items-center gap-3 rounded-md border px-4 text-left text-base leading-tight font-semibold sm:flex-none",
          voice.autoRead ? "border-accent bg-accent-soft text-text" : "border-line-strong bg-surface-2 text-text",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border-2 transition-colors",
            voice.autoRead ? "border-accent bg-accent" : "border-line-strong bg-bg",
          )}
        >
          <span
            className={cn(
              "block size-5 rounded-full transition-transform",
              voice.autoRead ? "translate-x-[22px] bg-on-solid" : "translate-x-[2px] bg-muted",
            )}
          />
        </span>
        <span className="min-w-0">
          Leer automáticamente cuando cambie
          <span className="block text-sm font-normal text-muted">
            {voice.autoRead ? "Activada" : "Desactivada"}
          </span>
        </span>
        {voice.autoRead ? (
          <AudioLines aria-hidden className="ml-auto size-5 shrink-0 text-accent" />
        ) : (
          <VolumeX aria-hidden className="ml-auto size-5 shrink-0 text-muted" />
        )}
      </button>
    </div>
  );
}

/* ───────────── Resumen ───────────── */

export function SummarySection({
  situation,
  engine,
  updatedAt,
  now,
  voice,
}: {
  situation: SituationReport;
  engine: AnalysisEngine | null;
  updatedAt: string | null;
  now: number | null;
  voice: BriefingVoice;
}) {
  const sevTone = SEVERITY_PILL[severityTone[situation.severity]] ?? "neutral";
  return (
    <BriefSection
      id="resumen"
      title="Resumen"
      icon={Megaphone}
      aside={<Pill tone={sevTone}>Gravedad {labelOr(severityLabel, situation.severity).toLowerCase()}</Pill>}
    >
      <p className="text-2xl leading-snug font-semibold text-text lg:text-3xl">{situation.headline}</p>
      <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-base text-muted">
        <ConfidenceMeter level={situation.overall_confidence} className="text-base!" />
        <span>
          {engine ? labelOr(analysisEngineLabel, engine) : "IA"}
          {updatedAt && now !== null && <> · análisis {timeAgo(updatedAt, now)}</>}
        </span>
      </p>
      <VoiceControls voice={voice} className="mt-4" />
      {situation.briefing.bullets.length > 0 && (
        <ul className="mt-4 flex flex-col gap-2.5">
          {situation.briefing.bullets.map((b) => (
            <li key={b} className="flex items-start gap-3 text-xl leading-snug text-text lg:text-2xl">
              <span aria-hidden className="mt-3 size-2 shrink-0 rounded-full bg-accent" />
              <span className="min-w-0">{b}</span>
            </li>
          ))}
        </ul>
      )}
    </BriefSection>
  );
}

/* ───────────── Peligros ───────────── */

const HAZARD_SEV_PILL = { high: "critical", medium: "warning", low: "info" } as const;
const HAZARD_ROW = {
  high: "border-critical/60 bg-critical-soft",
  medium: "border-warning/50 bg-warning-soft",
  low: "border-line bg-surface-2",
} as const;
const HAZARD_ICON = { high: "text-critical", medium: "text-warning", low: "text-info" } as const;

export function HazardsSection({ hazards }: { hazards: SituationReport["hazards"] }) {
  const sorted = sortHazards(hazards);
  return (
    <BriefSection id="peligros" title="Peligros" icon={OctagonAlert} aside={sorted.length > 0 && <Pill>{sorted.length}</Pill>}>
      {sorted.length === 0 ? (
        <p className="text-xl leading-snug text-text">
          La IA no identificó peligros en las imágenes. <span className="text-muted">No descarta otros: evalúa al llegar.</span>
        </p>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {sorted.map((h, i) => {
            const Icon = hazardKindIcon[h.kind] ?? TriangleAlert;
            return (
              <li key={`${h.kind}-${i}`} className={cn("flex items-start gap-3 rounded-md border p-3", HAZARD_ROW[h.severity])}>
                <Icon aria-hidden className={cn("mt-0.5 size-8 shrink-0", HAZARD_ICON[h.severity])} strokeWidth={2.25} />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                    <span className="text-xl leading-tight font-bold text-text lg:text-2xl">
                      {labelOr(hazardKindLabel, h.kind, "Peligro")}
                    </span>
                    <Pill tone={HAZARD_SEV_PILL[h.severity]} className="text-sm">
                      Riesgo {labelOr(hazardSeverityLabel, h.severity).toLowerCase()}
                    </Pill>
                  </p>
                  {h.description.trim() && <p className="mt-1 text-lg leading-snug text-text">{h.description}</p>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </BriefSection>
  );
}

/* ───────────── Acceso ───────────── */

export function AccessSection({ access }: { access: SituationReport["access"] }) {
  const rows: { icon: typeof Route; label: string; value: string }[] = [];
  if (access.water_supply.trim()) rows.push({ icon: Droplets, label: "Agua", value: access.water_supply });
  if (access.staging_suggestion.trim())
    rows.push({ icon: Flag, label: "Dónde estacionar", value: access.staging_suggestion });
  const empty = !access.best_approach.trim() && access.obstructions.length === 0 && rows.length === 0;
  return (
    <BriefSection id="acceso" title="Acceso" icon={Navigation}>
      {empty ? (
        <p className="text-xl leading-snug text-muted">Sin información de acceso todavía. Reconoce al llegar.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {access.best_approach.trim() && (
            <p className="flex items-start gap-3 text-xl leading-snug font-semibold text-text lg:text-2xl">
              <Route aria-hidden className="mt-1 size-6 shrink-0 text-accent" />
              <span className="min-w-0">{access.best_approach}</span>
            </p>
          )}
          {access.obstructions.length > 0 && (
            <div>
              <p className="label-caps text-base text-warning">Obstáculos</p>
              <ul className="mt-1 flex flex-col gap-1">
                {access.obstructions.map((o) => (
                  <li key={o} className="flex items-start gap-2 text-lg leading-snug text-text">
                    <TriangleAlert aria-hidden className="mt-1 size-5 shrink-0 text-warning" />
                    <span className="min-w-0">{o}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {rows.map(({ icon: Icon, label, value }) => (
            <p key={label} className="flex items-start gap-3 text-lg leading-snug text-text">
              <Icon aria-hidden className="mt-1 size-5 shrink-0 text-info" />
              <span className="min-w-0">
                <span className="font-semibold">{label}:</span> {value}
              </span>
            </p>
          ))}
        </div>
      )}
    </BriefSection>
  );
}

/* ───────────── Por confirmar ───────────── */

export function UnknownsSection({
  unknowns,
  contradictions,
}: {
  unknowns: string[];
  contradictions: SituationReport["contradictions"];
}) {
  if (unknowns.length === 0 && contradictions.length === 0) return null;
  return (
    <BriefSection id="por-confirmar" title="Por confirmar" icon={CircleHelp}>
      {unknowns.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {unknowns.map((u) => (
            <li key={u} className="flex items-start gap-3 text-lg leading-snug text-text lg:text-xl">
              <span aria-hidden className="mt-1 font-display text-xl font-bold text-info">?</span>
              <span className="min-w-0">{u}</span>
            </li>
          ))}
        </ul>
      )}
      {contradictions.length > 0 && (
        <div className={cn(unknowns.length > 0 && "mt-4")}>
          <p className="label-caps text-base text-warning">Fuentes que no coinciden</p>
          <ul className="mt-1 flex flex-col gap-1.5">
            {contradictions.map((c, i) => (
              <li key={`${c.description}-${i}`} className="text-lg leading-snug text-text">
                {c.description}
                {c.sources.length > 0 && <span className="font-mono text-base text-muted"> ({c.sources.join(", ")})</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </BriefSection>
  );
}
