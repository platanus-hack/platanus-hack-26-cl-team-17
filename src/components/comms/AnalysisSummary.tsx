"use client";

import { useId, useState, type ReactNode } from "react";
import {
  ChevronDown,
  CircleAlert,
  CircleCheck,
  CircleHelp,
  Clock,
  Flag,
  FlaskConical,
  KeyRound,
  PackagePlus,
  PersonStanding,
  RefreshCw,
  Siren,
  TriangleAlert,
  Users,
  type LucideIcon,
} from "lucide-react";
import { Badge, Button, ConfidenceMeter, Spinner, TimeAgo, toneBorder, toneSoftBg, toneText, type Tone } from "@/components/ui";
import { cn } from "@/lib/cn";
import type { AnalysisEngine, CommsAnalysis, PipelineState } from "@/lib/domain";
import { analysisEngineLabel, commsVictimsStatusTone, unitStatusLabel, unitStatusTone } from "@/lib/labels";
import { maydaySeqs, uniqueSorted } from "./comms-model";

export interface AnalysisSummaryProps {
  analysis: CommsAnalysis | null;
  engine: AnalysisEngine | null;
  updatedAt: string | null;
  pipeline: PipelineState;
  /** Cantidad de entradas en la bitácora (para explicar por qué aún no hay análisis). */
  entryCount: number;
  /** seq presentes en la bitácora: las referencias a otras se muestran atenuadas y sin acción. */
  knownSeqs: ReadonlySet<number>;
  onSelectSeq: (seq: number) => void;
  /** Pide reanalizar la radio; sin él no se muestra el botón. */
  onReanalyze?: () => void;
  /** true mientras se envía la solicitud de reanálisis. */
  reanalyzing?: boolean;
}

/** Aviso de análisis simulado propio de la radio (el genérico habla de videos). */
export function CommsSimulatedNotice({ className }: { className?: string }) {
  return (
    <p
      role="note"
      className={cn(
        "flex items-start gap-2 rounded-md border border-warning/40 bg-warning-soft px-2.5 py-2 text-xs leading-snug text-text",
        className,
      )}
    >
      <FlaskConical aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warning" />
      <span>
        <strong className="label-caps text-warning">Simulado</strong> · Análisis por reglas — sin modelo de IA. Busca
        palabras clave; no interpreta la radio como lo haría el modelo. Confirma lo crítico por radio.
      </span>
    </p>
  );
}

/** Chips "C12" que llevan a la entrada en la bitácora. */
export function SeqChips({
  seqs,
  knownSeqs,
  onSelectSeq,
  className,
}: {
  seqs: readonly number[];
  knownSeqs: ReadonlySet<number>;
  onSelectSeq: (seq: number) => void;
  className?: string;
}) {
  const list = uniqueSorted(seqs);
  if (list.length === 0) return null;
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1", className)}>
      {list.map((seq) =>
        knownSeqs.has(seq) ? (
          <button
            key={seq}
            type="button"
            onClick={() => onSelectSeq(seq)}
            title={`Ver C${seq} en la bitácora`}
            className="rounded border border-line bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] leading-none text-text tabular hover:border-line-strong hover:bg-line/50"
          >
            C{seq}
          </button>
        ) : (
          <span
            key={seq}
            title={`C${seq} no está en la bitácora`}
            className="rounded border border-dashed border-line px-1.5 py-0.5 font-mono text-[11px] leading-none text-faint tabular"
          >
            C{seq}
          </span>
        ),
      )}
    </span>
  );
}

