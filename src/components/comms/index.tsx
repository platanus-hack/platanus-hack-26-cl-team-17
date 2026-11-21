"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ClipboardPaste, Mic, PenLine, RadioTower } from "lucide-react";
import { Badge, EmptyState, Panel, useToast } from "@/components/ui";
import { cn } from "@/lib/cn";
import { api, errorMessage } from "@/lib/client/api";
import type { CommEntry } from "@/lib/domain";
import { AnalysisSummary, MaydayBanner } from "./AnalysisSummary";
import { CommsLog, type LogFocus } from "./CommsLog";
import { Composer } from "./Composer";
import { ImportDialog } from "./ImportDialog";
import {
  channelSuggestions,
  mergeEntries,
  speakerSuggestions,
  tagsBySeq,
  type DraftComm,
  type PendingComm,
} from "./comms-model";
import type { CommsPanelProps } from "./types";

export type { CommsPanelProps } from "./types";

function CommsEmpty() {
  return (
    <EmptyState
      icon={RadioTower}
      title="Sin comunicaciones registradas"
      description={
        <ul className="mt-2 flex flex-col gap-2 text-left">
          <li className="flex items-start gap-2">
            <PenLine aria-hidden className="mt-0.5 size-4 shrink-0 text-muted" />
            <span>
              <strong className="text-text">Escribe</strong> abajo lo que se escucha por radio, con su emisor.
              Enter envía.
            </span>
          </li>
          <li className="flex items-start gap-2">
            <Mic aria-hidden className="mt-0.5 size-4 shrink-0 text-muted" />
            <span>
              <strong className="text-text">Dicta</strong> con «Escuchar radio»: cada frase queda como entrada
              rotulada «dictado».
            </span>
          </li>
          <li className="flex items-start gap-2">
            <ClipboardPaste aria-hidden className="mt-0.5 size-4 shrink-0 text-muted" />
            <span>
              <strong className="text-text">Importa</strong> una transcripción pegada, p. ej.{" "}
              <code className="font-mono text-xs">21:14 B-3: en el lugar…</code>
            </span>
          </li>
        </ul>
      }
    />
  );
}

