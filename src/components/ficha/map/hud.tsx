"use client";
/**
 * HUD técnico sobre el mapa 3D (el mismo lenguaje del esquema): retícula en el centro del
 * hueco entre paneles, cinta de rumbo arriba y caja de norte y escala abajo a la izquierda.
 * Se actualiza con cada movimiento del mapa escribiendo el DOM directo, sin re-render.
 */
import { useEffect, useRef } from "react";
import type { Map as MlMap } from "maplibre-gl";
import { niceScaleLength } from "@/components/scene3d/geometry";
import type { Padding } from "./FichaMap";

const TAPE_PX = 4;
const TAPE_DEGS = Array.from({ length: 1080 / 5 + 1 }, (_, i) => i * 5 - 360);
const CARDINAL: Record<number, string> = { 0: "N", 90: "E", 180: "S", 270: "O" };

function tapeLabel(d: number): string {
  const n = ((d % 360) + 360) % 360;
  return CARDINAL[n] ?? String(n / 10).padStart(2, "0");
}

/** Metros por píxel en el centro (teselas de 512 px; con inclinación es aproximado). */
function metersPerPixel(map: MlMap): number {
  const lat = map.getCenter().lat;
  return (40075016.686 * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** map.getZoom());
}

export function MapHud({ map, padding }: { map: MlMap | null; padding: Padding }) {
  const tapeRef = useRef<HTMLDivElement | null>(null);
  const headingRef = useRef<HTMLSpanElement | null>(null);
  const northRef = useRef<HTMLDivElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const scaleRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!map) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const heading = Math.round(((map.getBearing() % 360) + 360) % 360);
      if (tapeRef.current) tapeRef.current.style.transform = `translateX(${-(heading + 360) * TAPE_PX}px)`;
      if (headingRef.current) headingRef.current.textContent = `${String(heading).padStart(3, "0")}°`;
      if (northRef.current) northRef.current.style.transform = `rotate(${-heading}deg)`;
      const mpp = metersPerPixel(map);
      const len = niceScaleLength(mpp, 80);
      if (barRef.current) barRef.current.style.width = `${Math.max(12, Math.min(160, Math.round(len / mpp)))}px`;
      if (scaleRef.current) scaleRef.current.textContent = `≈ ${len} m`;
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    map.on("move", schedule);
    schedule();
    return () => {
      map.off("move", schedule);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [map]);

  const reticle = 120;
  const line = `calc(50% - ${reticle / 2 + 18}px)`;
  return (
    <div
      aria-hidden="true"
      className="@container pointer-events-none absolute z-[1]"
      style={{ top: padding.top, right: padding.right, bottom: padding.bottom, left: padding.left }}
    >
      {/* Retícula: el centro del hueco es el centro de la vista */}
      <div className="absolute top-1/2 left-0 h-px bg-f-ink/12" style={{ width: line }} />
      <div className="absolute top-1/2 right-0 h-px bg-f-ink/12" style={{ width: line }} />
      <div className="absolute top-0 left-1/2 w-px bg-f-ink/12" style={{ height: line }} />
      <div className="absolute bottom-0 left-1/2 w-px bg-f-ink/12" style={{ height: line }} />
      <div className="absolute top-1/2 left-1/2 -translate-1/2" style={{ width: reticle, height: reticle }}>
        <span className="absolute top-0 left-0 size-4 border-t border-l border-f-ink/45" />
        <span className="absolute top-0 right-0 size-4 border-t border-r border-f-ink/45" />
        <span className="absolute bottom-0 left-0 size-4 border-b border-l border-f-ink/45" />
        <span className="absolute right-0 bottom-0 size-4 border-r border-b border-f-ink/45" />
        <span className="absolute inset-[30%] rounded-full border border-dashed border-f-ink/25" />
      </div>

      {/* Cinta de rumbo (hacia dónde mira el mapa) */}
      <div className="absolute top-1 left-1/2 hidden -translate-x-1/2 flex-col items-center text-f-ink/70 @min-[30rem]:flex">
        <div className="relative h-6 w-[220px] overflow-hidden [mask-image:linear-gradient(90deg,transparent,#000_20%,#000_80%,transparent)]">
          <div ref={tapeRef} className="absolute top-0 left-1/2 h-full">
            {TAPE_DEGS.map((d) => (
              <span key={d} className="absolute top-0 flex -translate-x-1/2 flex-col items-center" style={{ left: (d + 360) * TAPE_PX }}>
                <span className={d % 10 === 0 ? "h-2 w-px bg-f-ink/60" : "h-1 w-px bg-f-ink/30"} />
                {d % 10 === 0 && <span className="mt-0.5 font-mono text-[10px] leading-none">{tapeLabel(d)}</span>}
              </span>
            ))}
          </div>
        </div>
        <span className="mt-0.5 font-mono text-[11px] leading-none text-f-ink">
          ↑ <span ref={headingRef}>000°</span>
        </span>
      </div>

      {/* Norte y escala: arriba a la derecha del hueco (abajo están el botón de Vigía y el zoom) */}
      <div className="absolute top-0 right-0 flex items-end gap-3 rounded-lg bg-white/85 px-2.5 py-1.5 font-mono text-[11px] text-f-muted shadow-[0_2px_10px_rgb(33_32_28/0.10)] backdrop-blur-md">
        <div className="flex flex-col items-center leading-none">
          <div ref={northRef} className="grid size-5 place-items-center">
            <svg width="12" height="16" viewBox="0 0 12 16">
              <path d="M6 0 L11 14 L6 10.5 L1 14 Z" className="fill-f-ink" />
            </svg>
          </div>
          <span className="mt-0.5 text-[11px] font-semibold text-f-ink">N</span>
        </div>
        <div className="flex flex-col items-start gap-0.5">
          <div ref={barRef} className="flex h-1.5 border border-f-ink" style={{ width: 80 }}>
            <div className="h-full w-1/2 bg-f-ink" />
          </div>
          <span ref={scaleRef} className="tabular" title="Escala aproximada en el centro de la vista">
            ≈ 20 m
          </span>
        </div>
      </div>
    </div>
  );
}