function PipelineLine({ pipeline }: { pipeline: PipelineState }) {
  switch (pipeline.comms_status) {
    case "running":
      return (
        <p className="flex items-center gap-2 text-xs text-info" role="status">
          <Spinner size="xs" label="" />
          Analizando la radio…
        </p>
      );
    case "pending":
      return (
        <p className="flex items-center gap-2 text-xs text-info" role="status">
          <Clock aria-hidden className="size-3.5" />
          Análisis de radio en cola
        </p>
      );
    case "error":
      return (
        <p className="flex items-start gap-2 text-xs text-critical" role="alert">
          <CircleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span>
            <strong className="font-semibold">No se pudo analizar la radio.</strong>{" "}
            {pipeline.comms_error?.trim() || "Error sin detalle."} Lo que ves abajo puede estar desactualizado.
          </span>
        </p>
      );
    default:
      return null;
  }
}

function Section({
  icon: Icon,
  title,
  tone = "neutral",
  children,
}: {
  icon: LucideIcon;
  title: string;
  tone?: Tone;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className={cn("label-caps flex items-center gap-1.5 text-[11px]", tone === "neutral" ? "text-muted" : toneText[tone])}>
        <Icon aria-hidden className="size-3.5 shrink-0" />
        {title}
      </h3>
      {children}
    </section>
  );
}

/** Bloque de víctimas según radio. Nunca se presenta "sin víctimas" salvo que una unidad en el lugar lo informe. */
function VictimsBlock({
  victims,
  knownSeqs,
  onSelectSeq,
}: {
  victims: CommsAnalysis["victims"];
  knownSeqs: ReadonlySet<number>;
  onSelectSeq: (seq: number) => void;
}) {
  const tone = commsVictimsStatusTone[victims.status] ?? "info";
  const spec: Record<CommsAnalysis["victims"]["status"], { icon: LucideIcon; title: string }> = {
    reported: { icon: PersonStanding, title: "Radio informa víctimas" },
    denied_by_unit: { icon: CircleCheck, title: "Unidad en el lugar informa que no hay atrapados" },
    unknown: { icon: CircleHelp, title: "Radio aún no informa sobre víctimas — no descarta víctimas" },
  };
  const { icon: Icon, title } = spec[victims.status] ?? spec.unknown;
  return (
    <div className={cn("rounded-md border px-2.5 py-2", toneBorder[tone], toneSoftBg[tone])}>
      <p className={cn("flex items-start gap-2 text-sm font-semibold", toneText[tone])}>
        <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
        <span>{title}</span>
      </p>
      {victims.detail.trim() && <p className="mt-1 pl-6 text-sm text-text">{victims.detail}</p>}
      <SeqChips seqs={victims.entry_seqs} knownSeqs={knownSeqs} onSelectSeq={onSelectSeq} className="mt-1.5 pl-6" />
    </div>
  );
}

/** Banner crítico de MAYDAY activo: siempre visible, aunque el resumen esté plegado. */
export function MaydayBanner({
  analysis,
  knownSeqs,
  onSelectSeq,
}: {
  analysis: CommsAnalysis;
  knownSeqs: ReadonlySet<number>;
  onSelectSeq: (seq: number) => void;
}) {
  if (!analysis.mayday.active) return null;
  return (
    <div role="alert" className="flex items-start gap-2.5 border-b border-critical/40 bg-critical px-3 py-2.5 text-on-solid">
      <Siren aria-hidden className="mt-0.5 size-5 shrink-0 animate-pulse-critical" />
      <div className="min-w-0 flex-1">
        <p className="font-display text-lg leading-tight font-bold tracking-wide uppercase">
          MAYDAY activo — bombero en peligro
        </p>
        {analysis.mayday.detail.trim() && <p className="mt-0.5 text-sm">{analysis.mayday.detail}</p>}
        {maydaySeqs(analysis).length > 0 && (
          <span className="mt-1.5 flex flex-wrap gap-1">
            {maydaySeqs(analysis).map((seq) =>
              knownSeqs.has(seq) ? (
                <button
                  key={seq}
                  type="button"
                  onClick={() => onSelectSeq(seq)}
                  className="rounded border border-on-solid/50 px-1.5 py-0.5 font-mono text-[11px] leading-none tabular hover:bg-on-solid/15"
                >
                  C{seq}
                </button>
              ) : (
                <span key={seq} className="rounded border border-dashed border-on-solid/40 px-1.5 py-0.5 font-mono text-[11px] leading-none opacity-70">
                  C{seq}
                </span>
              ),
            )}
          </span>
        )}
      </div>
    </div>
  );
}