/** Panel de comunicaciones del puesto de mando: análisis de radio, bitácora, redacción, dictado e importación. */
export function CommsPanel({
  incidentId,
  comms,
  analysis,
  engine,
  analysisUpdatedAt,
  pipeline,
  onChanged,
  highlightSeq = null,
  className,
}: CommsPanelProps) {
  // Entradas ya guardadas que el snapshot aún no trae, y entradas en vuelo o fallidas.
  const [confirmed, setConfirmed] = useState<CommEntry[]>([]);
  const [pending, setPending] = useState<PendingComm[]>([]);
  const [importOpen, setImportOpen] = useState(false);

  const entries = useMemo(
    () => mergeEntries(comms, confirmed.filter((e) => e.incident_id === incidentId)),
    [comms, confirmed, incidentId],
  );
  const visiblePending = useMemo(() => pending.filter((p) => p.incidentId === incidentId), [pending, incidentId]);
  const knownSeqs = useMemo(() => new Set(entries.map((e) => e.seq)), [entries]);
  const tags = useMemo(() => tagsBySeq(analysis), [analysis]);
  const speakers = useMemo(() => speakerSuggestions(analysis, entries), [analysis, entries]);
  const channels = useMemo(() => channelSuggestions(entries), [entries]);

  // Foco pedido desde fuera (highlightSeq) o desde un chip "C12" del resumen.
  const [focus, setFocus] = useState<LogFocus>({ seq: highlightSeq, nonce: highlightSeq === null ? 0 : 1 });
  const [prevHighlight, setPrevHighlight] = useState(highlightSeq);
  if (highlightSeq !== prevHighlight) {
    setPrevHighlight(highlightSeq);
    if (highlightSeq !== null) setFocus((f) => ({ seq: highlightSeq, nonce: f.nonce + 1 }));
  }
  const selectSeq = useCallback((seq: number) => setFocus((f) => ({ seq, nonce: f.nonce + 1 })), []);

  const onChangedRef = useRef(onChanged);
  useEffect(() => {
    onChangedRef.current = onChanged;
  }, [onChanged]);

  // Una cola: las entradas (sobre todo las dictadas) llegan al servidor en el orden en que se dijeron.
  const queue = useRef<Promise<void>>(Promise.resolve());
  const localCounter = useRef(0);

  const deliver = useCallback((p: Pick<PendingComm, "localId" | "incidentId" | "input">) => {
    queue.current = queue.current.then(async () => {
      try {
        const { entry } = await api.comms.add(p.incidentId, p.input);
        setPending((list) => list.filter((x) => x.localId !== p.localId));
        setConfirmed((list) => [...list, entry]);
        onChangedRef.current();
      } catch (err) {
        const message = errorMessage(err);
        setPending((list) =>
          list.map((x): PendingComm => (x.localId === p.localId ? { ...x, status: "failed", error: message } : x)),
        );
      }
    });
  }, []);

  const send = useCallback(
    (input: DraftComm) => {
      localCounter.current += 1;
      const item: PendingComm = {
        localId: `local-${localCounter.current}`,
        incidentId,
        input,
        createdAt: new Date().toISOString(),
        status: "sending",
        error: null,
      };
      setPending((list) => [...list, item]);
      deliver(item);
    },
    [incidentId, deliver],
  );

  const retry = useCallback(
    (localId: string) => {
      const item = pending.find((p) => p.localId === localId);
      if (!item || item.status !== "failed") return;
      setPending((list) =>
        list.map((x): PendingComm => (x.localId === localId ? { ...x, status: "sending", error: null } : x)),
      );
      deliver(item);
    },
    [pending, deliver],
  );

  const discard = useCallback((localId: string) => {
    setPending((list) => list.filter((x) => x.localId !== localId));
  }, []);

  const onImported = useCallback((saved: CommEntry[]) => setConfirmed((list) => [...list, ...saved]), []);

  const { toast } = useToast();
  const [reanalyzing, setReanalyzing] = useState(false);
  const reanalyze = useCallback(async () => {
    setReanalyzing(true);
    try {
      await api.incidents.analyze(incidentId, { comms: true });
      onChangedRef.current();
      toast({ title: "Análisis de radio solicitado", tone: "info" });
    } catch (err) {
      toast({ title: "No se pudo pedir el análisis de radio", description: errorMessage(err), tone: "critical", duration: 8000 });
    } finally {
      setReanalyzing(false);
    }
  }, [incidentId, toast]);

  const failedCount = visiblePending.filter((p) => p.status === "failed").length;

  return (
    <Panel
      title="Radio"
      icon={RadioTower}
      tone={analysis?.mayday.active ? "critical" : "neutral"}
      badge={
        <span className="flex items-center gap-1">
          <Badge tone="neutral" className="tabular" title="Entradas en la bitácora">
            {entries.length}
          </Badge>
          {failedCount > 0 && (
            <Badge tone="critical" title="Entradas que no se guardaron">
              {failedCount} sin guardar
            </Badge>
          )}
        </span>
      }
      flush
      className={cn("flex h-full min-h-0 flex-col", className)}
      bodyClassName="flex min-h-0 flex-1 flex-col"
    >
      {analysis && <MaydayBanner analysis={analysis} knownSeqs={knownSeqs} onSelectSeq={selectSeq} />}

      <div className="max-h-[45%] shrink-0 overflow-y-auto">
        <AnalysisSummary
          analysis={analysis}
          engine={engine}
          updatedAt={analysisUpdatedAt}
          pipeline={pipeline}
          entryCount={entries.length}
          knownSeqs={knownSeqs}
          onSelectSeq={selectSeq}
          onReanalyze={() => void reanalyze()}
          reanalyzing={reanalyzing}
        />
      </div>

      <CommsLog
        className="flex-1"
        entries={entries}
        pending={visiblePending}
        tags={tags}
        focus={focus}
        onRetry={retry}
        onDiscard={discard}
        empty={<CommsEmpty />}
      />

      <Composer
        className="shrink-0"
        speakerOptions={speakers}
        channelOptions={channels}
        onSend={send}
        onOpenImport={() => setImportOpen(true)}
      />

      {importOpen && (
        <ImportDialog
          open
          onClose={() => setImportOpen(false)}
          incidentId={incidentId}
          defaultChannel={channels[0] ?? ""}
          onImported={onImported}
          onChanged={onChanged}
        />
      )}
    </Panel>
  );
}
