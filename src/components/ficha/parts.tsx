"use client";
/**
 * Piezas de la ficha: barra superior, "Lo crítico", panel de Vigía (historial del agente y
 * línea de tiempo) y la grilla de medios. El mensaje actual del agente va en VigiaDock.
 * Paneles flotantes: blanco al 92 %, desenfoque de fondo, radio 16 px y sombra difusa.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  BadgeCheck,
  Car,
  ChevronDown,
  CircleCheck,
  EyeOff,
  Flame,
  House,
  Radio,
  Route,
  TriangleAlert,
  Truck,
  User,
  Video,
} from "lucide-react";
import type { Confidence, IncidentStatus } from "@/lib/domain";
import type { MediaView } from "@/lib/contract";
import { cn } from "@/lib/cn";
import {
  CONFIDENCE_WORD,
  filterTimeline,
  type CardIcon,
  type ChatMessage,
  type CriticalCard,
  type FichaHeader,
  type Finding,
  type TimelineFilter,
  type TimelineItem,
} from "./model";
import { TONE_DOT, TONE_TEXT, TONE_WASH } from "./tones";

export const GLASS = "bg-paper/92 backdrop-blur-xl shadow-[0_12px_40px_rgb(33_32_28/0.12)] rounded-2xl";

/* ───────────────────────────── Utilidades ───────────────────────────── */

function hhmm(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

export function useNow(intervalMs = 1000): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = window.setTimeout(tick, 0);
    const id = window.setInterval(tick, intervalMs);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(id);
    };
  }, [intervalMs]);
  return now;
}

