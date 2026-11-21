"use client";

import { useId, useRef, useState, type KeyboardEvent } from "react";
import { ClipboardPaste, Send } from "lucide-react";
import { Button, Input, Textarea } from "@/components/ui";
import { cn } from "@/lib/cn";
import type { DraftComm } from "./comms-model";

/** Límites de AddCommInputSchema. */
const MAX_TEXT = 2000;
const MAX_SPEAKER = 60;
const MAX_CHANNEL = 40;

export interface ComposerProps {
  speakerOptions: string[];
  channelOptions: string[];
  onSend: (draft: DraftComm) => void;
  onOpenImport: () => void;
  className?: string;
}

/**
 * Redacción rápida (Enter envía) e importación. Las transmisiones habladas ya no se
 * capturan en la página: entran desde el canal de Zello en el servidor.
 */
export function Composer({ speakerOptions, channelOptions, onSend, onOpenImport, className }: ComposerProps) {
  const baseId = useId();
  const speakerListId = `${baseId}-speakers`;
  const channelListId = `${baseId}-channels`;
  const textId = `${baseId}-text`;
  const hintId = `${baseId}-hint`;

  const [speaker, setSpeaker] = useState("");
  const [channel, setChannel] = useState("");
  const [text, setText] = useState("");
  const textRef = useRef<HTMLTextAreaElement | null>(null);

  const trimmed = text.trim();
  const tooLong = trimmed.length > MAX_TEXT;

  const submit = () => {
    if (!trimmed || tooLong) return;
    onSend({ text: trimmed, speaker: speaker.trim(), channel: channel.trim(), source: "manual" });
    setText("");
    textRef.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  };

  return (
    <div className={cn("flex flex-col gap-2 border-t border-line bg-surface px-3 py-2.5", className)}>
      <datalist id={speakerListId}>
        {speakerOptions.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
      <datalist id={channelListId}>
        {channelOptions.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>

      <div className="grid grid-cols-2 gap-2">
        <label className="flex min-w-0 flex-col gap-1">
          <span className="label-caps text-[11px] text-muted">Emisor</span>
          <Input
            list={speakerListId}
            value={speaker}
            onChange={(e) => setSpeaker(e.target.value)}
            maxLength={MAX_SPEAKER}
            placeholder="B-3, Central…"
            autoComplete="off"
          />
        </label>
        <label className="flex min-w-0 flex-col gap-1">
          <span className="label-caps text-[11px] text-muted">Canal</span>
          <Input
            list={channelListId}
            value={channel}
            onChange={(e) => setChannel(e.target.value)}
            maxLength={MAX_CHANNEL}
            placeholder="Canal 1"
            autoComplete="off"
          />
        </label>
      </div>

      <div className="flex items-end gap-2">
        <label htmlFor={textId} className="sr-only">
          Mensaje de radio
        </label>
        <Textarea
          id={textId}
          ref={textRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
          autoGrow
          maxRows={6}
          invalid={tooLong}
          aria-describedby={hintId}
          placeholder="Lo que se escucha por radio…"
          className="flex-1"
        />
        <Button variant="primary" icon={Send} onClick={submit} disabled={!trimmed || tooLong}>
          Enviar
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <p id={hintId} className={cn("text-xs", tooLong ? "text-critical" : "text-faint")}>
          {tooLong
            ? `Máximo ${MAX_TEXT} caracteres (llevas ${trimmed.length}).`
            : "Enter envía · Shift+Enter salto de línea"}
        </p>
        <span className="ml-auto flex gap-1.5">
          <Button size="sm" variant="secondary" icon={ClipboardPaste} onClick={onOpenImport}>
            Importar
          </Button>
        </span>
      </div>
    </div>
  );
}
