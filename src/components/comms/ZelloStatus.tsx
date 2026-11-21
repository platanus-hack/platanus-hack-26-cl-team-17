"use client";
/**
 * Estado de la conexión a Zello en el panel de radio: si el puente está conectado,
 * qué canal escucha, cuántos hay en línea y la última transmisión. Consulta
 * GET /api/zello/status cada 5 s (el puente manda un latido cada ~10 s).
 */
import useSWR from "swr";
import { RadioTower } from "lucide-react";
import { cn } from "@/lib/cn";
import { api } from "@/lib/client/api";
import type { ZelloStatusResponse } from "@/lib/contract";
import { formatClock } from "@/lib/format";

const POLL_MS = 5_000;

export interface ZelloLine {
  tone: "ok" | "warning" | "critical" | "muted";
  title: string;
  detail: string | null;
  /** Texto largo para el atributo title (al pasar el mouse). */
  hint: string;
}

/** Qué mostrar según el último latido. Pura: probada en ZelloStatus.test.ts. */
export function zelloLine(res: ZelloStatusResponse | null | undefined): ZelloLine {
  const s = res?.status;
  if (!res || !s) {
    return { tone: "muted", title: "Zello sin puente", detail: null, hint: "No hay un puente Zello conectado. Se inicia con «npm run zello»." };
  }
  const last = s.last_transmission ? `Última: ${formatClock(s.last_transmission.at)} ${s.last_transmission.from}` : "Sin transmisiones aún";
  if (s.stopped) {
    return {
      tone: "muted",
      title: "Zello: puente detenido",
      detail: res.received_at ? `a las ${formatClock(res.received_at)}` : null,
      hint: "El puente se detuvo a propósito. Lo que se hable en Zello no entra a la bitácora hasta volver a iniciarlo con «npm run zello».",
    };
  }
  if (res.stale) {
    return {
      tone: "warning",
      title: "Zello sin señal del puente",
      detail: res.received_at ? `desde las ${formatClock(res.received_at)}` : null,
      hint: "El puente dejó de informar: se cayó o perdió la red. Lo que se hable en Zello no está entrando a la bitácora.",
    };
  }
  if (!s.connected) {
    return {
      tone: "critical",
      title: "Zello desconectado",
      detail: s.error ?? "reconectando…",
      hint: `El puente está activo pero no tiene conexión con el canal «${s.channel}». Reintenta solo.`,
    };
  }
  const who = s.users_online !== null ? ` · ${s.users_online} en línea` : "";
  const said = s.last_spoken ? ` · Vigía habló ${formatClock(s.last_spoken.at)}` : "";
  return {
    tone: "ok",
    title: `Zello · ${s.channel}${who}`,
    detail: `${last}${said}${s.listen_only ? " · solo escucha" : ""}`,
    hint: `Escuchando «${s.channel}». Cada transmisión entra a la bitácora con su grabación y transcripción${
      s.listen_only ? "; Vigía no habla (sin voz configurada)" : "; Vigía habla en el canal"
    }.${s.incident_codes.length ? ` Emergencias: ${s.incident_codes.join(", ")}.` : ""}`,
  };
}

const DOT: Record<ZelloLine["tone"], string> = {
  ok: "bg-ok",
  warning: "bg-warning",
  critical: "bg-critical",
  muted: "bg-faint",
};

export function ZelloStatus({ className }: { className?: string }) {
  const { data } = useSWR<ZelloStatusResponse>("/api/zello/status", () => api.zello.status(), {
    refreshInterval: POLL_MS,
    revalidateOnFocus: true,
    shouldRetryOnError: true,
  });
  const line = zelloLine(data);
  return (
    <div
      className={cn("flex min-w-0 items-center gap-2 border-b border-line px-3 py-1.5 text-xs", className)}
      title={line.hint}
      role="status"
      aria-live="polite"
    >
      <span className="relative flex size-2 shrink-0" aria-hidden>
        {line.tone === "ok" && <span className={cn("absolute inline-flex size-full animate-ping rounded-full opacity-60", DOT.ok)} />}
        <span className={cn("relative inline-flex size-2 rounded-full", DOT[line.tone])} />
      </span>
      <RadioTower aria-hidden className="size-3.5 shrink-0 text-muted" />
      <span className={cn("shrink-0 font-semibold", line.tone === "muted" ? "text-muted" : "text-text")}>{line.title}</span>
      {line.detail && (
        <span className="min-w-0 truncate text-muted" suppressHydrationWarning>
          {line.detail}
        </span>
      )}
    </div>
  );
}
