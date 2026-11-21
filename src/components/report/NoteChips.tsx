"use client";

import { Check, Plus } from "lucide-react";
import { cn } from "@/lib/cn";
import { NOTE_CHIPS } from "./report-core";

export interface NoteChipsProps {
  selected: ReadonlySet<string>;
  onToggle: (id: string) => void;
  disabled?: boolean;
  /** id del texto que describe el grupo (aria-describedby). */
  describedBy?: string;
  className?: string;
}

/** Frases de un toque para la nota del vecino; cada una es un botón que se marca o desmarca. */
export function NoteChips({ selected, onToggle, disabled, describedBy, className }: NoteChipsProps) {
  return (
    <ul
      role="list"
      aria-describedby={describedBy}
      className={cn("grid grid-cols-1 gap-2 min-[400px]:grid-cols-2", className)}
    >
      {NOTE_CHIPS.map((chip) => {
        const on = selected.has(chip.id);
        const Icon = on ? Check : Plus;
        return (
          <li key={chip.id} className="min-w-0">
            <button
              type="button"
              aria-pressed={on}
              disabled={disabled}
              onClick={() => onToggle(chip.id)}
              className={cn(
                "flex min-h-[52px] w-full items-center gap-2.5 rounded-md border px-3.5 py-2 text-left font-sans text-base font-semibold leading-tight",
                "transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50",
                on
                  ? "border-accent bg-accent-soft text-text"
                  : "border-line bg-surface-2 text-text hover:border-line-strong",
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "flex size-6 shrink-0 items-center justify-center rounded-full border",
                  on ? "border-accent bg-accent text-on-solid" : "border-line-strong text-muted",
                )}
              >
                <Icon size={16} strokeWidth={3} />
              </span>
              <span className="min-w-0">{chip.label}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
