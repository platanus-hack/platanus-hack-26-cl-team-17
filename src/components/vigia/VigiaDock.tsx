"use client";

/**
 * Vigía en la mesa de mando: un integrante más, no un chat.
 *
 *  - Cuando Vigía dice algo, aparece UNA tarjeta abajo de la vista 3D (lo más urgente
 *    primero) y se va sola; una posible persona queda hasta que el OBAC la cierra.
 *  - En la esquina, un círculo naranjo que late cuando Vigía habla o piensa. Al tocarlo
 *    se ve su estado en una línea, lo que está haciendo y se le puede escribir.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { Bot, BotOff, CornerDownLeft, FileText, RadioTower, Send, Volume2, VolumeX, X } from "lucide-react";
import { Badge, CopyButton, IconButton, Spinner, useNow } from "@/components/ui";
import { cn } from "@/lib/cn";
import { errorMessage } from "@/lib/client/api";
import { formatClock } from "@/lib/format";
import { PRIORITY_RANK } from "@/lib/vigia/rules";
import type { VigiaKind, VigiaUtterance, VigiaView } from "@/lib/vigia/types";
import { runRadioDemo } from "./radio-demo";
import { sinIA } from "./sin-ia";
import { useVigia } from "./use-vigia";

/** Nombre de cada tipo de mensaje de Vigía (también lo usa la vista técnica). */
export const KIND_LABEL: Record<VigiaKind, string> = {
  presentacion: "Presentación",
  alerta: "Alerta",
  resumen: "Resumen de radio",
  respuesta: "Respuesta",
  pendiente: "Pendiente",
  contradiccion: "No calza",
  pedido_video: "Pedido de video",
  propuesta: "Propuesta de mensaje",
};

const CONFIDENCE_LABEL = { low: "confianza baja", medium: "confianza media", high: "confianza alta" } as const;

/** Al abrir la pantalla solo se muestra el último mensaje si es así de reciente. */
const FRESH_ON_OPEN_MS = 90_000;
/** Cuánto queda a la vista un mensaje (una posible persona no se va sola). */
const SHOW_MS: Record<string, number> = { propuesta: 30_000, default: 15_000 };
/** El círculo late este tiempo después de un mensaje hablado. */
const SPEAKING_MS = 8_000;

function rank(u: VigiaUtterance): number {
  if (u.priority === "persona") return 0;
  if (u.kind === "respuesta") return 0.5;
  return PRIORITY_RANK[u.priority];
}

/** Cola de mensajes por mostrar: los nuevos desde que se abrió la pantalla, lo más urgente primero. */
function useQueue(view: VigiaView | null) {
  const [base, setBase] = useState<number | null>(null);
  const [dismissed, setDismissed] = useState<Set<number>>(() => new Set());
  // Estado derivado: se fija una vez, con la primera respuesta (hora del servidor, no la del navegador).
  if (view && base === null) {
    const latest = view.utterances[0];
    const fresh = latest && Date.parse(view.server_time) - Date.parse(latest.at) < FRESH_ON_OPEN_MS;
    setBase(latest ? (fresh ? latest.seq - 1 : latest.seq) : 0);
  }
  const queue = useMemo(() => {
    if (!view || base === null) return [];
    return view.utterances
      .filter((u) => u.seq > base && !dismissed.has(u.seq))
      // Posible persona primero; después la respuesta a lo que preguntó el OBAC; luego por prioridad.
      .sort((a, c) => rank(a) - rank(c) || a.seq - c.seq);
  }, [view, base, dismissed]);
  const dismiss = useCallback((seq: number) => setDismissed((prev) => new Set(prev).add(seq)), []);
  return { queue, dismiss };
}

export interface VigiaDockProps {
  incidentId: string;
  className?: string;
  style?: CSSProperties;
}

