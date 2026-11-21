"use client";

import { useCallback, useEffect, useId, useRef, useState, type DragEvent } from "react";
import { CircleAlert, CircleCheck, FileVideo, Images, RotateCw, Send, Square, Trash2, Upload, X } from "lucide-react";
import { Badge, Button, IconButton, ProgressBar, Textarea } from "@/components/ui";
import { cn } from "@/lib/cn";
import { formatBytes } from "@/lib/format";
import { LIMITS } from "@/lib/domain";
import { isSubmitReportError, submitReport } from "@/lib/client/upload";
import type { MediaUploaderProps } from "./types";
import {
  groupMandoFiles,
  mandoResultText,
  mandoStatusLabel,
  videoSizeNotice,
  type MandoItemStatus,
  type MediaKind,
} from "./report-core";

interface Item {
  id: string;
  kind: MediaKind;
  files: File[];
  status: MandoItemStatus;
  /** 0..1 */
  fraction: number;
  message: string;
  result: string | null;
  error: string | null;
  /** true si el error se puede reintentar. */
  retryable: boolean;
}

let itemSeq = 0;
const nextItemId = () => `item-${++itemSeq}`;

function toItems(list: File[]): { items: Item[]; ignored: number } {
  const { groups, ignored } = groupMandoFiles(list);
  const items = groups.map((g) => ({
    id: nextItemId(),
    kind: g.kind,
    files: g.files,
    status: "staged" as const,
    fraction: 0,
    message: "",
    result: null,
    error: null,
    retryable: true,
  }));
  return { items, ignored };
}

function itemTitle(item: Item): string {
  if (item.kind === "video") return item.files[0].name || "Video";
  return item.files.length === 1 ? item.files[0].name || "Foto" : `${item.files.length} fotos`;
}

const STATUS_TONE: Record<MandoItemStatus, "neutral" | "info" | "accent" | "ok" | "critical"> = {
  staged: "neutral",
  queued: "info",
  running: "accent",
  done: "ok",
  error: "critical",
};

