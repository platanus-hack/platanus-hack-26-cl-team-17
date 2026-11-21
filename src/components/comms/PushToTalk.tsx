"use client";

import type { ComponentProps } from "react";
import { Mic, Radio } from "lucide-react";
import { Badge, Spinner } from "@/components/ui";
import { cn } from "@/lib/cn";
import type { PttState, usePushToTalk } from "./use-push-to-talk";

const BARS = 14;

function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function buttonLabel(state: PttState): string {
  if (state.status === "arming") return "Abriendo micrófono…";
  if (state.status === "finishing") return "Cerrando transmisión…";
  if (state.status === "recording") return state.latched ? "Toca para enviar" : "Suelta para enviar";
  return "Mantén para hablar";
}

export interface PttButtonProps {
  state: PttState;
  buttonProps: ReturnType<typeof usePushToTalk>["buttonProps"];
  disabled?: boolean;
  /** "compact" en el panel del mando; "large" en la radio de demostración. */
  size?: "compact" | "large";
  className?: string;
}

/** Botón de radio: mantener apretado para hablar (o tocar para abrir y tocar para enviar). */
export function PttButton({ state, buttonProps, disabled, size = "compact", className }: PttButtonProps) {
  const onAir = state.status === "recording";
  const busy = state.status === "arming" || state.status === "finishing";
  const label = buttonLabel(state);
  const common: ComponentProps<"button"> = {
    type: "button",
    disabled,
    "aria-pressed": onAir,
    "aria-label": `Hablar por radio: ${label}`,
    title: "Mantén apretado (o Espacio) para hablar por el micrófono; suelta para enviar. Un toque corto deja la transmisión abierta.",
    ...buttonProps,
  };

  if (size === "large") {
    return (
      <button
        {...common}
        className={cn(
          "relative flex size-56 touch-none flex-col items-center justify-center gap-2 rounded-full border-4 text-center font-semibold shadow-lg transition-transform select-none",
          "focus-visible:ring-4 focus-visible:ring-accent/50 focus-visible:outline-none disabled:opacity-50",
          onAir ? "scale-95 border-critical bg-critical text-white" : "border-accent/40 bg-accent text-white active:scale-95",
          className,
        )}
      >
        {onAir && <span aria-hidden className="absolute -inset-3 animate-pulse rounded-full border-4 border-critical/40" />}
        {busy ? <Spinner size="lg" label="" /> : <Mic aria-hidden className="size-14" />}
        <span className="px-6 text-base leading-tight">{label}</span>
      </button>
    );
  }

  return (
    <button
      {...common}
      className={cn(
        "inline-flex h-8 touch-none items-center gap-1.5 rounded-md border px-2.5 text-sm font-medium whitespace-nowrap transition-colors select-none",
        "focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
        onAir ? "border-critical bg-critical text-white" : "border-line bg-surface text-text hover:bg-surface-2",
        className,
      )}
    >
      {busy ? <Spinner size="xs" label="" /> : <Radio aria-hidden className="size-4" />}
      {onAir ? (state.latched ? "Tocar para enviar" : "Al aire") : busy ? "…" : "Hablar"}
    </button>
  );
}

export interface PttLiveProps {
  state: PttState;
  /** Quién transmite y por qué canal, para el encabezado. */
  who: string;
  /** false si el navegador no transcribe (llega solo el audio). */
  dictation: boolean;
  className?: string;
}

/** Estado de la transmisión al aire: vúmetro, tiempo y lo que se va entendiendo. */
export function PttLive({ state, who, dictation, className }: PttLiveProps) {
  const lit = Math.round(state.level * BARS);
  return (
    <div className={cn("flex flex-col gap-1.5 rounded-md border border-critical/40 bg-critical-soft px-2.5 py-2", className)} role="status">
      <div className="flex items-center gap-2">
        <Badge tone="critical" variant="solid" pulse size="md">
          Al aire
        </Badge>
        <span className="min-w-0 truncate text-xs text-muted">{who}</span>
        <span className="ml-auto font-mono text-xs text-muted tabular">{clock(state.elapsed)}</span>
      </div>
      <div className="flex h-3 items-end gap-0.5" aria-hidden>
        {Array.from({ length: BARS }, (_, i) => (
          <span
            key={i}
            className={i < lit ? (i >= BARS - 2 ? "bg-critical" : "bg-accent") : "bg-line"}
            style={{ width: 6, height: `${30 + (i / BARS) * 70}%` }}
          />
        ))}
      </div>
      <p className="min-h-5 text-sm text-text italic" aria-live="off">
        {state.heard ||
          (dictation ? (
            <span className="text-faint not-italic">Habla claro, cerca del micrófono…</span>
          ) : (
            <span className="text-faint not-italic">Grabando (este navegador no transcribe: llegará solo el audio).</span>
          ))}
      </p>
    </div>
  );
}
