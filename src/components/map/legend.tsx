"use client";
/** Leyenda compacta y plegable del mapa táctico: solo lo que hay en el mapa. */
import { useState } from "react";
import { ChevronDown, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { TONE_BG, TONE_TEXT, type Tone } from "./map-chrome";

export type SwatchKind = "dot" | "fill" | "line" | "dashed" | "cone" | "icon";

export interface LegendItem {
  key: string;
  label: string;
  tone: Tone;
  swatch: SwatchKind;
  icon?: LucideIcon;
}

const FILL: Record<Tone, string> = {
  critical: "bg-critical/30 border-critical",
  accent: "bg-accent/35 border-accent",
  warning: "bg-warning/25 border-warning",
  info: "bg-info/20 border-info",
  ok: "bg-ok/25 border-ok",
  drone: "bg-drone/25 border-drone",
  neutral: "bg-muted/15 border-muted",
};

const BORDER: Record<Tone, string> = {
  critical: "border-critical",
  accent: "border-accent",
  warning: "border-warning",
  info: "border-info",
  ok: "border-ok",
  drone: "border-drone",
  neutral: "border-muted",
};

function Swatch({ item }: { item: LegendItem }) {
  switch (item.swatch) {
    case "dot":
      return <span className={cn("size-2.5 rounded-full ring-2 ring-bg", TONE_BG[item.tone])} />;
    case "fill":
      return <span className={cn("h-2.5 w-3.5 rounded-[2px] border", FILL[item.tone])} />;
    case "line":
      return <span className={cn("h-0 w-3.5 border-t-2", BORDER[item.tone])} />;
    case "dashed":
      return <span className={cn("h-0 w-3.5 border-t-2 border-dashed", BORDER[item.tone])} />;
    case "cone":
      return (
        <span
          className={cn("h-3 w-3.5 [clip-path:polygon(0_0,100%_0,50%_100%)]", TONE_BG[item.tone], "opacity-50")}
        />
      );
    case "icon": {
      const Icon = item.icon;
      return Icon ? <Icon className={cn("size-3.5", TONE_TEXT[item.tone])} aria-hidden /> : null;
    }
  }
}

export function MapLegend({ items, footer }: { items: LegendItem[]; footer?: string }) {
  // Plegada al inicio: en paneles chicos tapaba media escena. Un toque la abre.
  const [open, setOpen] = useState(false);
  return (
    <div className="pointer-events-auto w-max max-w-[15rem] rounded-control border border-line bg-surface/90 text-xs text-text shadow-md backdrop-blur-sm">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="label-caps flex min-h-8 w-full items-center justify-between gap-3 px-2 text-[11px] text-muted pointer-coarse:min-h-10"
      >
        Leyenda
        <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      {open && (
        <>
          <ul className="max-h-52 space-y-1 overflow-y-auto px-2 pb-2">
            {items.map((item) => (
              <li key={item.key} className="flex items-center gap-2 leading-tight">
                <span aria-hidden className="grid w-4 shrink-0 place-items-center">
                  <Swatch item={item} />
                </span>
                <span>{item.label}</span>
              </li>
            ))}
          </ul>
          {footer && <p className="border-t border-line px-2 py-1.5 text-[11px] leading-snug text-muted">{footer}</p>}
        </>
      )}
    </div>
  );
}
