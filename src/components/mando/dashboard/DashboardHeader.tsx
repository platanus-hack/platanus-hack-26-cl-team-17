import { Activity, Megaphone, Siren, Users } from "lucide-react";
import { Skeleton, Stat } from "@/components/ui";
import { cn } from "@/lib/cn";
import type { dashboardCounts } from "./urgency";

/** Props de `DashboardHeader`. */
export interface DashboardHeaderProps {
  counts: ReturnType<typeof dashboardCounts>;
  /** Primera carga: muestra esqueletos en vez de ceros. */
  loading?: boolean;
}

// En columnas angostas el rótulo se parte en dos líneas en vez de cortarse.
const tile = "rounded-lg border bg-surface p-2.5 sm:p-3 [&_.truncate]:whitespace-normal";

/** Contadores del tablero: activos, con personas atrapadas y reportes sin verificar. */
export function DashboardHeader({ counts, loading = false }: DashboardHeaderProps) {
  const value = (n: number) => (loading ? <Skeleton className="h-8 w-12" /> : n);
  const trapped = !loading && counts.trapped > 0;
  const unverified = !loading && counts.unverified > 0;

  return (
    <div className="grid grid-cols-3 gap-2 sm:gap-3" aria-busy={loading || undefined}>
      <Stat className={cn(tile, "border-line")} label="Activos" value={value(counts.active)} icon={Activity} />
      <Stat
        className={cn(tile, trapped ? "border-critical/60 bg-critical-soft" : "border-line")}
        label="Con personas atrapadas"
        value={value(counts.trapped)}
        tone={trapped ? "critical" : "neutral"}
        icon={trapped ? Siren : Users}
        hint="confirmado o probable"
      />
      <Stat
        className={cn(tile, unverified ? "border-warning/60" : "border-line")}
        label="Reportes sin verificar"
        value={value(counts.unverified)}
        tone={unverified ? "warning" : "neutral"}
        icon={Megaphone}
        hint={unverified ? "de vecinos" : undefined}
      />
    </div>
  );
}
