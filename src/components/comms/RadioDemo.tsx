"use client";

import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { CircleAlert, CircleCheck, Info, RotateCcw } from "lucide-react";
import { Badge, Button, Input, Spinner } from "@/components/ui";
import { errorFromResponse, errorMessage } from "@/lib/client/api";
import { isDictationSupported } from "@/lib/client/speech";
import type { PublicIncident } from "@/lib/contract";
import { formatClock } from "@/lib/format";
import { incidentTypeLabel, UNTRANSCRIBED_COMM_TEXT } from "@/lib/labels";
import { PttButton, PttLive } from "./PushToTalk";
import { usePushToTalk, type PttTransmission } from "./use-push-to-talk";

const SPEAKER_KEY = "vigia-radio-speaker";
const CHANNEL_KEY = "vigia-radio-channel";
const SPEAKER_SUGGESTIONS = ["B-1", "B-3", "RX-4", "Q-2", "OBAC", "Central"];

interface Sent {
  localId: number;
  tx: PttTransmission;
  speaker: string;
  channel: string;
  status: "sending" | "sent" | "failed";
  seq: number | null;
  error: string | null;
}

function readPref(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* sin almacenamiento: no se recuerda */
  }
}

const noopSubscribe = () => () => {};
const serverSupport = (): boolean | null => null;

