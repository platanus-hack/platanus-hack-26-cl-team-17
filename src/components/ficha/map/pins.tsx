"use client";
/**
 * Marcadores al estilo Mapbox: punto de color con borde blanco y una píldora blanca
 * (radio 8 px, sombra suave, texto oscuro de 15 px). Las personas se dibujan con un
 * ícono de figura, nunca con caras. El contenedor del marcador mide 0 × 0: el centro
 * del punto cae exactamente sobre la coordenada.
 */
import { Flag, Flame, MapPin as MapPinIcon, Play, TriangleAlert, Truck, User, Video } from "lucide-react";
import type { MediaView } from "@/lib/contract";
import { cn } from "@/lib/cn";
import type { MapPin, Tone } from "../model";
import { TONE_DOT } from "../tones";

const ICON_SIZE: Record<MapPin["kind"], string> = {
  person: "size-7",
  fire: "size-7",
  hazard: "size-6",
  unit: "size-7",
  post: "size-7",
  camera: "size-6",
  dest: "size-8",
};

function PinIcon({ kind }: { kind: MapPin["kind"] }) {
  const cls = "size-[60%] text-white";
  switch (kind) {
    case "person":
      return <User className={cls} strokeWidth={2.6} aria-hidden="true" />;
    case "fire":
      return <Flame className={cls} strokeWidth={2.6} aria-hidden="true" />;
    case "hazard":
      return <TriangleAlert className={cls} strokeWidth={2.6} aria-hidden="true" />;
    case "unit":
      return <Truck className={cls} strokeWidth={2.4} aria-hidden="true" />;
    case "post":
      return <Flag className={cls} strokeWidth={2.6} aria-hidden="true" />;
    case "camera":
      return <Video className={cls} strokeWidth={2.6} aria-hidden="true" />;
    case "dest":
      return <MapPinIcon className={cls} strokeWidth={2.6} aria-hidden="true" />;
  }
}

/** Anillos que se expanden (foco o marcador que Vigía está nombrando). */
function Pulse({ tone, size = "size-16" }: { tone: Tone; size?: string }) {
  return (
    <>
      <span className={cn("pointer-events-none absolute top-0 left-0 -translate-1/2 rounded-full opacity-40 motion-safe:animate-ping", size, TONE_DOT[tone])} />
      <span
        className={cn("pointer-events-none absolute top-0 left-0 -translate-1/2 rounded-full opacity-30 motion-safe:animate-ping [animation-delay:700ms]", size, TONE_DOT[tone])}
      />
    </>
  );
}

export function Halo({ tone }: { tone: Tone }) {
  return (
    <div className="pointer-events-none relative size-0" aria-hidden="true">
      <span className={cn("absolute top-0 left-0 size-24 -translate-1/2 rounded-full opacity-15 blur-md", TONE_DOT[tone])} />
      <Pulse tone={tone} size="size-20" />
    </div>
  );
}

export function PinView({
  pin,
  pulsing,
  open,
  media,
  onToggle,
  onOpenMedia,
}: {
  pin: MapPin;
  pulsing: boolean;
  open: boolean;
  media: MediaView | null;
  onToggle: () => void;
  onOpenMedia: (mediaId: string) => void;
}) {
  const clickable = pin.kind === "camera";
  const label = (
    <span
      data-pin-label
      data-hidden="false"
      data-side="right"
      className={cn(
        "absolute top-0 left-4 flex -translate-y-1/2 data-[side=left]:right-4 data-[side=left]:left-auto items-baseline gap-1.5 rounded-lg bg-paper px-2.5 py-1.5 whitespace-nowrap shadow-[0_2px_12px_rgb(33_32_28/0.16)] transition-opacity duration-200",
        "data-[hidden=true]:pointer-events-none data-[hidden=true]:opacity-0",
        pin.kind === "camera" ? "text-[13px] font-semibold text-f-ink" : "text-[15px] font-semibold text-f-ink",
        pulsing && "ring-2 ring-f-ink/80",
      )}
    >
      {pin.text}
      {pin.sub && <span className="text-[13px] font-medium text-f-muted">{pin.sub}</span>}
    </span>
  );
  const dot = (
    <span
      className={cn(
        "absolute top-0 left-0 grid -translate-1/2 place-items-center rounded-full border-[2.5px] border-white shadow-[0_2px_8px_rgb(33_32_28/0.25)]",
        ICON_SIZE[pin.kind],
        TONE_DOT[pin.tone],
      )}
    >
      <PinIcon kind={pin.kind} />
    </span>
  );

  return (
    <div className="relative size-0" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
      {pulsing && <Pulse tone={pin.tone} />}
      {clickable ? (
        <button type="button" onClick={onToggle} aria-label={`Video ${pin.text}`} aria-expanded={open} className="absolute top-0 left-0 cursor-pointer">
          {dot}
          {label}
        </button>
      ) : (
        <div role="img" aria-label={pin.sub ? `${pin.text}, ${pin.sub}` : pin.text}>
          {dot}
          {label}
        </div>
      )}
      {open && media && <CameraPeek media={media} onOpen={() => onOpenMedia(media.id)} />}
    </div>
  );
}

function clock(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

/** Miniatura del video de un vecino, sobre su cámara. */
function CameraPeek({ media, onOpen }: { media: MediaView; onOpen: () => void }) {
  const thumb = media.urls.poster ?? media.urls.frames[0]?.url ?? null;
  const at = clock(media.captured_at ?? media.created_at);
  return (
    <div className="absolute bottom-6 left-0 w-64 -translate-x-1/2 overflow-hidden rounded-2xl bg-paper shadow-[0_12px_40px_rgb(33_32_28/0.22)]">
      <button type="button" onClick={onOpen} className="group relative block aspect-video w-full bg-f-wash" aria-label={`Ver video ${media.label}`}>
        {thumb ? (
          // eslint-disable-next-line @next/next/no-img-element -- miniatura servida por la API de archivos
          <img src={thumb} alt="" className="size-full object-cover" />
        ) : null}
        <span className="absolute inset-0 grid place-items-center">
          <span className="grid size-11 place-items-center rounded-full bg-paper/92 shadow-md transition-transform group-hover:scale-105">
            <Play className="size-5 translate-x-px fill-f-ink text-f-ink" aria-hidden="true" />
          </span>
        </span>
      </button>
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <span className="text-[15px] font-semibold text-f-ink">{media.label} · vecino</span>
        {at && <span className="font-mono text-[13px] text-f-muted">{at}</span>}
      </div>
    </div>
  );
}
