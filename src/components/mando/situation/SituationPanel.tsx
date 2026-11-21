"use client";
/**
 * Columna de situación: hallazgos, peligros, fuego/estructura/vehículos, acceso, consideraciones
 * tácticas, contradicciones, incógnitas y briefing. Scroll propio y secciones plegables.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Car,
  Check,
  CircleHelp,
  ClipboardCheck,
  ClipboardList,
  Flame,
  Hourglass,
  Lightbulb,
  Megaphone,
  RefreshCw,
  Route,
  Scale,
  Siren,
  TriangleAlert,
} from "lucide-react";
import { Badge, Button, ConfidenceMeter, EmptyState, KeyValue, Panel, type KeyValueItem } from "@/components/ui";
import { toneText } from "@/components/ui/tone";
import type { CommEntry, EvidenceRef, Incident, SituationReport } from "@/lib/domain";
import type { MediaView, RuntimeMode } from "@/lib/contract";
import {
  analysisEngineLabel,
  analysisEngineTone,
  constructionLabel,
  fireStageLabel,
  hazardKindIcon,
  hazardKindLabel,
  hazardSeverityLabel,
  hazardSeverityTone,
  labelOr,
  likelihoodLabel,
  likelihoodTone,
  priorityLabel,
  priorityTone,
} from "@/lib/labels";
import { cn } from "@/lib/cn";
import type { SituationPanelProps } from "./types";
import { ClampText, CollapsibleSection, EvidenceChips, PipelineStatusLine, UpdatedAgo } from "./parts";
import { BriefingBlock } from "./Briefing";
import { refsFromLabels } from "./evidence";
import { byPriority, bySeverity, noSituationMessage, showsFireAndStructure, showsVehicles } from "./model";

type SectionId = "insights" | "hazards" | "physical" | "access" | "tactics" | "contradictions" | "unknowns" | "briefing";

/** Cuánto queda "Solicitado" el botón Reanalizar antes de volver a habilitarse. */
const REANALYZE_COOLDOWN_MS = 5000;

/** Chips de evidencia visibles por ítem antes de plegar en "+N". */
const MAX_CHIPS = 3;

export function SituationPanel({ incident, media, comms, onEvidence, onReanalyze, mode, className }: SituationPanelProps) {
  const [closed, setClosed] = useState<ReadonlySet<SectionId>>(() => new Set());
  const situation = incident.situation;

  const toggle = (id: SectionId) =>
    setClosed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Panel
      scroll
      flush
      title="Situación"
      icon={ClipboardList}
      badge={situation ? <ConfidenceMeter level={situation.overall_confidence} size="sm" className="ml-1" /> : null}
      footer={<PanelFooter incident={incident} media={media} comms={comms} onReanalyze={onReanalyze} mode={mode} />}
      className={cn("h-full", className)}
    >
      {incident.pipeline.fusion_status !== "idle" ? (
        <div className="border-b border-line px-3 py-2">
          <PipelineStatusLine pipeline={incident.pipeline} />
        </div>
      ) : null}
      {situation ? (
        <Report
          incident={incident}
          situation={situation}
          media={media}
          comms={comms}
          onEvidence={onEvidence}
          isOpen={(id) => !closed.has(id)}
          toggle={toggle}
        />
      ) : (
        <NoSituation incident={incident} mediaCount={media.length} />
      )}
    </Panel>
  );
}

/* ─────────────────────────── Sin informe ─────────────────────────── */

function NoSituation({ incident, mediaCount }: { incident: Incident; mediaCount: number }) {
  const failed = incident.pipeline.fusion_status === "error";
  const working = !failed && mediaCount > 0;
  return (
    <EmptyState
      icon={Hourglass}
      title={failed ? "No hay informe de situación" : working ? "Sin informe todavía" : noSituationMessage(mediaCount)}
      description={
        failed
          ? "El análisis falló antes de producir un informe. Puedes reintentar con «Reanalizar»."
          : working
            ? "Aparecerá aquí cuando termine el análisis."
            : "Llegará con el primer video, foto o mensaje de radio."
      }
    />
  );
}

/* ─────────────────────────── Informe ─────────────────────────── */