export function VigiaDock({ incidentId, className, style }: VigiaDockProps) {
  const { view, send, sending, setSinIA } = useVigia(incidentId);
  const { queue, dismiss } = useQueue(view);
  const [composer, setComposer] = useState<{ replyTo: VigiaUtterance | null } | null>(null);
  const now = useNow(1000);
  const current = queue[0] ?? null;

  // Cada mensaje se va solo después de un rato, salvo una posible persona.
  useEffect(() => {
    if (!current || current.priority === "persona") return;
    // El detalle de la mesa puede ser largo: ~0,4 s por palabra, con el mínimo del tipo.
    const ms = Math.max(SHOW_MS[current.kind] ?? SHOW_MS.default, current.text.split(/\s+/).length * 400);
    const t = setTimeout(() => dismiss(current.seq), ms);
    return () => clearTimeout(t);
  }, [current, dismiss]);

  const lastSpoken = view?.utterances.find((u) => u.speak);
  const speaking = Boolean(lastSpoken && now !== null && now - Date.parse(lastSpoken.at) < SPEAKING_MS);
  const thinking = Boolean(view?.status.thinking);

  return (
    <div className={cn("pointer-events-none flex items-end gap-3", className)} style={style}>
      <div className="min-w-0 flex-1">
        {current ? (
          <MessageCard
            key={current.seq}
            u={current}
            more={queue.length - 1}
            engine={view?.engine ?? "claude"}
            onClose={() => dismiss(current.seq)}
            onReply={() => setComposer({ replyTo: current })}
          />
        ) : null}
      </div>

      <div className="pointer-events-auto relative shrink-0">
        {composer ? (
          <Composer
            incidentId={incidentId}
            view={view}
            replyTo={composer.replyTo}
            sending={sending}
            onSinIA={setSinIA}
            onClose={() => setComposer(null)}
            onSend={async (texto) => {
              await send(texto, composer.replyTo?.id ?? null);
              setComposer(null);
            }}
          />
        ) : null}
        <button
          type="button"
          onClick={() => setComposer((c) => (c ? null : { replyTo: null }))}
          aria-expanded={composer !== null}
          aria-label={`Vigía: ${view?.status.line ?? "en el puesto de mando"}. Escribirle a Vigía`}
          title={view?.status.line ?? "Vigía"}
          className="group relative flex size-12 items-center justify-center rounded-full bg-f-orange text-white shadow-[0_8px_24px_rgb(0_0_0/0.22)] outline-offset-2 transition-transform hover:scale-105"
        >
          {(speaking || thinking) && (
            <span aria-hidden className="absolute inset-0 animate-ping rounded-full bg-f-orange/60" />
          )}
          <span aria-hidden className="relative text-lg font-extrabold tracking-tight">
            V
          </span>
          {view?.silenced ? (
            <span aria-hidden className="absolute -top-1 -right-1 flex size-5 items-center justify-center rounded-full bg-surface text-muted ring-1 ring-line">
              <VolumeX className="size-3" />
            </span>
          ) : null}
          {sinIA(view) ? (
            <span aria-hidden className="absolute -bottom-1 -left-1 flex size-5 items-center justify-center rounded-full bg-warning text-white ring-2 ring-surface">
              <BotOff className="size-3" />
            </span>
          ) : null}
        </button>
      </div>
    </div>
  );
}

/* ───────────────────────────── Tarjeta ───────────────────────────── */