/** Cargador compacto del puesto de mando: arrastrar y soltar, cola de archivos y progreso por archivo. */
export function MandoUploader({ incidentCode, typeHint, asResponder, onSubmitted, onDone, className }: MediaUploaderProps) {
  const uid = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [note, setNote] = useState("");
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const itemsRef = useRef<Item[]>([]);
  const controllerRef = useRef<AbortController | null>(null);
  const stopRef = useRef(false);
  const mountedRef = useRef(false);
  const callbacksRef = useRef({ onSubmitted, onDone });

  useEffect(() => {
    callbacksRef.current = { onSubmitted, onDone };
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopRef.current = true;
      controllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!running) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [running]);

  const commit = useCallback((next: Item[]) => {
    itemsRef.current = next;
    if (mountedRef.current) setItems(next);
  }, []);

  const patch = useCallback(
    (id: string, change: Partial<Item>) => {
      commit(itemsRef.current.map((it) => (it.id === id ? { ...it, ...change } : it)));
    },
    [commit],
  );

  const addFiles = (list: File[]) => {
    if (list.length === 0) return;
    const { items: added, ignored } = toItems(list);
    setNotice(
      ignored > 0
        ? ignored === 1
          ? "Un archivo no era video ni foto y se dejó fuera."
          : `${ignored} archivos no eran video ni foto y se dejaron fuera.`
        : null,
    );
    if (added.length > 0) commit([...itemsRef.current, ...added]);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    if (running) return;
    addFiles(Array.from(e.dataTransfer.files ?? []));
  };

  const runQueue = async () => {
    if (controllerRef.current || running) return;
    const pending = itemsRef.current.filter((it) => it.status === "staged" || (it.status === "error" && it.retryable));
    if (pending.length === 0) return;
    stopRef.current = false;
    setNotice(null);
    setRunning(true);
    commit(
      itemsRef.current.map((it) =>
        pending.some((p) => p.id === it.id) ? { ...it, status: "queued", error: null, fraction: 0, message: "" } : it,
      ),
    );

    for (const target of pending) {
      if (stopRef.current) break;
      const controller = new AbortController();
      controllerRef.current = controller;
      patch(target.id, { status: "running", message: "Preparando…" });
      let notified = false;
      const notify = (r: { mediaId: string; incidentCode: string; createdIncident: boolean }) => {
        if (notified) return;
        notified = true;
        callbacksRef.current.onSubmitted?.(r);
      };
      try {
        const result = await submitReport({
          ...(target.kind === "video" ? { file: target.files[0] } : { files: target.files }),
          kind: target.kind,
          incidentCode,
          typeHint,
          note,
          position: null,
          heading: null,
          capturedAt: null,
          asResponder,
          signal: controller.signal,
          onProgress: (p) => patch(target.id, { fraction: p.fraction, message: p.message }),
          onFramesUploaded: (info) => notify(info),
        });
        notify(result);
        patch(target.id, {
          status: "done",
          fraction: 1,
          message: "",
          result: mandoResultText({
            kind: target.kind,
            incidentCode: result.incidentCode,
            framesSent: result.framesSent,
            video: result.video,
            framesUnsupported: result.framesUnsupported,
          }),
        });
      } catch (err) {
        const e = isSubmitReportError(err) ? err : null;
        const aborted = e?.code === "aborted";
        if (e?.framesDelivered) {
          // El análisis ya tiene los fotogramas; solo faltó el video original.
          patch(target.id, {
            status: "done",
            fraction: 1,
            message: "",
            result: `Análisis en curso · ${aborted ? "subida del video original detenida" : "el video original no subió"}`,
          });
        } else {
          patch(target.id, {
            status: "error",
            message: "",
            retryable: e ? e.retryable || aborted : true,
            error: aborted ? "Envío detenido." : (e?.message ?? "No se pudo enviar el archivo."),
          });
        }
      } finally {
        if (controllerRef.current === controller) controllerRef.current = null;
      }
    }

    // Lo que quedó en cola al detener vuelve a "listo para enviar".
    commit(itemsRef.current.map((it) => (it.status === "queued" ? { ...it, status: "staged" } : it)));
    if (mountedRef.current) setRunning(false);
    callbacksRef.current.onDone?.();
  };

  const stop = () => {
    stopRef.current = true;
    controllerRef.current?.abort();
  };

  const remove = (id: string) => commit(itemsRef.current.filter((it) => it.id !== id));
  const clearFinished = () => commit(itemsRef.current.filter((it) => it.status !== "done"));

  const sendableItems = items.filter((it) => it.status === "staged" || (it.status === "error" && it.retryable));
  const sendable = sendableItems.length;
  const sendableFiles = sendableItems.reduce((acc, it) => acc + it.files.length, 0);
  const finished = items.filter((it) => it.status === "done").length;
  const missingCode = !incidentCode;

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <div
        onDragEnter={(e) => {
          e.preventDefault();
          if (!running) setDragging(true);
        }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          setDragging(false);
        }}
        onDrop={onDrop}
        className={cn(
          "flex flex-col items-center gap-2 rounded-lg border-2 border-dashed px-4 py-6 text-center transition-colors",
          dragging ? "border-accent bg-accent-soft" : "border-line-strong bg-surface-2",
        )}
      >
        <Upload aria-hidden className={cn("size-7", dragging ? "text-accent" : "text-muted")} />
        <p className="text-sm font-semibold text-text">Arrastra aquí videos o fotos</p>
        <p className="text-xs text-muted">
          Cada video queda como un medio; las fotos de una misma tanda, como uno solo (hasta {LIMITS.MAX_FRAMES_PER_MEDIA}).
        </p>
        <input
          ref={inputRef}
          id={`${uid}-files`}
          type="file"
          accept="video/*,image/*"
          multiple
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            const list = Array.from(e.target.files ?? []);
            e.target.value = "";
            addFiles(list);
          }}
        />
        <Button size="sm" icon={FileVideo} onClick={() => inputRef.current?.click()} disabled={running} className="mt-1">
          Elegir archivos
        </Button>
      </div>

      {notice && (
        <p role="status" className="flex items-start gap-2 text-xs text-warning">
          <CircleAlert aria-hidden className="mt-px size-4 shrink-0" />
          <span>{notice}</span>
        </p>
      )}

      {items.length > 0 && (
        <ul aria-label="Archivos" className="flex flex-col divide-y divide-line rounded-lg border border-line bg-surface">
          {items.map((item) => {
            const Icon = item.kind === "video" ? FileVideo : Images;
            const size = item.files.reduce((acc, f) => acc + f.size, 0);
            const tooBig = item.kind === "video" ? videoSizeNotice(item.files[0].size) : null;
            return (
              <li key={item.id} className="flex flex-col gap-1.5 px-3 py-2.5">
                <div className="flex items-center gap-2.5">
                  <Icon aria-hidden className="size-4 shrink-0 text-muted" />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-text" title={itemTitle(item)}>
                    {itemTitle(item)}
                  </span>
                  <span className="shrink-0 font-mono text-xs text-muted tabular">{formatBytes(size)}</span>
                  <Badge
                    tone={STATUS_TONE[item.status]}
                    size="sm"
                    icon={item.status === "done" ? CircleCheck : undefined}
                    className="shrink-0"
                  >
                    {mandoStatusLabel(item.status)}
                  </Badge>
                  {(item.status === "staged" || item.status === "error") && !running && (
                    <IconButton icon={X} label={`Quitar ${itemTitle(item)}`} size="sm" onClick={() => remove(item.id)} />
                  )}
                </div>
                {item.status === "running" && (
                  <div className="flex flex-col gap-1">
                    <ProgressBar value={item.fraction} size="sm" showValue label={`Avance de ${itemTitle(item)}`} />
                    {item.message && <p className="text-xs text-muted">{item.message}</p>}
                  </div>
                )}
                {item.status === "done" && item.result && <p className="text-xs text-muted">{item.result}</p>}
                {item.status === "error" && item.error && (
                  <p role="alert" className="flex items-start gap-1.5 text-xs text-critical">
                    <CircleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
                    <span>{item.error}</span>
                  </p>
                )}
                {item.status === "staged" && tooBig && <p className="text-xs text-warning">{tooBig}</p>}
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex flex-col gap-1">
        <label htmlFor={`${uid}-note`} className="text-xs font-semibold text-muted">
          Nota para el análisis <span className="font-normal">(opcional; se aplica a todos los archivos)</span>
        </label>
        <Textarea
          id={`${uid}-note`}
          value={note}
          onChange={(e) => setNote(e.target.value.slice(0, LIMITS.MAX_NOTE_CHARS))}
          maxLength={LIMITS.MAX_NOTE_CHARS}
          rows={2}
          autoGrow
          maxRows={5}
          disabled={running}
          placeholder="Ej.: llegó por WhatsApp de un vecino; grabado desde la vereda norte"
        />
      </div>

      {missingCode && (
        <p role="alert" className="flex items-start gap-2 text-xs text-critical">
          <CircleAlert aria-hidden className="mt-px size-4 shrink-0" />
          <span>Falta el código del incidente: no se puede adjuntar el medio.</span>
        </p>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2">
        {finished > 0 && !running && (
          <Button size="sm" variant="ghost" icon={Trash2} onClick={clearFinished} className="mr-auto">
            Quitar enviados
          </Button>
        )}
        {running ? (
          <Button size="md" variant="danger" icon={Square} onClick={stop}>
            Detener
          </Button>
        ) : (
          <Button
            size="md"
            variant="primary"
            icon={items.some((it) => it.status === "error") && sendable > 0 ? RotateCw : Send}
            disabled={sendable === 0 || missingCode}
            onClick={() => void runQueue()}
          >
            {sendable === 0
              ? "Enviar"
              : items.some((it) => it.status === "error") && !items.some((it) => it.status === "staged")
                ? "Reintentar"
                : `Enviar ${sendableFiles === 1 ? "1 archivo" : `${sendableFiles} archivos`}`}
          </Button>
        )}
      </div>
    </div>
  );
}
