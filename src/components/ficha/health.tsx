"use client";
/**
 * Lo que está fallando, en la barra de la ficha y solo cuando algo falla: sin conexión con el
 * servidor (la ficha quedó congelada), Zello caído (Vigía no habla ni escucha por radio) y
 * Vigía sin IA. Antes esto solo se veía en la vista técnica.
 */
import useSWR from "swr";
import { BotOff, RadioTower, WifiOff, type LucideIcon } from "lucide-react";
import { zelloLine } from "@/components/comms/ZelloStatus";
import { sinIA } from "@/components/vigia/sin-ia";
import { cn } from "@/lib/cn";
import { api } from "@/lib/client/api";
import type { ZelloStatusResponse } from "@/lib/contract";
import type { VigiaView } from "@/lib/vigia/types";
import { useNow } from "./parts";

export interface HealthChip {
  id: "red" | "zello" | "vigia";
  tone: "critical" | "warning";
  label: string;
  /** Texto largo para el title (al pasar el mouse). */
  hint: string;
}

function ago(seconds: number): string {
  return seconds < 90 ? `${seconds} s` : `${Math.round(seconds / 60)} min`;
}

/** Qué avisos mostrar. Pura: probada en health.test.ts. */
export function healthChips(input: {
  stale: boolean;
  lastUpdatedAt: number | null;
  now: number | null;
  zello: ZelloStatusResponse | null | undefined;
  vigia: Pick<VigiaView, "ai_off" | "last_error"> | null;
}): HealthChip[] {
  const out: HealthChip[] = [];
  if (input.stale) {
    const s = input.lastUpdatedAt !== null && input.now !== null ? Math.max(0, Math.round((input.now - input.lastUpdatedAt) / 1000)) : null;
    out.push({
      id: "red",
      tone: "critical",
      label: s !== null ? `Sin conexión · hace ${ago(s)}` : "Sin conexión",
      hint: "La ficha no se está actualizando: el servidor no responde (¿se cayó la red?). Lo que ves puede estar desactualizado.",
    });
  }
  // Sin puente configurado (gris) no es una falla: solo avisa si el puente está y se cayó.
  const z = zelloLine(input.zello);
  if (input.zello && (z.tone === "warning" || z.tone === "critical")) {
    out.push({ id: "zello", tone: z.tone, label: z.title, hint: `${z.detail ? `${z.detail}. ` : ""}${z.hint}` });
  }
  const v = sinIA(input.vigia);
  if (v) out.push({ id: "vigia", tone: "warning", label: v.title, hint: v.detail });
  return out;
}

const ICON: Record<HealthChip["id"], LucideIcon> = { red: WifiOff, zello: RadioTower, vigia: BotOff };

export function FichaHealth({
  stale,
  lastUpdatedAt,
  vigia,
}: {
  stale: boolean;
  lastUpdatedAt: number | null;
  vigia: Pick<VigiaView, "ai_off" | "last_error"> | null;
}) {
  const now = useNow(1000);
  const { data: zello } = useSWR<ZelloStatusResponse>("/api/zello/status", () => api.zello.status(), {
    refreshInterval: 5_000,
    revalidateOnFocus: true,
    shouldRetryOnError: true,
  });
  const chips = healthChips({ stale, lastUpdatedAt, now, zello, vigia });
  if (chips.length === 0) return null;
  return (
    <div role="status" aria-live="polite" className="flex min-w-0 shrink items-center gap-1.5 overflow-hidden">
      {chips.map((c) => {
        const Icon = ICON[c.id];
        return (
          <span
            key={c.id}
            title={c.hint}
            className={cn(
              "inline-flex h-7 min-w-0 shrink items-center gap-1.5 rounded-full px-3 text-[13px] font-semibold whitespace-nowrap",
              c.tone === "critical" ? "bg-f-red text-white" : "bg-f-amber text-f-ink",
            )}
          >
            <Icon className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate" suppressHydrationWarning>
              {c.label}
            </span>
          </span>
        );
      })}
    </div>
  );
}
