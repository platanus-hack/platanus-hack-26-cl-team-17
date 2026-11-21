import type { ReactNode } from "react";
import { Wordmark } from "@/components/brand/Wordmark";
import { cn } from "@/lib/cn";

/** Props del marco de las pantallas para vecinos. */
export interface VecinoShellProps {
  children: ReactNode;
  className?: string;
}

/** Marco claro para vecinos: encabezado mínimo y contenido en una columna. */
export function VecinoShell({ children, className }: VecinoShellProps) {
  return (
    <div data-theme="vecino" className={cn("flex min-h-dvh flex-col bg-bg text-text", className)}>
      <header className="border-b border-line bg-surface pt-[env(safe-area-inset-top)]">
        <div className="mx-auto flex h-14 max-w-xl items-center px-4">
          <Wordmark size="sm" />
        </div>
      </header>

      <main className="mx-auto w-full max-w-xl flex-1 px-4 pt-6 pb-[max(2.5rem,env(safe-area-inset-bottom))]">
        {children}
      </main>
    </div>
  );
}
