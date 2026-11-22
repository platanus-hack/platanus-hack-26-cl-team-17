"use client";
/** Contenido visual de los marcadores (sin maplibre): se monta dentro de <MapMarker>. */
import { useState, type ReactNode } from "react";
import { Camera, Drone, Navigation2, Video, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { MarkerTip, TONE_SOLID, type Tone } from "./map-chrome";

export interface TipContent {
  title: string;
  lines: string[];
}

export const tipText = (t: TipContent): string => [t.title, ...t.lines.filter(Boolean)].join(". ");

function TipBody({ tip }: { tip: TipContent }) {
  return (
    <>
      <span className="block font-semibold">{tip.title}</span>
      {tip.lines.filter(Boolean).map((l, i) => (
        <span key={i} className="block text-muted">
          {l}
        </span>
      ))}
    </>
  );
}

/**
 * Marcador informativo: botón que muestra el detalle al pasar el puntero, al enfocarlo con
 * teclado o al tocarlo (disclosure con aria-expanded). Todo el texto va también en aria-label.
 */
export function InfoMarker({
  icon: Icon,
  tone,
  tip,
  badge,
  shape = "circle",
  dashed,
  size = "md",
}: {
  icon: LucideIcon;
  tone: Tone;
  tip: TipContent;
  badge?: string;
  shape?: "circle" | "square";
  dashed?: boolean;
  size?: "sm" | "md";
}) {
  const [open, setOpen] = useState(false);
  return (
    <button
      type="button"
      aria-label={tipText(tip)}
      aria-expanded={open}
      onClick={() => setOpen((o) => !o)}
      onKeyDown={(e) => {
        if (e.key === "Escape") setOpen(false);
      }}
      className="group relative grid place-items-center rounded-full p-0.5 outline-offset-2"
    >
      <span
        className={cn(
          "grid place-items-center border-2 border-bg shadow-md",
          shape === "circle" ? "rounded-full" : "rounded-[5px]",
          size === "sm" ? "size-6 pointer-coarse:size-8" : "size-7 pointer-coarse:size-9",
          TONE_SOLID[tone],
          tone === "neutral" && "border-line-strong",
          dashed && "border-dashed",
        )}
      >
        <Icon className={size === "sm" ? "size-3.5" : "size-4"} aria-hidden />
      </span>
      {badge && (
        <span
          aria-hidden
          className="absolute -right-1.5 -top-1.5 min-w-4 rounded-full border border-bg bg-text px-1 text-center font-mono text-[10px] font-bold leading-4 text-bg"
        >
          {badge}
        </span>
      )}
      <MarkerTip open={open}>
        <TipBody tip={tip} />
      </MarkerTip>
    </button>
  );
}

/** Marcador principal del incidente: icono por tipo; pulso si hay personas en riesgo. */
export function IncidentMarker({
  icon: Icon,
  label,
  atRisk,
  onActivate,
}: {
  icon: LucideIcon;
  label: string;
  atRisk: boolean;
  onActivate: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onActivate}
      aria-label={label}
      title={label}
      className="relative grid size-12 place-items-center rounded-full"
    >
      {atRisk && <span aria-hidden className="absolute inset-1 animate-ping rounded-full bg-critical/60" />}
      <span
        className={cn(
          "relative grid size-10 place-items-center rounded-full border-2 border-bg shadow-lg ring-4",
          atRisk ? "bg-critical text-on-solid ring-critical/35" : "bg-fire text-on-solid ring-fire/30",
        )}
      >
        <Icon className="size-5" aria-hidden />
      </span>
    </button>
  );
}

/** Cámara M<n>: abre el medio. Borde punteado si la posición o el rumbo los estimó la IA. */
export function CameraMarker({
  label,
  kind,
  drone,
  estimated,
  tip,
  onOpen,
}: {
  label: string;
  kind: "video" | "photo" | "frames";
  drone: boolean;
  estimated: boolean;
  tip: TipContent;
  onOpen?: () => void;
}) {
  const Icon = drone ? Drone : kind === "video" ? Video : Camera;
  const body = (
    <>
      <span
        className={cn(
          "inline-flex h-7 items-center gap-1 rounded-full border-2 px-2 font-mono text-xs font-bold shadow-md pointer-coarse:h-9",
          estimated ? "border-dashed border-info bg-surface text-info" : "border-bg bg-info text-on-solid",
        )}
      >
        <Icon className="size-3.5" aria-hidden />
        {label}
      </span>
      <MarkerTip>
        <TipBody tip={tip} />
      </MarkerTip>
    </>
  );
  if (!onOpen) {
    return (
      <span role="img" aria-label={tipText(tip)} className="group relative inline-flex">
        {body}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Abrir ${tipText(tip)}`}
      className="group relative inline-flex rounded-full"
    >
      {body}
    </button>
  );
}

/** Posición actual del dron: flecha orientada con su rumbo, etiqueta D<n> y altura. */
export function DroneMarker({
  label,
  headingDeg,
  altitudeM,
  active,
  tip,
}: {
  label: string;
  headingDeg: number;
  altitudeM: number | null;
  active: boolean;
  tip: TipContent;
}) {
  const [open, setOpen] = useState(false);
  return (
    <button
      type="button"
      aria-label={tipText(tip)}
      aria-expanded={open}
      onClick={() => setOpen((o) => !o)}
      onKeyDown={(e) => {
        if (e.key === "Escape") setOpen(false);
      }}
      className="group relative flex flex-col items-center rounded-full"
    >
      <span
        className={cn(
          "grid size-8 place-items-center rounded-full border-2 border-bg shadow-md",
          active ? "bg-drone text-on-solid" : "bg-surface-2 text-drone",
        )}
      >
        <Navigation2 className="size-4" style={{ transform: `rotate(${headingDeg}deg)` }} aria-hidden />
      </span>
      <span
        aria-hidden
        className="absolute top-full mt-0.5 inline-flex items-center gap-1 whitespace-nowrap rounded bg-surface/90 px-1 font-mono text-[10px] font-bold text-drone shadow"
      >
        {label}
        {altitudeM !== null && <span className="text-text">· {Math.round(altitudeM)} m</span>}
      </span>
      <MarkerTip open={open}>
        <TipBody tip={tip} />
      </MarkerTip>
    </button>
  );
}

/** Etiqueta de distancia de un anillo (decorativa: el valor ya está en la leyenda). */
export function RingLabel({ children }: { children: ReactNode }) {
  return (
    <span
      aria-hidden
      className="pointer-events-none mb-0.5 block rounded bg-surface/75 px-1 font-mono text-[10px] leading-4 text-muted"
    >
      {children}
    </span>
  );
}