function MessageCard({
  u,
  more,
  engine,
  onClose,
  onReply,
}: {
  u: VigiaUtterance;
  more: number;
  engine: VigiaView["engine"];
  onClose: () => void;
  onReply: () => void;
}) {
  const person = u.priority === "persona";
  const risk = u.priority === "riesgo" || u.kind === "contradiccion";
  return (
    <article
      role={person ? "alert" : "status"}
      aria-label={`Vigía, ${KIND_LABEL[u.kind]}`}
      className={cn(
        "pointer-events-auto relative max-w-[720px] animate-enter rounded-2xl border bg-surface/97 p-3 pr-2 shadow-[0_12px_32px_rgb(0_0_0/0.18)] backdrop-blur",
        person ? "border-critical" : risk ? "border-warning/70" : "border-line-strong",
      )}
    >
      <div className="flex items-center gap-2 text-[13px] text-muted">
        <span aria-hidden className={cn("size-2.5 shrink-0 rounded-full bg-f-orange", u.speak && "animate-pulse")} />
        <span className="font-bold text-text">Vigía</span>
        <span>·</span>
        <span className={cn(person && "font-semibold text-critical", risk && !person && "font-semibold text-warning")}>
          {person ? "Posible persona" : KIND_LABEL[u.kind]}
        </span>
        <span>·</span>
        <time dateTime={u.at} className="tabular">
          {formatClock(u.at, { seconds: true })}
        </time>
        {u.speak ? (
          <span className="inline-flex items-center gap-1" title="Transmitido por radio (Zello)">
            <Volume2 aria-hidden className="size-3.5" />
            <span className="sr-only sm:not-sr-only">por radio</span>
          </span>
        ) : (
          <span className="hidden sm:inline">solo pantalla</span>
        )}
        {u.engine === "plantilla" || engine === "plantilla" ? (
          <Badge tone="warning" title="Respuesta por plantilla, sin IA">
            sin IA
          </Badge>
        ) : null}
        <span className="ml-auto flex items-center">
          {more > 0 ? <span className="mr-1 text-xs font-semibold">+{more}</span> : null}
          <IconButton icon={CornerDownLeft} label="Responder a Vigía" size="sm" onClick={onReply} />
          <IconButton icon={X} label="Cerrar mensaje" size="sm" onClick={onClose} />
        </span>
      </div>

      <p className="mt-1 pr-2 text-lg leading-snug font-medium text-text">{u.text}</p>

      {u.speak && u.radio && u.radio !== u.text ? (
        <p className="mt-1.5 flex items-start gap-1.5 pr-2 text-sm text-muted">
          <Volume2 aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span>
            <span className="sr-only">Por radio: </span>«{u.radio}»
          </span>
        </p>
      ) : null}

      {u.kind === "propuesta" && u.claves ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-xl bg-surface-2 p-2">
          <code className="min-w-0 flex-1 font-mono text-[15px] font-semibold text-text">{u.claves}</code>
          <CopyButton value={u.claves} label="Copiar mensaje con claves" copiedLabel="Copiado" size="sm" />
        </div>
      ) : null}

      {u.evidence.length > 0 || u.confidence ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted">
          {u.evidence.map((ref) => (
            <span key={ref} className="rounded-md bg-surface-2 px-1.5 py-0.5 font-mono font-semibold text-text ring-1 ring-line">
              {ref}
            </span>
          ))}
          {u.confidence ? <span>{CONFIDENCE_LABEL[u.confidence]}</span> : null}
          {u.rules.includes("ausencia") ? <span title="Regla dura aplicada">· «no hay» cambiado por «no veo»</span> : null}
        </div>
      ) : null}
    </article>
  );
}

/* ───────────────────────────── Escribirle a Vigía ───────────────────────────── */

