"use client";

import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { CircleAlert, ClipboardPaste, ExternalLink, Info, Mic, MicOff, Send } from "lucide-react";
import { Badge, Button, Input, Textarea } from "@/components/ui";
import { cn } from "@/lib/cn";
import { createDictation, isDictationSupported, type Dictation } from "@/lib/client/speech";
import { UNTRANSCRIBED_COMM_TEXT } from "@/lib/labels";
import type { DraftComm } from "./comms-model";
import { PttButton, PttLive } from "./PushToTalk";
import { usePushToTalk, type PttTransmission } from "./use-push-to-talk";

/** Límites de AddCommInputSchema. */
const MAX_TEXT = 2000;
const MAX_SPEAKER = 60;
const MAX_CHANNEL = 40;
/** Emisor de las frases dictadas cuando no se eligió uno. */
const DICTATION_DEFAULT_SPEAKER = "Radio";

export interface ComposerProps {
  speakerOptions: string[];
  channelOptions: string[];
  onSend: (draft: DraftComm) => void;
  onOpenImport: () => void;
  /** Enlace a la radio de demostración sin sesión (/radio/<código>); null si está apagada. */
  demoRadioHref?: string | null;
  className?: string;
}

const noopSubscribe = () => () => {};
const serverSupport = (): boolean | null => null;

/** Redacción rápida (Enter envía), dictado en vivo de la radio y botón de radio con el micrófono. */
export function Composer({ speakerOptions, channelOptions, onSend, onOpenImport, demoRadioHref = null, className }: ComposerProps) {
  const baseId = useId();
  const speakerListId = `${baseId}-speakers`;
  const channelListId = `${baseId}-channels`;
  const textId = `${baseId}-text`;
  const hintId = `${baseId}-hint`;

  const [speaker, setSpeaker] = useState("");
  const [channel, setChannel] = useState("");
  const [text, setText] = useState("");
  const textRef = useRef<HTMLTextAreaElement | null>(null);

  // null en el servidor y al hidratar: no se afirma soporte ni falta de soporte antes de saberlo.
  const supported = useSyncExternalStore<boolean | null>(noopSubscribe, isDictationSupported, serverSupport);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [dictationError, setDictationError] = useState<string | null>(null);
  const dictationRef = useRef<Dictation | null>(null);

  // Las frases dictadas usan el emisor y canal vigentes al momento de oírlas.
  const latest = useRef({ speaker, channel, onSend });
  useEffect(() => {
    latest.current = { speaker, channel, onSend };
  }, [speaker, channel, onSend]);

  useEffect(() => () => dictationRef.current?.abort(), []);

  // Botón de radio: cada transmisión hablada (audio + transcripción) se envía al soltar.
  const onPtt = useCallback((t: PttTransmission) => {
    const { speaker: sp, channel: ch, onSend: send } = latest.current;
    send({
      text: (t.text || UNTRANSCRIBED_COMM_TEXT).slice(0, MAX_TEXT),
      speaker: sp.trim() || DICTATION_DEFAULT_SPEAKER,
      channel: ch.trim(),
      source: "dictation",
      at: t.at,
      audio: t.audio,
    });
  }, []);
  const ptt = usePushToTalk(onPtt, { disabled: listening });
  const pttActive = ptt.state.status !== "idle";

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

  const getDictation = (): Dictation => {
    if (!dictationRef.current) {
      dictationRef.current = createDictation({
        lang: "es-CL",
        onFinal: (phrase) => {
          const clean = phrase.trim().slice(0, MAX_TEXT);
          if (!clean) return;
          const { speaker: sp, channel: ch, onSend: send } = latest.current;
          send({ text: clean, speaker: sp.trim() || DICTATION_DEFAULT_SPEAKER, channel: ch.trim(), source: "dictation" });
        },
        onInterim: setInterim,
        onError: (err) => setDictationError(err.message),
        onEnd: () => {
          setListening(false);
          setInterim("");
        },
      });
    }
    return dictationRef.current;
  };

  const toggleListening = () => {
    const d = getDictation();
    if (listening) {
      d.stop();
      return;
    }
    setDictationError(null);
    if (d.start()) setListening(true);
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

      {listening && (
        <div className="flex flex-col gap-1.5 rounded-md border border-accent/40 bg-accent-soft px-2.5 py-2" role="status">
          <div className="flex items-center gap-2">
            <Badge tone="accent" variant="solid" pulse size="md">
              Escuchando
            </Badge>
            <span className="min-w-0 truncate text-xs text-muted">
              Emisor: <strong className="text-text">{speaker.trim() || DICTATION_DEFAULT_SPEAKER}</strong>
              {channel.trim() ? ` · ${channel.trim()}` : ""}
            </span>
          </div>
          <p className="min-h-5 text-sm text-text italic" aria-live="polite">
            {interim || <span className="text-faint not-italic">Habla cerca del parlante de la radio…</span>}
          </p>
          <p className="flex items-start gap-1.5 text-xs text-muted">
            <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            El dictado puede equivocarse: cada frase queda rotulada «dictado». Confirma lo crítico.
          </p>
        </div>
      )}

      {ptt.state.status === "recording" && (
        <PttLive
          state={ptt.state}
          who={`${speaker.trim() || DICTATION_DEFAULT_SPEAKER}${channel.trim() ? ` · ${channel.trim()}` : ""}`}
          dictation={supported === true}
        />
      )}
      {(ptt.state.error || ptt.state.hint) && (
        <p className={cn("flex items-start gap-1.5 text-xs", ptt.state.error ? "text-critical" : "text-muted")} role={ptt.state.error ? "alert" : undefined}>
          {ptt.state.error ? <CircleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" /> : <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />}
          {ptt.state.error ?? ptt.state.hint}
        </p>
      )}

      {dictationError && (
        <p className="flex items-start gap-1.5 text-xs text-critical" role="alert">
          <CircleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          {dictationError}
        </p>
      )}
      {supported === false && !dictationError && (
        <p className="flex items-start gap-1.5 text-xs text-muted">
          <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          Este navegador no permite dictar por voz. Para «Escuchar radio» usa Chrome; mientras, escribe o importa.
        </p>
      )}

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
          <Button
            size="sm"
            variant={listening ? "danger" : "secondary"}
            icon={listening ? MicOff : Mic}
            onClick={toggleListening}
            disabled={supported !== true || pttActive}
            aria-pressed={listening}
            title={supported === false ? "Este navegador no permite dictar; prueba con Chrome" : undefined}
          >
            {listening ? "Dejar de escuchar" : "Escuchar radio"}
          </Button>
          <PttButton state={ptt.state} buttonProps={ptt.buttonProps} disabled={listening} />
          <Button size="sm" variant="secondary" icon={ClipboardPaste} onClick={onOpenImport}>
            Importar
          </Button>
        </span>
      </div>
      {demoRadioHref && (
        <a
          href={demoRadioHref}
          target="_blank"
          rel="noopener"
          className="flex items-center gap-1.5 self-start text-xs text-accent hover:underline"
        >
          <ExternalLink aria-hidden className="size-3.5" />
          Radio sin sesión para la demo (ábrela en el teléfono)
        </a>
      )}
    </div>
  );
}