interface ReportProps {
  incident: Incident;
  situation: SituationReport;
  media: MediaView[];
  comms: CommEntry[];
  onEvidence: (ref: EvidenceRef) => void;
  isOpen: (id: SectionId) => boolean;
  toggle: (id: SectionId) => void;
}

function Report({ incident, situation: s, media, comms, onEvidence, isOpen, toggle }: ReportProps) {
  const chips = (refs: readonly EvidenceRef[], label?: string, className = "mt-1.5") => (
    <EvidenceChips
      refs={refs}
      media={media}
      comms={comms}
      onEvidence={onEvidence}
      max={MAX_CHIPS}
      label={label}
      className={className}
    />
  );

  const insights = byPriority(s.insights);
  const hazards = bySeverity(s.hazards);
  const actions = byPriority(s.recommended_actions);
  const unknowns = s.unknowns.map((u) => u.trim()).filter(Boolean);
  const showFire = showsFireAndStructure(incident, s);
  const showCars = showsVehicles(incident, s);
  const physicalTitle =
    showFire && showCars ? "Fuego, estructura y vehículos" : showFire ? "Fuego y estructura" : "Vehículos";

  return (
    <div>
      <CollapsibleSection
        title="Hallazgos"
        icon={Lightbulb}
        count={insights.length}
        tone={insights.some((i) => i.priority === "critical") ? "critical" : "neutral"}
        open={isOpen("insights")}
        onToggle={() => toggle("insights")}
      >
        {insights.length === 0 ? (
          <Muted>La IA no destacó hallazgos con la información disponible.</Muted>
        ) : (
          <ul className={LIST}>
            {insights.map((item, i) => (
              <li key={`${item.id}-${i}`} className={ITEM}>
                <div className="flex items-start gap-2">
                  <p className="min-w-0 flex-1 font-semibold leading-snug text-text">{item.title}</p>
                  <Badge
                    tone={priorityTone[item.priority] ?? "neutral"}
                    icon={item.priority === "critical" ? Siren : undefined}
                    className="mt-0.5"
                  >
                    {labelOr(priorityLabel, item.priority)}
                  </Badge>
                </div>
                <ClampText text={item.detail} className="mt-0.5 text-sm text-muted" />
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <ConfidenceMeter level={item.confidence} size="sm" />
                  {chips(item.evidence, `Evidencia de «${item.title}»`, "")}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CollapsibleSection>

      <CollapsibleSection
        title="Peligros"
        icon={TriangleAlert}
        count={hazards.length}
        tone={hazards.some((h) => h.severity === "high") ? "critical" : hazards.length > 0 ? "warning" : "neutral"}
        open={isOpen("hazards")}
        onToggle={() => toggle("hazards")}
      >
        {hazards.length === 0 ? (
          <Muted>No se identificaron peligros en las fuentes. Eso no los descarta: verifícalo al llegar.</Muted>
        ) : (
          <ul className={LIST}>
            {hazards.map((h, i) => {
              const HazardIcon = hazardKindIcon[h.kind] ?? TriangleAlert;
              const tone = hazardSeverityTone[h.severity] ?? "neutral";
              return (
                <li key={`${h.kind}-${i}`} className={ITEM}>
                  <div className="flex items-center gap-2">
                    <HazardIcon aria-hidden="true" className={cn("size-4 shrink-0", toneText[tone])} />
                    <span className="min-w-0 flex-1 font-semibold text-text">{labelOr(hazardKindLabel, h.kind)}</span>
                    <Badge tone={tone}>Gravedad {labelOr(hazardSeverityLabel, h.severity).toLowerCase()}</Badge>
                  </div>
                  <ClampText text={h.description} className="mt-0.5 text-sm text-muted" />
                  {chips(h.evidence, `Evidencia de ${labelOr(hazardKindLabel, h.kind).toLowerCase()}`)}
                </li>
              );
            })}
          </ul>
        )}
      </CollapsibleSection>

      {showFire || showCars ? (
        <CollapsibleSection
          title={physicalTitle}
          icon={showFire ? Flame : Car}
          open={isOpen("physical")}
          onToggle={() => toggle("physical")}
        >
          <div className="flex flex-col gap-4">
            {showFire ? <FireAndStructure s={s} /> : null}
            {showCars ? <Vehicles s={s} /> : null}
          </div>
        </CollapsibleSection>
      ) : null}

      <CollapsibleSection title="Acceso y agua" icon={Route} open={isOpen("access")} onToggle={() => toggle("access")}>
        <Access s={s} />
      </CollapsibleSection>

      <CollapsibleSection
        title="Consideraciones tácticas"
        icon={ClipboardCheck}
        count={actions.length}
        open={isOpen("tactics")}
        onToggle={() => toggle("tactics")}
      >
        <p role="note" className="mb-1 text-xs text-muted">
          Sugerencias de apoyo — la decisión es del oficial a cargo
        </p>
        {actions.length === 0 ? (
          <Muted>Sin sugerencias por ahora.</Muted>
        ) : (
          <ol className={LIST}>
            {actions.map((a, i) => (
              <li key={`${i}-${a.action}`} className={ITEM}>
                <div className="flex items-start gap-2">
                  <p className="min-w-0 flex-1 font-semibold leading-snug text-text">{a.action}</p>
                  <Badge tone={priorityTone[a.priority] ?? "neutral"} className="mt-0.5">
                    {labelOr(priorityLabel, a.priority)}
                  </Badge>
                </div>
                <ClampText text={a.rationale} className="mt-0.5 text-sm text-muted" />
              </li>
            ))}
          </ol>
        )}
      </CollapsibleSection>

      <CollapsibleSection
        title="Contradicciones"
        icon={Scale}
        count={s.contradictions.length}
        tone={s.contradictions.length > 0 ? "warning" : "neutral"}
        open={isOpen("contradictions")}
        onToggle={() => toggle("contradictions")}
      >
        {s.contradictions.length === 0 ? (
          <Muted>No se detectaron contradicciones entre las fuentes.</Muted>
        ) : (
          <ul className={LIST}>
            {s.contradictions.map((c, i) => (
              <li key={`${i}-${c.description}`} className={ITEM}>
                <p className="flex items-start gap-1.5 text-sm text-text">
                  <Scale aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-warning" />
                  {c.description}
                </p>
                {chips(refsFromLabels(c.sources), "Fuentes en conflicto")}
              </li>
            ))}
          </ul>
        )}
      </CollapsibleSection>

      <CollapsibleSection
        title="Lo que no se sabe"
        icon={CircleHelp}
        count={unknowns.length}
        open={isOpen("unknowns")}
        onToggle={() => toggle("unknowns")}
      >
        {unknowns.length === 0 ? (
          <Muted>La IA no listó incógnitas. Igual confirma lo esencial al llegar.</Muted>
        ) : (
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-text marker:text-muted">
            {unknowns.map((u, i) => (
              <li key={`${i}-${u}`}>{u}</li>
            ))}
          </ul>
        )}
      </CollapsibleSection>

      <CollapsibleSection title="Briefing" icon={Megaphone} open={isOpen("briefing")} onToggle={() => toggle("briefing")}>
        <BriefingBlock briefing={s.briefing} />
      </CollapsibleSection>
    </div>
  );
}

/** Listas planas: separadores en vez de tarjetas. */
const LIST = "flex flex-col divide-y divide-line";
const ITEM = "py-2.5 first:pt-1 last:pb-0";

function Muted({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted">{children}</p>;
}

function SubTitle({ children }: { children: ReactNode }) {
  return <h4 className="label-caps mb-1.5 text-xs text-muted">{children}</h4>;
}

function FireAndStructure({ s }: { s: SituationReport }) {
  const fire: KeyValueItem[] = [
    { label: "Fuego", value: s.fire.present ? "Visible o informado" : "No visible en las fuentes" },
    { label: "Etapa", value: s.fire.stage === "unknown" ? "" : labelOr(fireStageLabel, s.fire.stage, "") },
    { label: "Ubicación", value: s.fire.location.trim() },
    { label: "Propagación y exposiciones", value: s.fire.spread.trim() },
    { label: "Humo", value: s.fire.smoke.trim() },
  ];
  const structure: KeyValueItem[] = [
    { label: "Edificación", value: s.structure.description.trim() },
    { label: "Pisos", value: s.structure.floors > 0 ? String(Math.round(s.structure.floors)) : "" },
    {
      label: "Construcción",
      value: s.structure.construction === "unknown" ? "" : labelOr(constructionLabel, s.structure.construction, ""),
    },
    { label: "Exposiciones", value: s.structure.exposures.trim() },
  ];
  return (
    <>
      <div>
        <SubTitle>Fuego</SubTitle>
        <KeyValue dense items={fire} />
      </div>
      <div>
        <SubTitle>Estructura</SubTitle>
        <KeyValue dense items={structure} />
      </div>
    </>
  );
}

function Vehicles({ s }: { s: SituationReport }) {
  const v = s.vehicles;
  const items: KeyValueItem[] = [
    { label: "Cantidad", value: v.count > 0 ? String(Math.round(v.count)) : "" },
    { label: "Descripción", value: v.description.trim() },
    {
      label: "Atrapamiento en vehículos",
      value: (
        <Badge tone={likelihoodTone[v.entrapment] ?? "neutral"} size="md">
          {labelOr(likelihoodLabel, v.entrapment)}
        </Badge>
      ),
    },
    { label: "Detalle", value: v.details.trim() },
  ];
  return (
    <div>
      <SubTitle>Vehículos</SubTitle>
      <KeyValue dense items={items} />
    </div>
  );
}

function Access({ s }: { s: SituationReport }) {
  const a = s.access;
  const obstructions = a.obstructions.map((o) => o.trim()).filter(Boolean);
  const empty = !a.best_approach.trim() && !a.water_supply.trim() && !a.staging_suggestion.trim() && obstructions.length === 0;
  if (empty) return <Muted>Sin información de acceso ni agua en las fuentes. Confírmalo por radio o al llegar.</Muted>;
  const items: KeyValueItem[] = [
    { label: "Mejor aproximación", value: a.best_approach.trim() },
    {
      label: "Obstáculos",
      value:
        obstructions.length > 0 ? (
          <ul className="list-disc pl-4">
            {obstructions.map((o, i) => (
              <li key={`${i}-${o}`}>{o}</li>
            ))}
          </ul>
        ) : (
          ""
        ),
    },
    { label: "Agua", value: a.water_supply.trim() },
    { label: "Zona de espera sugerida", value: a.staging_suggestion.trim() },
  ];
  return <KeyValue dense items={items} />;
}

/* ─────────────────────────── Pie ─────────────────────────── */

interface PanelFooterProps {
  incident: Incident;
  media: MediaView[];
  comms: CommEntry[];
  onReanalyze: () => void;
  mode?: RuntimeMode | null;
}

/** Explicación del rótulo "Simulado" (tooltip y lector de pantalla). */
function simulatedReason(mode: RuntimeMode | null | undefined, demo: boolean): string {
  if (demo) return "Informe simulado: datos de demostración, ficticios.";
  if (mode?.ai === "simulated") return "Informe simulado por el motor de reglas: no proviene de los videos.";
  return "Informe simulado por el motor de reglas, no por el modelo de IA. Reanaliza para reintentar con el modelo.";
}

function PanelFooter({ incident, media, comms, onReanalyze, mode }: PanelFooterProps) {
  const [requested, setRequested] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );

  const engine = incident.situation ? incident.situation_engine : null;
  const updatedAt = incident.situation ? incident.situation_updated_at : null;
  const hasSources = media.length > 0 || comms.length > 0;

  const reanalyze = () => {
    onReanalyze();
    setRequested(true);
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setRequested(false);
    }, REANALYZE_COOLDOWN_MS);
  };

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      {engine ? (
        <Badge
          tone={analysisEngineTone[engine] ?? "neutral"}
          variant="outline"
          data-engine={engine}
          title={engine === "simulated" ? simulatedReason(mode, incident.origin === "demo") : undefined}
        >
          {labelOr(analysisEngineLabel, engine)}
        </Badge>
      ) : (
        <span className="text-xs text-muted">Sin informe</span>
      )}
      {updatedAt ? <UpdatedAgo iso={updatedAt} className="text-xs" /> : null}
      <Button
        size="sm"
        icon={requested ? Check : RefreshCw}
        onClick={reanalyze}
        disabled={requested || !hasSources}
        title={hasSources ? "Forzar una nueva fusión de todas las fuentes" : "Aún no hay medios ni comunicaciones que analizar"}
        className="ml-auto"
      >
        {requested ? "Solicitado" : "Reanalizar"}
      </Button>
    </div>
  );
}