function Composer({
  incidentId,
  view,
  replyTo,
  sending,
  onSinIA,
  onClose,
  onSend,
}: {
  incidentId: string;
  view: VigiaView | null;
  replyTo: VigiaUtterance | null;
  sending: boolean;
  onSinIA: (on: boolean) => Promise<void>;
  onClose: () => void;
  onSend: (texto: string) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);

  const submit = async (e?: FormEvent, preset?: string) => {
    e?.preventDefault();
    const value = (preset ?? text).trim();
    if (!value || sending) return;
    setError(null);
    try {
      await onSend(/^\s*vig[ií]a\b/i.test(value) ? value : `Vigía, ${value}`);
      setText("");
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const [demo, setDemo] = useState<"idle" | "running">("idle");
  const startDemo = async () => {
    if (demo === "running") return;
    setDemo("running");
    setError(null);
    try {
      await runRadioDemo(incidentId);
      // Las líneas entran durante ~20 s; el botón vuelve a estar disponible después.
      setTimeout(() => setDemo("idle"), 20_000);
    } catch (err) {
      setError(errorMessage(err));
      setDemo("idle");
    }
  };

  const [modeBusy, setModeBusy] = useState(false);
  const toggleSinIA = async () => {
    if (modeBusy) return;
    setModeBusy(true);
    setError(null);
    try {
      await onSinIA(!view?.ai_off);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setModeBusy(false);
    }
  };
  const noAI = sinIA(view);

  const actions = view?.actions.slice(0, 3) ?? [];
  const pending = view?.pending ?? [];

  return (
    <div
      role="dialog"
      aria-label="Escribirle a Vigía"
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
      className="absolute right-0 bottom-full mb-2 w-[min(380px,calc(100vw-32px))] animate-enter rounded-2xl border border-line-strong bg-surface p-3 shadow-[0_12px_32px_rgb(0_0_0/0.2)]"
    >
      <div className="flex items-start gap-2">
        <span aria-hidden className="mt-1 size-2.5 shrink-0 rounded-full bg-f-orange" />
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-bold">Vigía, en el puesto de mando</p>
          <p className="text-[13px] text-muted">{view?.status.line ?? "Conectando…"}</p>
        </div>
        {view?.status.thinking ? <Spinner size="xs" label="Vigía está pensando" /> : null}
        <IconButton icon={X} label="Cerrar" size="sm" onClick={onClose} />
      </div>

      {view?.silenced ? (
        <p className="mt-2 rounded-lg bg-surface-2 px-2 py-1 text-xs text-muted">
          En silencio: solo escribe en pantalla, salvo una posible persona. Escribe «puedes hablar» para que vuelva a la radio.
        </p>
      ) : null}

      {noAI ? (
        <p role="status" className="mt-2 rounded-lg border border-warning/40 bg-warning-soft px-2 py-1 text-xs text-text" title={noAI.detail}>
          <span className="font-semibold">{noAI.title}.</span> <span className="line-clamp-2 text-muted">{noAI.detail}</span>
        </p>
      ) : null}

      {actions.length > 0 ? (
        <div className="mt-2">
          <p className="text-xs font-semibold text-muted">Lo que estoy haciendo</p>
          <ul className="mt-1 flex flex-col gap-0.5 text-[13px]">
            {actions.map((a) => (
              <li key={a.id} className="flex gap-2">
                <time className="tabular shrink-0 text-faint" dateTime={a.at}>
                  {formatClock(a.at)}
                </time>
                <span className="min-w-0">{a.text}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {pending.length > 0 ? (
        <p className="mt-2 text-[13px]">
          <span className="font-semibold">Pendiente: </span>
          {pending.map((p) => p.text).join(" · ")}
        </p>
      ) : null}

      {replyTo ? (
        <p className="mt-2 line-clamp-2 border-l-2 border-f-orange pl-2 text-[13px] text-muted">
          Respondiendo a: {replyTo.text}
        </p>
      ) : null}

      <form onSubmit={submit} className="mt-2 flex items-center gap-2">
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={480}
          placeholder={replyTo ? "Tu respuesta…" : "¿Se ve alguien en el lado B?"}
          aria-label="Mensaje para Vigía"
          className="h-10 min-w-0 flex-1 rounded-full border border-line-strong bg-bg px-4 text-[15px] outline-none focus:border-text"
        />
        <IconButton icon={Send} label="Enviar a Vigía" variant="primary" type="submit" loading={sending} disabled={!text.trim()} />
      </form>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {["¿Qué tenemos?", view?.silenced ? "Puedes hablar" : "Silencio", "Arma el parte"].map((q) => (
          <button
            key={q}
            type="button"
            onClick={() => void submit(undefined, q)}
            className="rounded-full border border-line px-2.5 py-1 text-xs font-semibold transition-colors hover:bg-surface-2"
          >
            {q === "Arma el parte" ? (
              <span className="inline-flex items-center gap-1">
                <FileText aria-hidden className="size-3" />
                {q}
              </span>
            ) : (
              q
            )}
          </button>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <button
          type="button"
          onClick={() => void startDemo()}
          disabled={demo === "running"}
          className="inline-flex items-center gap-1 text-xs text-faint underline-offset-2 hover:text-muted hover:underline disabled:cursor-wait"
          title="Reproduce dos radios grabadas a la vez y las registra como simuladas"
        >
          <RadioTower aria-hidden className="size-3" />
          {demo === "running" ? "Demo en curso: dos radios…" : "Demo: dos radios a la vez"}
        </button>
        {/* Plan B si Claude anda lento o caído: un clic, sin redeploy. */}
        <button
          type="button"
          onClick={() => void toggleSinIA()}
          disabled={modeBusy || !view}
          aria-pressed={view?.ai_off ?? false}
          className={cn(
            "inline-flex items-center gap-1 text-xs underline-offset-2 hover:underline disabled:cursor-wait",
            view?.ai_off || noAI ? "font-semibold text-warning" : "text-faint hover:text-muted",
          )}
          title={
            view?.ai_off
              ? "Vigía vuelve a pensar con Claude; la fusión y la radio, también"
              : "Vigía responde con plantillas y la fusión y la radio de esta emergencia van por reglas, sin esperar a Claude"
          }
        >
          {view?.ai_off ? <Bot aria-hidden className="size-3" /> : <BotOff aria-hidden className="size-3" />}
          {modeBusy ? "Cambiando…" : view?.ai_off ? "Volver a usar IA" : "Vigía sin IA (plantillas)"}
        </button>
      </div>
      {view?.parte ? (
        <div className="mt-2 flex items-center gap-2 text-[13px]">
          <span className="min-w-0 flex-1 text-muted">Parte listo ({formatClock(view.parte.at)})</span>
          <CopyButton value={view.parte.text} label="Copiar parte" size="sm" />
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-xs text-critical">
          {error}
        </p>
      ) : null}
    </div>
  );
}
