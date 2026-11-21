"use client";

import { BellRing, X } from "lucide-react";
import type { BriefingChange } from "./briefing-diff";

/** Aviso "ACTUALIZACIÓN" con el resumen de cambios importantes; queda hasta que se toca. */
export function UpdateBanner({ changes, seq, onDismiss }: { changes: BriefingChange[]; seq: number; onDismiss: () => void }) {
  if (changes.length === 0) return null;
  return (
    <div role="alert" className="border-t border-warning bg-warning text-on-solid">
      <button
        key={seq}
        type="button"
        onClick={onDismiss}
        className="mx-auto flex w-full max-w-[1400px] animate-enter items-start gap-3 px-4 py-3 text-left lg:px-6"
      >
        <BellRing aria-hidden className="mt-0.5 size-7 shrink-0" strokeWidth={2.5} />
        <span className="min-w-0 flex-1">
          <span className="label-caps block text-xl lg:text-2xl">Actualización</span>
          <ul className="mt-1 flex flex-col gap-1">
            {changes.map((c) => (
              <li key={c.text} className="text-lg leading-snug font-semibold lg:text-xl">
                {c.text}
              </li>
            ))}
          </ul>
        </span>
        <span className="flex shrink-0 flex-col items-center gap-0.5 text-sm font-semibold">
          <X aria-hidden className="size-6" strokeWidth={2.5} />
          Entendido
        </span>
      </button>
    </div>
  );
}
