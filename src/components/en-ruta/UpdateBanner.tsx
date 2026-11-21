"use client";

import { BellRing, X } from "lucide-react";
import type { BriefingChange } from "./briefing-diff";

/** Aviso "ACTUALIZACIÓN" con el resumen de cambios importantes; queda hasta que se toca. */
export function UpdateBanner({ changes, seq, onDismiss }: { changes: BriefingChange[]; seq: number; onDismiss: () => void }) {
  if (changes.length === 0) return null;
  return (
    <div className="border-t border-warning bg-warning text-on-solid">
      {/* Todo el aviso se cierra con un toque; el botón "Entendido" es la vía accesible con teclado. */}
      <div
        key={seq}
        role="alert"
        onClick={onDismiss}
        className="mx-auto flex w-full max-w-[1400px] animate-enter cursor-pointer items-start gap-3 px-4 py-3 lg:px-6"
      >
        <BellRing aria-hidden className="mt-0.5 size-7 shrink-0" strokeWidth={2.5} />
        <div className="min-w-0 flex-1">
          <p className="label-caps text-xl lg:text-2xl">Actualización</p>
          <ul className="mt-1 flex max-h-[35dvh] flex-col gap-1 overflow-y-auto">
            {changes.map((c) => (
              <li key={c.text} className="text-lg leading-snug font-semibold lg:text-xl">
                {c.text}
              </li>
            ))}
          </ul>
        </div>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDismiss();
          }}
          className="flex min-h-14 min-w-16 shrink-0 flex-col items-center justify-center gap-0.5 rounded-md border-2 border-on-solid/60 px-2 text-sm font-bold"
        >
          <X aria-hidden className="size-6" strokeWidth={2.5} />
          Entendido
        </button>
      </div>
    </div>
  );
}