function elapsed(fromIso: string, now: number | null): string {
  if (now === null) return "–:––";
  const s = Math.max(0, Math.floor((now - new Date(fromIso).getTime()) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/* ───────────────────────────── Barra superior ───────────────────────────── */

const STATUS: { key: IncidentStatus; label: string; dot: string }[] = [
  { key: "active", label: "Activo", dot: "bg-f-red" },
  { key: "controlled", label: "Controlado", dot: "bg-f-green" },
  { key: "closed", label: "Cerrado", dot: "bg-f-faint" },
];

export function TopBar({
  header,
  onStatus,
  onVerify,
  busy,
  compact,
  alerts,
}: {
  header: FichaHeader;
  onStatus: (s: IncidentStatus) => void;
  onVerify: () => void;
  busy: boolean;
  compact: boolean;
  /** Lo que está fallando (sin conexión, Zello, Vigía sin IA); null si todo anda. */
  alerts?: ReactNode;
}) {
  const now = useNow();
  return (
    <header className={cn(GLASS, "absolute top-4 right-4 left-4 z-30 flex h-14 items-center gap-3 px-2.5")}>
      <Link href="/mando" aria-label="Volver a incidentes" className="grid size-10 shrink-0 place-items-center rounded-xl text-f-ink hover:bg-f-wash">
        <ArrowLeft className="size-5" aria-hidden="true" />
      </Link>
      <div className="flex min-w-0 flex-1 items-baseline gap-3 whitespace-nowrap">
        <span className="text-[17px] font-bold text-f-ink">{header.typeLabel}</span>
        <span className="min-w-0 overflow-hidden text-[16px] text-f-muted">{header.place}</span>
        {!compact && <span className="font-mono text-[14px] text-f-muted">{header.code}</span>}
        <span className="font-mono text-[15px] font-medium text-f-ink tabular" title="Tiempo desde el llamado">
          {elapsed(header.startedAt, now)}
        </span>
      </div>
      {alerts}
      {header.unverified && (
        <button
          type="button"
          onClick={onVerify}
          disabled={busy}
          title="Confirmar que el reporte del vecino es una emergencia real"
          className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl bg-f-blue px-3.5 text-[14px] font-semibold text-white hover:bg-f-blue/90 disabled:opacity-60"
        >
          <BadgeCheck className="size-4" aria-hidden="true" />
          Verificar
        </button>
      )}
      <div role="radiogroup" aria-label="Estado del incidente" className="flex shrink-0 rounded-xl bg-f-wash p-1">
        {STATUS.map((s) => {
          const on = header.status === s.key;
          return (
            <button
              key={s.key}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={busy}
              onClick={() => !on && onStatus(s.key)}
              className={cn(
                "inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[14px] font-semibold transition-colors disabled:opacity-60",
                on ? "bg-paper text-f-ink shadow-[0_1px_3px_rgb(33_32_28/0.14)]" : "text-f-muted hover:text-f-ink",
              )}
            >
              {on && <span className={cn("size-2 rounded-full", s.dot)} aria-hidden="true" />}
              {s.label}
            </button>
          );
        })}
      </div>
    </header>
  );
}

/* ───────────────────────────── Lo crítico ───────────────────────────── */

const CARD_ICON: Record<CardIcon, typeof User> = {
  person: User,
  fire: Flame,
  hazard: TriangleAlert,
  vehicle: Car,
  access: Route,
  resources: Truck,
  structure: House,
  clear: CircleCheck,
};

export function ConfidenceMeter({ level }: { level: Confidence }) {
  const n = level === "high" ? 3 : level === "medium" ? 2 : 1;
  return (
    <span className="inline-flex items-center gap-1.5 text-[13px] text-f-muted">
      <span className="flex items-end gap-[2px]" aria-hidden="true">
        {[1, 2, 3].map((i) => (
          <span key={i} className={cn("w-[3px] rounded-full", i <= n ? "bg-f-ink" : "bg-f-line")} style={{ height: 5 + i * 3 }} />
        ))}
      </span>
      confianza {CONFIDENCE_WORD[level]}
    </span>
  );
}

function Chip({ children }: { children: ReactNode }) {
  return <span className="inline-flex h-5 items-center rounded bg-f-wash px-1.5 font-mono text-[11.5px] font-medium text-f-muted">{children}</span>;
}

function Card({ card, active, onFocus }: { card: CriticalCard; active: boolean; onFocus: (id: string | null) => void }) {
  const Icon = CARD_ICON[card.icon];
  return (
    <li>
      <button
        type="button"
        onClick={() => onFocus(card.focus)}
        className={cn(
          "flex w-full gap-2.5 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-f-wash/70",
          active && "bg-f-wash",
        )}
      >
        <span className={cn("grid size-8 shrink-0 place-items-center rounded-full", TONE_WASH[card.tone])}>
          <Icon className={cn("size-4", TONE_TEXT[card.tone])} strokeWidth={2.4} aria-hidden="true" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className={cn("text-[17px] leading-tight font-bold", card.tone === "red" ? "text-f-red" : "text-f-ink")}>{card.title}</span>
          {card.location && <span className="text-[13.5px] leading-snug text-f-muted">{card.location}</span>}
          {card.unseen && (
            <span className="inline-flex items-center gap-1.5 text-[13.5px] leading-snug text-f-muted">
              <EyeOff className="size-4 shrink-0" aria-hidden="true" />
              {card.unseen}
            </span>
          )}
          {(card.confidence || card.sources.length > 0) && (
            <span className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
              {card.confidence && <ConfidenceMeter level={card.confidence} />}
              {card.sources.length > 0 && (
                <span className="flex flex-wrap gap-1">
                  {card.sources.map((s) => (
                    <Chip key={s}>{s}</Chip>
                  ))}
                </span>
              )}
            </span>
          )}
        </span>
      </button>
    </li>
  );
}

export function CriticalPanel({
  cards,
  findings,
  arriving,
  focus,
  onFocus,
  style,
}: {
  cards: CriticalCard[];
  findings: Finding[];
  arriving: boolean;
  focus: string | null;
  onFocus: (id: string | null) => void;
  style: React.CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section aria-label="Lo crítico" className={cn(GLASS, "absolute z-20 flex flex-col overflow-hidden")} style={style}>
      <h2 className="px-4 pt-3 pb-0.5 text-[11.5px] font-semibold tracking-[0.08em] text-f-faint uppercase">Lo crítico</h2>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {/* Llegando: aún sin análisis, salvo lo que ya vio el dron en vivo. */}
        {arriving && cards.length === 0 ? (
          <div className="flex flex-col gap-2 px-3.5 py-4">
            <span className="grid size-10 place-items-center rounded-full bg-f-blue/12">
              <Route className="size-5 text-f-blue" aria-hidden="true" />
            </span>
            <p className="text-[17px] leading-tight font-bold text-f-ink">Sin hallazgos todavía</p>
            <p className="text-[13.5px] leading-snug text-f-muted">Vigía avisa apenas analice el primer video de un vecino.</p>
          </div>
        ) : cards.length === 0 ? (
          <p className="px-3.5 py-4 text-[15px] text-f-muted">Analizando los videos…</p>
        ) : (
          <ul className="flex flex-col">
            {cards.map((c) => (
              <Card key={c.id} card={c} active={!!c.focus && c.focus === focus} onFocus={onFocus} />
            ))}
          </ul>
        )}
        {!arriving && findings.length > 0 && (
          <div className="mt-1 border-t border-f-line px-2 pt-2">
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              className="flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-[14px] font-semibold text-f-ink hover:bg-f-wash"
            >
              {open ? "Ocultar hallazgos" : `Ver los ${findings.length} hallazgos`}
              <ChevronDown className={cn("size-4 text-f-muted transition-transform", open && "rotate-180")} aria-hidden="true" />
            </button>
            {open && (
              <ul className="flex flex-col pb-1">
                {findings.map((f) => (
                  <li key={f.id}>
                    <button
                      type="button"
                      onClick={() => onFocus(f.focus)}
                      className="flex w-full items-start gap-2.5 rounded-xl px-2.5 py-2 text-left hover:bg-f-wash"
                    >
                      <span className={cn("mt-[7px] size-2 shrink-0 rounded-full", TONE_DOT[f.tone])} aria-hidden="true" />
                      <span className="flex-1 text-[14px] leading-snug text-f-ink">{f.title}</span>
                      <span className="shrink-0 pt-0.5 text-[13px] text-f-faint">{CONFIDENCE_WORD[f.confidence]}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

/* ───────────────────────────── Vigía ───────────────────────────── */

function Speaking() {
  return (
    <span className="inline-flex items-end gap-[2px]" aria-hidden="true">
      {[0, 150, 300].map((d) => (
        <span key={d} className="h-3 w-[3px] origin-bottom rounded-full bg-f-ink motion-safe:animate-[vg-eq_900ms_ease-in-out_infinite]" style={{ animationDelay: `${d}ms` }} />
      ))}
    </span>
  );
}

function Bubble({ msg, speaking, onPick }: { msg: ChatMessage; speaking: boolean; onPick: (m: ChatMessage) => void }) {
  if (msg.from === "obac") {
    return (
      <li className="flex justify-end">
        <p className="max-w-[85%] rounded-xl bg-f-wash px-3 py-1.5 text-[13.5px] leading-snug text-f-ink">{msg.text}</p>
      </li>
    );
  }
  return (
    <li>
      <button
        type="button"
        onClick={() => onPick(msg)}
        title="Escuchar y ver en el mapa"
        className={cn(
          "group block w-full border-l-2 py-0.5 pl-3 text-left transition-colors",
          speaking ? "border-f-ink" : "border-f-line hover:border-f-faint",
        )}
      >
        <span className="flex items-center gap-1.5 text-[11.5px] text-f-faint">
          {speaking && <Speaking />}
          <span className={speaking ? "font-semibold text-f-ink" : undefined}>{speaking ? "Vigía hablando" : (msg.tag ?? "Vigía")}</span>
          <span className="font-mono tabular">{hhmm(msg.at)}</span>
        </span>
        <span className={cn("mt-0.5 block text-[14px] leading-snug", speaking ? "text-f-ink" : "text-f-ink/85")}>{msg.text}</span>
        {msg.template && <span className="mt-0.5 block text-[11.5px] text-f-faint">Respuesta por plantilla (sin IA)</span>}
      </button>
    </li>
  );
}

const FILTERS: { key: TimelineFilter; label: string }[] = [
  { key: "all", label: "Todo" },
  { key: "alerts", label: "Alertas" },
  { key: "radio", label: "Radio" },
  { key: "videos", label: "Videos" },
];

function TimelineIcon({ item }: { item: TimelineItem }) {
  const cls = cn("size-3.5", TONE_TEXT[item.tone]);
  if (item.group === "radio") return <Radio className={cls} aria-hidden="true" />;
  if (item.group === "videos") return <Video className={cls} aria-hidden="true" />;
  return <span className={cn("m-[3px] size-2 rounded-full", TONE_DOT[item.tone])} aria-hidden="true" />;
}

export function VigiaPanel({
  chat,
  speakingId,
  timeline,
  arriving,
  onPick,
  style,
}: {
  chat: ChatMessage[];
  speakingId: string | null;
  timeline: TimelineItem[];
  arriving: boolean;
  onPick: (m: ChatMessage) => void;
  style: React.CSSProperties;
}) {
  const [filter, setFilter] = useState<TimelineFilter>("all");
  const listRef = useRef<HTMLOListElement | null>(null);
  const items = filterTimeline(timeline, filter);
  // El más reciente arriba: al llegar uno nuevo, la lista vuelve al inicio.
  const newestFirst = [...chat].reverse();
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = 0;
  }, [chat.length]);

  return (
    <section aria-label="Vigía" className={cn(GLASS, "absolute z-20 flex flex-col overflow-hidden")} style={style}>
      <h2 className="flex items-center gap-2 px-4 pt-3 pb-1.5 text-[11.5px] font-semibold tracking-[0.08em] text-f-faint uppercase">Vigía</h2>
      <ol ref={listRef} className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-4 pb-3" aria-live="polite">
        {arriving && chat.length === 0 && (
          <li className="border-l-2 border-f-line pl-3">
            <span className="block text-[11.5px] text-f-faint">Vigía</span>
            <p className="mt-0.5 text-[14px] leading-snug text-f-ink/85">Voy contigo. Aún no llegan videos de vecinos; te aviso apenas analice el primero.</p>
          </li>
        )}
        {!arriving && chat.length === 0 && <li className="py-6 text-center text-[13.5px] text-f-muted">Vigía hablará cuando haya algo nuevo.</li>}
        {newestFirst.map((m) => (
          <Bubble key={m.id} msg={m} speaking={m.id === speakingId} onPick={onPick} />
        ))}
      </ol>
      <div className="flex max-h-[38%] min-h-[140px] flex-col border-t border-f-line">
        <div role="tablist" aria-label="Filtro de la línea de tiempo" className="flex gap-0.5 px-3 pt-2 pb-1">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              role="tab"
              aria-selected={filter === f.key}
              onClick={() => setFilter(f.key)}
              className={cn(
                "h-6 rounded-full px-2.5 text-[12px] font-semibold transition-colors",
                filter === f.key ? "bg-f-wash text-f-ink" : "text-f-muted hover:text-f-ink",
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto px-4 pb-3">
          {items.length === 0 && <li className="py-3 text-[14px] text-f-faint">Nada por ahora.</li>}
          {items.map((i) => (
            <li key={i.id} className="flex items-start gap-2 py-1">
              <span className="w-10 shrink-0 pt-px font-mono text-[11.5px] text-f-faint tabular">{hhmm(i.at)}</span>
              <span className="grid h-[18px] shrink-0 place-items-center">
                <TimelineIcon item={i} />
              </span>
              <span className="flex-1 text-[13px] leading-snug text-f-muted">{i.title}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/* ───────────────────────────── Medios ───────────────────────────── */

export function MediaGridPanel({ media, onOpen, style }: { media: MediaView[]; onOpen: (id: string) => void; style: React.CSSProperties }) {
  return (
    <section aria-label="Medios" className={cn(GLASS, "absolute z-20 overflow-y-auto p-4")} style={style}>
      {media.length === 0 ? (
        <p className="py-10 text-center text-[16px] text-f-muted">Aún no llegan videos de vecinos.</p>
      ) : (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
          {media.map((m) => {
            const thumb = m.urls.poster ?? m.urls.frames[0]?.url ?? null;
            return (
              <li key={m.id}>
                <button type="button" onClick={() => onOpen(m.id)} className="group block w-full overflow-hidden rounded-xl bg-f-wash text-left">
                  <span className="block aspect-video w-full overflow-hidden bg-f-line">
                    {/* eslint-disable-next-line @next/next/no-img-element -- miniatura servida por la API de archivos */}
                    {thumb && <img src={thumb} alt="" className="size-full object-cover transition-transform group-hover:scale-[1.03]" />}
                  </span>
                  <span className="flex items-center justify-between px-3 py-2">
                    <span className="text-[15px] font-semibold text-f-ink">{m.label}</span>
                    <span className="text-[13px] text-f-muted">{m.status === "analyzed" ? "analizado" : "analizando…"}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
