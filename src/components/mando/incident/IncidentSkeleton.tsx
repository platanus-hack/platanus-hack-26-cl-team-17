import { Skeleton } from "@/components/ui";
import { cn } from "@/lib/cn";

/** Props del esqueleto de la vista de incidente. */
export interface IncidentSkeletonProps {
  className?: string;
}

/** Esqueleto con la misma estructura que la vista de incidente (cabecera, franja crítica y tres zonas). */
export function IncidentSkeleton({ className }: IncidentSkeletonProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className={cn("flex h-full min-h-0 flex-col overflow-hidden", className)}
    >
      <span className="sr-only">Cargando incidente…</span>

      {/* Cabecera */}
      <div className="flex flex-wrap items-start gap-4 border-b border-line bg-surface px-3 py-2 md:px-4">
        <div className="flex min-w-0 flex-[1_1_22rem] items-start gap-3">
          <Skeleton className="size-9 rounded-md" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-6 w-3/4 max-w-md" />
            <Skeleton className="h-3 w-1/2 max-w-xs" />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Skeleton className="h-8 w-56 rounded-md" />
          <Skeleton className="h-9 w-28 rounded-md" />
          <Skeleton className="h-9 w-32 rounded-md" />
          <Skeleton className="h-9 w-28 rounded-md" />
        </div>
      </div>

      {/* Franja crítica */}
      <div className="border-b border-line px-3 py-2 md:px-4">
        <Skeleton className="h-12 w-full rounded-md" />
      </div>

      {/* Pestañas de teléfono */}
      <div className="flex gap-2 border-b border-line px-3 py-2 md:hidden">
        <Skeleton className="h-6 w-24" />
        <Skeleton className="h-6 w-20" />
        <Skeleton className="h-6 w-24" />
      </div>

      {/* Tres zonas */}
      <div className="grid min-h-0 flex-1 gap-2 p-2 md:grid-cols-[minmax(0,1fr)_340px] md:grid-rows-[minmax(0,1.3fr)_minmax(0,1fr)] xl:grid-cols-[360px_minmax(0,1fr)_380px] xl:grid-rows-1">
        <div className="hidden flex-col gap-3 rounded-lg border border-line bg-surface p-3 md:col-start-1 md:row-start-2 md:flex xl:row-start-1">
          <Skeleton className="h-4 w-28" />
          <Skeleton lines={4} />
          <Skeleton className="h-4 w-24" />
          <Skeleton lines={3} />
        </div>
        <div className="flex min-h-[50dvh] flex-col gap-2 md:col-start-1 md:row-start-1 md:min-h-0 xl:col-start-2">
          <Skeleton className="h-8 w-80 max-w-full rounded-md" />
          <Skeleton className="min-h-0 w-full flex-1 rounded-lg" />
          <div className="flex gap-2">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-16 w-24 shrink-0 rounded-md" />
            ))}
          </div>
        </div>
        <div className="hidden flex-col gap-3 rounded-lg border border-line bg-surface p-3 md:col-start-2 md:row-span-2 md:row-start-1 md:flex xl:col-start-3 xl:row-span-1">
          <Skeleton className="h-6 w-full" />
          <Skeleton lines={6} />
        </div>
      </div>
    </div>
  );
}
