import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui";
import { cn } from "@/lib/cn";
import type { dashboardCounts } from "./urgency";

/** Props de `DashboardHeader`. */
export interface DashboardHeaderProps {
  counts: ReturnType<typeof dashboardCounts>;
  /** Primera carga: muestra esqueletos en vez de ceros. */
  loading?: boolean;
}

/** Un contador sin caja: número grande y rótulo corto debajo. */
function Count({ value, label, tone = "neutral" }: { value: ReactNode; label: string; tone?: "neutral" | "critical" | "warning" }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span
        className={cn(
          "font-display text-[34px] leading-none font-bold tracking-[-0.02em] tabular",
          tone === "critical" ? "text-critical" : tone === "warning" ? "text-warning" : "text-text",
        )}
      >
        {value}
      </span>
      <span className="text-[13px] text-muted">{label}</span>
    </div>
  );
}

/** Contadores del tablero en una línea: activos, con personas atrapadas y reportes sin verificar. */
export function DashboardHeader({ counts, loading = false }: DashboardHeaderProps) {
  const value = (n: number) => (loading ? <Skeleton className="h-8 w-12" /> : n);
  const trapped = !loading && counts.trapped > 0;
  const unverified = !loading && counts.unverified > 0;

  return (
    <div className="flex items-end gap-8 px-3 pt-2 pb-1 sm:gap-12" aria-busy={loading || undefined}>
      <Count value={value(counts.active)} label="Activos" />
      <Count value={value(counts.trapped)} label="Con personas atrapadas" tone={trapped ? "critical" : "neutral"} />
      <Count value={value(counts.unverified)} label="Reportes sin verificar" tone={unverified ? "warning" : "neutral"} />
    </div>
  );
}