/** Radio de demostración: apretar para hablar y cada transmisión entra a la bitácora del incidente. */
export function RadioDemo({ incident }: { incident: PublicIncident }) {
  const baseId = useId();
  const [speaker, setSpeaker] = useState("B-1");
  const [channel, setChannel] = useState("5-2");
  // Preferencias recordadas en este teléfono: se leen recién hidratado, para no desalinear el HTML del servidor.
  const hydrated = useSyncExternalStore(noopSubscribe, () => true, () => false);
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  if (hydrated && !prefsLoaded) {
    setPrefsLoaded(true);
    setSpeaker(readPref(SPEAKER_KEY, "B-1"));
    setChannel(readPref(CHANNEL_KEY, "5-2"));
  }
  const dictation = useSyncExternalStore<boolean | null>(noopSubscribe, isDictationSupported, serverSupport);

  const [sent, setSent] = useState<Sent[]>([]);
  const counter = useRef(0);
  const latest = useRef({ speaker, channel });
  useEffect(() => {
    latest.current = { speaker, channel };
  }, [speaker, channel]);

  const deliver = useCallback(
    async (item: Sent) => {
      const form = new FormData();
      form.set("text", item.tx.text);
      form.set("speaker", item.speaker);
      form.set("channel", item.channel);
      if (item.tx.audio) {
        const ext = item.tx.audio.type.includes("ogg") ? "ogg" : item.tx.audio.type.includes("mp4") ? "m4a" : "webm";
        form.set("audio", item.tx.audio, `transmision.${ext}`);
      }
      try {
        const res = await fetch(`/api/public/incidents/${encodeURIComponent(incident.code)}/radio`, {
          method: "POST",
          body: form,
          cache: "no-store",
        });
        if (!res.ok) throw await errorFromResponse(res);
        const { seq } = (await res.json()) as { seq: number };
        setSent((list) => list.map((x) => (x.localId === item.localId ? { ...x, status: "sent", seq, error: null } : x)));
      } catch (err) {
        const message = errorMessage(err);
        setSent((list) => list.map((x) => (x.localId === item.localId ? { ...x, status: "failed", error: message } : x)));
      }
    },
    [incident.code],
  );

  const onTransmission = useCallback(
    (tx: PttTransmission) => {
      counter.current += 1;
      const item: Sent = {
        localId: counter.current,
        tx,
        speaker: latest.current.speaker.trim() || "Radio",
        channel: latest.current.channel.trim(),
        status: "sending",
        seq: null,
        error: null,
      };
      setSent((list) => [item, ...list]);
      void deliver(item);
    },
    [deliver],
  );

  const retry = (item: Sent) => {
    setSent((list) => list.map((x) => (x.localId === item.localId ? { ...x, status: "sending", error: null } : x)));
    void deliver(item);
  };

  const ptt = usePushToTalk(onTransmission);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <p className="label-caps text-xs text-muted">
          Radio · {incidentTypeLabel[incident.type]} · <span className="font-mono">{incident.code}</span>
        </p>
        <h1 className="mt-1 text-xl font-semibold text-text">{incident.title}</h1>
        {incident.address && <p className="text-sm text-muted">{incident.address}</p>}
      </div>

      <p className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-sm text-text">
        <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
        <span>
          Radio de demostración. Lo que digas se graba, se transcribe y entra a la bitácora de radio del mando como
          transmisión dictada. Puedes usar claves y sectores: «B-1 6-3, fuego en sector Charlie».
        </span>
      </p>

      <div className="grid grid-cols-2 gap-3">
        <label className="flex min-w-0 flex-col gap-1">
          <span className="label-caps text-[11px] text-muted">Quién habla</span>
          <Input
            list={`${baseId}-speakers`}
            value={speaker}
            onChange={(e) => {
              setSpeaker(e.target.value);
              writePref(SPEAKER_KEY, e.target.value);
            }}
            maxLength={60}
            placeholder="B-1, OBAC…"
            autoComplete="off"
          />
          <datalist id={`${baseId}-speakers`}>
            {SPEAKER_SUGGESTIONS.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </label>
        <label className="flex min-w-0 flex-col gap-1">
          <span className="label-caps text-[11px] text-muted">Canal</span>
          <Input
            value={channel}
            onChange={(e) => {
              setChannel(e.target.value);
              writePref(CHANNEL_KEY, e.target.value);
            }}
            maxLength={40}
            placeholder="5-2"
            autoComplete="off"
          />
        </label>
      </div>

      <div className="flex flex-col items-center gap-3 py-2">
        <PttButton state={ptt.state} buttonProps={ptt.buttonProps} size="large" />
        <p className="text-center text-xs text-muted">
          Mantén apretado y habla; suelta para enviar. Un toque corto la deja abierta y el siguiente toque la envía.
        </p>
      </div>

      {ptt.state.status === "recording" && (
        <PttLive
          state={ptt.state}
          who={`${speaker.trim() || "Radio"}${channel.trim() ? ` · Canal ${channel.trim()}` : ""}`}
          dictation={dictation !== false}
        />
      )}
      {(ptt.state.error || ptt.state.hint) && (
        <p className={ptt.state.error ? "flex items-start gap-1.5 text-sm text-critical" : "flex items-start gap-1.5 text-sm text-muted"} role={ptt.state.error ? "alert" : undefined}>
          {ptt.state.error ? <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" /> : <Info aria-hidden className="mt-0.5 size-4 shrink-0" />}
          {ptt.state.error ?? ptt.state.hint}
        </p>
      )}
      {dictation === false && (
        <p className="flex items-start gap-1.5 text-xs text-muted">
          <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          Este navegador no transcribe la voz: se enviará solo la grabación. Para que el mando reciba el texto, usa Chrome.
        </p>
      )}

      {sent.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-text">Transmisiones</h2>
          <ol className="flex flex-col divide-y divide-line rounded-md border border-line bg-surface">
            {sent.map((item) => (
              <li key={item.localId} className="flex flex-col gap-1 px-3 py-2">
                <div className="flex items-center gap-2 text-xs">
                  {item.seq !== null && <span className="font-mono font-semibold text-accent">C{item.seq}</span>}
                  <time dateTime={item.tx.at} suppressHydrationWarning className="font-mono text-muted tabular">
                    {formatClock(item.tx.at)}
                  </time>
                  <span className="font-semibold text-text">{item.speaker}</span>
                  {item.channel && <span className="text-muted">· {item.channel}</span>}
                  <span className="ml-auto">
                    {item.status === "sending" ? (
                      <span className="flex items-center gap-1 text-muted">
                        <Spinner size="xs" label="" /> Enviando…
                      </span>
                    ) : item.status === "sent" ? (
                      <Badge tone="ok" icon={CircleCheck}>
                        En la bitácora
                      </Badge>
                    ) : (
                      <Badge tone="critical">No se envió</Badge>
                    )}
                  </span>
                </div>
                <p className="text-sm text-text">{item.tx.text || <span className="text-muted italic">{UNTRANSCRIBED_COMM_TEXT}</span>}</p>
                {item.status === "failed" && (
                  <div className="flex items-center gap-2">
                    <p className="min-w-0 flex-1 text-xs text-critical">{item.error}</p>
                    <Button size="sm" variant="secondary" icon={RotateCcw} onClick={() => retry(item)}>
                      Reintentar
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}