function AnalysisBody({
  analysis,
  knownSeqs,
  onSelectSeq,
}: {
  analysis: CommsAnalysis;
  knownSeqs: ReadonlySet<number>;
  onSelectSeq: (seq: number) => void;
}) {
  const { command } = analysis;
  return (
    <div className="flex flex-col gap-3">
      {analysis.summary.trim() && <p className="text-sm leading-snug text-text">{analysis.summary}</p>}

      <VictimsBlock victims={analysis.victims} knownSeqs={knownSeqs} onSelectSeq={onSelectSeq} />

      <Section icon={Users} title="Unidades">
        {analysis.units.length === 0 ? (
          <p className="text-sm text-muted">La radio aún no identifica unidades.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line rounded-md border border-line">
            {analysis.units.map((u, i) => (
              <li key={`${u.name}-${i}`} className="flex flex-col gap-0.5 px-2.5 py-1.5">
                <span className="flex items-center gap-2">
                  <span className="font-mono text-sm font-semibold text-text">{u.name || "Sin nombre"}</span>
                  <Badge tone={unitStatusTone[u.status] ?? "neutral"} dot>
                    {unitStatusLabel[u.status] ?? "Sin información"}
                  </Badge>
                </span>
                {u.last_report.trim() && <span className="text-xs text-muted">{u.last_report}</span>}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section icon={Flag} title="Mando">
        {command.established ? (
          <p className="text-sm text-text">
            <span className="font-semibold">{command.commander.trim() || "Al mando: sin nombre informado"}</span>
            {" · "}
            <span className="text-muted">
              Puesto de mando: {command.post_location.trim() || "ubicación no informada"}
            </span>
          </p>
        ) : (
          <p className="flex items-start gap-1.5 text-sm text-warning">
            <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            La radio aún no indica que se haya establecido el mando.
          </p>
        )}
      </Section>

      {analysis.resource_requests.length > 0 && (
        <Section icon={PackagePlus} title="Recursos solicitados pendientes" tone="warning">
          <ul className="flex flex-col gap-1">
            {analysis.resource_requests.map((r, i) => (
              <li key={i} className="flex items-start gap-1.5 text-sm text-text">
                <span aria-hidden className="mt-2 size-1.5 shrink-0 rounded-full bg-warning" />
                {r}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {analysis.hazards.length > 0 && (
        <Section icon={TriangleAlert} title="Peligros informados por radio" tone="warning">
          <ul className="flex flex-col gap-1">
            {analysis.hazards.map((h, i) => (
              <li key={i} className="flex items-start gap-1.5 text-sm text-text">
                <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warning" />
                {h}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {analysis.open_questions.length > 0 && (
        <Section icon={CircleHelp} title="Conviene preguntar por radio" tone="info">
          <ul className="flex flex-col gap-1">
            {analysis.open_questions.map((q, i) => (
              <li key={i} className="flex items-start gap-1.5 text-sm text-text">
                <CircleHelp aria-hidden className="mt-0.5 size-3.5 shrink-0 text-info" />
                {q}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {analysis.codes_interpreted.length > 0 && (
        <Section icon={KeyRound} title="Claves interpretadas">
          <p className="text-xs text-faint">Las claves cambian entre Cuerpos de Bomberos: confirma las dudosas.</p>
          <ul className="flex flex-col divide-y divide-line rounded-md border border-line">
            {analysis.codes_interpreted.map((c, i) => (
              <li key={`${c.code}-${i}`} className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2.5 py-1.5">
                <span className="font-mono text-sm font-semibold text-text">{c.code}</span>
                <span className="min-w-0 flex-1 text-sm text-text">{c.meaning}</span>
                <span className="flex items-center gap-1.5">
                  <ConfidenceMeter level={c.certainty} size="sm" />
                  {c.certainty === "low" && (
                    <Badge tone="warning" icon={TriangleAlert}>
                      verificar
                    </Badge>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

/** Resumen plegable del análisis de radio, con su estado, motor y antigüedad. */
export function AnalysisSummary({
  analysis,
  engine,
  updatedAt,
  pipeline,
  entryCount,
  knownSeqs,
  onSelectSeq,
  onReanalyze,
  reanalyzing = false,
}: AnalysisSummaryProps) {
  const busy = pipeline.comms_status === "running" || pipeline.comms_status === "pending";
  const reanalyzeButton =
    onReanalyze && entryCount > 0 ? (
      <Button
        size="sm"
        variant={pipeline.comms_status === "error" ? "secondary" : "ghost"}
        icon={RefreshCw}
        loading={reanalyzing}
        disabled={busy}
        onClick={onReanalyze}
        title={busy ? "El análisis de radio ya está en curso" : "Volver a analizar toda la bitácora"}
      >
        {pipeline.comms_status === "error" ? "Reintentar análisis" : "Reanalizar radio"}
      </Button>
    ) : null;
  const [open, setOpen] = useState(true);
  const bodyId = useId();
  const victimsTone = analysis ? (commsVictimsStatusTone[analysis.victims.status] ?? "info") : null;

  return (
    <div className="border-b border-line">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-surface-2"
      >
        <ChevronDown
          aria-hidden
          className={cn("size-4 shrink-0 text-muted transition-transform", !open && "-rotate-90")}
        />
        <span className="label-caps text-xs text-muted">Resumen de radio</span>
        <span className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1">
          {analysis?.mayday.active && (
            <Badge tone="critical" variant="solid" icon={Siren}>
              MAYDAY
            </Badge>
          )}
          {analysis && victimsTone && analysis.victims.status === "reported" && (
            <Badge tone={victimsTone} icon={PersonStanding}>
              Víctimas
            </Badge>
          )}
          {analysis && analysis.victims.status === "denied_by_unit" && (
            <Badge tone="ok" icon={CircleCheck}>
              Sin atrapados (unidad)
            </Badge>
          )}
          {engine === "simulated" && analysis && (
            <Badge tone="warning" icon={FlaskConical}>
              Simulado
            </Badge>
          )}
          {pipeline.comms_status === "running" && <Spinner size="xs" label="Analizando la radio" />}
          {pipeline.comms_status === "error" && (
            <Badge tone="critical" icon={CircleAlert}>
              Error
            </Badge>
          )}
        </span>
      </button>

      <div id={bodyId} hidden={!open} className="flex flex-col gap-2.5 px-3 pb-3">
        <PipelineLine pipeline={pipeline} />

        {analysis ? (
          <>
            {engine === "simulated" && <CommsSimulatedNotice />}
            <AnalysisBody analysis={analysis} knownSeqs={knownSeqs} onSelectSeq={onSelectSeq} />
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-faint">
              {updatedAt && (
                <span>
                  Actualizado <TimeAgo iso={updatedAt} />
                </span>
              )}
              {engine && <span>· {analysisEngineLabel[engine] ?? engine}</span>}
              <span>· Interpretación automática sin confianza global: confirma por radio lo crítico.</span>
            </p>
            {reanalyzeButton && <div className="flex justify-end">{reanalyzeButton}</div>}
          </>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <p className="min-w-0 flex-1 text-sm text-muted">
              {entryCount === 0
                ? "El análisis aparece cuando haya entradas de radio."
                : busy
                  ? "Aún no hay análisis: se está procesando la radio."
                  : pipeline.comms_status === "error"
                    ? "No hay análisis de radio disponible."
                    : "Aún no hay análisis de radio para estas entradas."}
            </p>
            {reanalyzeButton}
          </div>
        )}
      </div>
    </div>
  );
}
