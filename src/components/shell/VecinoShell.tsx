import type { ReactNode } from "react";
import { Phone } from "lucide-react";
import { Wordmark } from "@/components/brand/Wordmark";
import { cn } from "@/lib/cn";

/** Props del marco de las pantallas para vecinos. */
export interface VecinoShellProps {
  children: ReactNode;
  className?: string;
}

/** Marco claro para vecinos: franja fija de llamada al 132, encabezado mínimo y contenido en una columna. */
export function VecinoShell({ children, className }: VecinoShellProps) {
  return (
    <div data-theme="vecino" className={cn("flex min-h-dvh flex-col bg-bg text-text", className)}>
      <a
        href="tel:132"
        className="sticky top-0 z-30 flex min-h-12 items-center justify-center gap-2.5 bg-critical px-4 pt-[env(safe-area-inset-top)] text-center text-base leading-tight font-semibold text-on-solid underline-offset-4 hover:underline focus-visible:outline-offset-[-4px] focus-visible:outline-on-solid"
      >
        <Phone aria-hidden className="size-5 shrink-0" strokeWidth={2.5} />
        <span className="py-2">
          ¿Hay peligro inmediato? <span className="whitespace-nowrap font-bold">Llama al 132</span> (Bomberos)
        </span>
      </a>

      <header className="border-b border-line bg-surface">
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
