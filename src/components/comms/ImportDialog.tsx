"use client";

import { useId, useMemo, useState } from "react";
import { CircleAlert, ClipboardPaste, TriangleAlert } from "lucide-react";
import { Button, Dialog, Field, Input, Textarea, useToast } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import type { CommEntry } from "@/lib/domain";
import { pluralize } from "@/lib/format";
import { formatClockTime, parseTranscript, resolveEntryDates } from "./parse-transcript";

export interface ImportDialogProps {
  open: boolean;
  onClose: () => void;
  incidentId: string;
  /** Canal propuesto (el último usado en la bitácora). */
  defaultChannel: string;
  /** Entradas que el servidor ya guardó (se muestran sin esperar el siguiente sondeo). */
  onImported: (entries: CommEntry[]) => void;
  onChanged: () => void;
}

const PREVIEW_LIMIT = 200;
const EXAMPLE = "21:14 B-3: en el lugar, humo negro por ventanas del segundo piso\n21:15 Central: B-3, copiado\nRX-15: llegando";

/** Pegar una transcripción, revisar cómo se leyó y guardarla como entradas "importadas". */
export function ImportDialog({ open, onClose, incidentId, defaultChannel, onImported, onChanged }: ImportDialogProps) {
  const baseId = useId();
  const { toast } = useToast();
  const [text, setText] = useState("");
  const [channel, setChannel] = useState(defaultChannel);
  const [fallbackSpeaker, setFallbackSpeaker] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const parsed = useMemo(() => parseTranscript(text), [text]);
  const { entries, issues } = parsed;
  const count = entries.length;

  const close = () => {
    if (busy) return;
    setError(null);
    onClose();
  };

  const runImport = async () => {
    if (count === 0 || busy) return;
    setBusy(true);
    setError(null);
    setProgress(0);
    const dates = resolveEntryDates(entries, Date.now());
    const saved: CommEntry[] = [];
    let failedAt = -1;
    let failure = "";
    // En orden, una a una: así el seq del servidor respeta el orden de la transcripción.
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      try {
        const { entry } = await api.comms.add(incidentId, {
          text: e.text,
          speaker: e.speaker || fallbackSpeaker.trim(),
          channel: channel.trim(),
          source: "import",
          ...(dates[i] ? { at: dates[i] as string } : {}),
        });
        saved.push(entry);
        setProgress(i + 1);
      } catch (err) {
        failedAt = i;
        failure = errorMessage(err);
        break;
      }
    }
    if (saved.length > 0) {
      onImported(saved);
      onChanged();
    }
    setBusy(false);
    if (failedAt >= 0) {
      // Quedan en el cuadro solo las líneas no enviadas, para reintentar sin duplicar.
      setText(entries.slice(failedAt).map((e) => e.raw).join("\n"));
      setError(
        `Se ${saved.length === 1 ? "importó" : "importaron"} ${pluralize(saved.length, "entrada")} de ${count}. ` +
          `Falló la línea ${entries[failedAt].line}: ${failure} En el cuadro quedaron solo las que faltan.`,
      );
      return;
    }
    toast({ title: `Se ${count === 1 ? "importó" : "importaron"} ${pluralize(count, "entrada")}`, tone: "ok" });
    setText("");
    setProgress(0);
    onClose();
  };

  const textId = `${baseId}-text`;
  const channelId = `${baseId}-channel`;
  const speakerId = `${baseId}-speaker`;

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Importar transcripción de radio"
      description="Pega el texto: una entrada por línea. Revisa abajo cómo se leyó antes de importar."
      size="lg"
      dismissible={!busy}
      hideClose={busy}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={busy}>
            Cancelar
          </Button>
          <Button variant="primary" icon={ClipboardPaste} onClick={runImport} loading={busy} disabled={count === 0}>
            {count === 0 ? "Importar" : `Importar ${pluralize(count, "entrada")}`}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field
          label="Transcripción"
          htmlFor={textId}
          hint='Formatos: "21:14 B-3: texto", "21:14:05 Central: texto", "B-3: texto" o la línea sola.'
        >
          <Textarea
            id={textId}
            data-autofocus=""
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={7}
            placeholder={EXAMPLE}
            disabled={busy}
            className="font-mono text-xs"
          />
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Canal" htmlFor={channelId} optional>
            <Input
              id={channelId}
              value={channel}
              onChange={(e) => setChannel(e.target.value)}
              maxLength={40}
              placeholder="Canal 1"
              disabled={busy}
            />
          </Field>
          <Field label="Emisor para líneas sin emisor" htmlFor={speakerId} optional>
            <Input
              id={speakerId}
              value={fallbackSpeaker}
              onChange={(e) => setFallbackSpeaker(e.target.value)}
              maxLength={60}
              placeholder="Radio"
              disabled={busy}
            />
          </Field>
        </div>

        {busy && (
          <p className="text-sm text-info" role="status">
            Importando {progress + 1 > count ? count : progress + 1} de {count}…
          </p>
        )}
        {error && (
          <p className="flex items-start gap-2 rounded-md border border-critical/40 bg-critical-soft px-3 py-2 text-sm text-text" role="alert">
            <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-critical" />
            {error}
          </p>
        )}

        {text.trim() !== "" && (
          <section aria-label="Vista previa" className="flex flex-col gap-2">
            <h3 className="label-caps text-xs text-muted">
              Vista previa · {pluralize(count, "entrada")}
              {issues.length > 0 ? ` · ${pluralize(issues.length, "línea omitida", "líneas omitidas")}` : ""}
            </h3>
            {count > 0 && (
              <div className="max-h-64 overflow-y-auto rounded-md border border-line">
                <table className="w-full text-left text-sm">
                  <thead className="sticky top-0 bg-surface-2 text-xs text-muted">
                    <tr>
                      <th scope="col" className="px-2 py-1 font-medium">
                        Hora
                      </th>
                      <th scope="col" className="px-2 py-1 font-medium">
                        Emisor
                      </th>
                      <th scope="col" className="px-2 py-1 font-medium">
                        Texto
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {entries.slice(0, PREVIEW_LIMIT).map((e) => (
                      <tr key={e.line} className="align-top">
                        <td className="px-2 py-1 font-mono text-xs whitespace-nowrap text-muted tabular">
                          {e.time ? (
                            <>
                              {formatClockTime(e.time)}
                              {e.dayOffset > 0 && <span className="ml-1 text-warning">+{e.dayOffset} día</span>}
                            </>
                          ) : (
                            <span className="text-faint" title="Se usa la hora en que se importa">
                              sin hora
                            </span>
                          )}
                        </td>
                        <td className="px-2 py-1 font-mono text-xs whitespace-nowrap">
                          {e.speaker || (
                            <span className="text-faint">{fallbackSpeaker.trim() || "sin emisor"}</span>
                          )}
                        </td>
                        <td className="px-2 py-1 break-words text-text">{e.text}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {count > PREVIEW_LIMIT && (
                  <p className="border-t border-line px-2 py-1 text-xs text-muted">
                    … y {pluralize(count - PREVIEW_LIMIT, "entrada")} más.
                  </p>
                )}
              </div>
            )}
            {entries.some((e) => !e.time) && entries.some((e) => e.time) && (
              <p className="text-xs text-muted">Las líneas sin hora quedan con la hora en que se importan.</p>
            )}
            {issues.length > 0 && (
              <ul className="flex flex-col gap-1 text-xs text-warning">
                {issues.slice(0, 20).map((i) => (
                  <li key={i.line} className="flex items-start gap-1.5">
                    <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                    <span>
                      Línea {i.line}: {i.reason} <span className="font-mono text-faint">{i.raw}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-muted">
              Las horas se toman como de hoy (o de anoche si quedarían en el futuro). Cada entrada queda rotulada
              «importado».
            </p>
          </section>
        )}
      </div>
    </Dialog>
  );
}
