"use client";

import { ChevronLeft, ChevronRight, Images } from "lucide-react";
import type { BriefingSnapshot } from "@/lib/contract";
import { Dialog } from "@/components/ui";
import { pluralize } from "@/lib/format";
import { BriefSection } from "./parts";

export type KeyFrame = BriefingSnapshot["key_frames"][number];

export function keyFrameLabel(k: Pick<KeyFrame, "media_label" | "frame">): string {
  return k.frame >= 0 ? `${k.media_label} · fotograma ${k.frame + 1}` : k.media_label;
}

/** Grilla de imágenes clave; un toque abre la imagen en pantalla completa. */
export function KeyFramesSection({
  frames,
  mediaCount,
  onOpen,
}: {
  frames: KeyFrame[];
  mediaCount: number;
  onOpen: (index: number) => void;
}) {
  return (
    <BriefSection id="imagenes" title="Imágenes clave" icon={Images}>
      {frames.length === 0 ? (
        <p className="text-lg leading-snug text-muted">
          {mediaCount > 0
            ? `Llegaron ${pluralize(mediaCount, "video o foto", "videos o fotos")}; las imágenes clave aparecen con el análisis.`
            : "Aún no hay imágenes de esta emergencia."}
        </p>
      ) : (
        <ul className="grid grid-cols-2 gap-2.5">
          {frames.map((k, i) => (
            <li key={`${k.media_label}-${k.frame}-${i}`} className="min-w-0">
              <button
                type="button"
                onClick={() => onOpen(i)}
                className="group block w-full overflow-hidden rounded-md border border-line bg-surface-2 text-left hover:border-text"
              >
                <span className="relative block aspect-video bg-black">
                  {/* eslint-disable-next-line @next/next/no-img-element -- URL firmada o de /api/files; next/image no aplica */}
                  <img src={k.url} alt={k.caption || keyFrameLabel(k)} className="size-full object-cover" />
                  <span className="absolute top-1.5 left-1.5 rounded bg-black/75 px-1.5 py-0.5 font-mono text-sm font-semibold text-white">
                    {keyFrameLabel(k)}
                  </span>
                </span>
                {k.caption.trim() && (
                  <span className="line-clamp-2 block px-2 py-1.5 text-base leading-snug text-text">{k.caption}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </BriefSection>
  );
}

/** Imagen clave en pantalla completa con su leyenda; anterior/siguiente con botones grandes. */
export function KeyFrameViewer({
  frames,
  index,
  onChange,
  onClose,
}: {
  frames: KeyFrame[];
  index: number | null;
  onChange: (index: number) => void;
  onClose: () => void;
}) {
  const open = index !== null && index >= 0 && index < frames.length;
  const k = open ? frames[index] : null;
  const many = frames.length > 1;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="full"
      title={k ? keyFrameLabel(k) : "Imagen"}
      bodyClassName="flex flex-col gap-3 p-2 sm:p-3"
      footer={
        <button
          type="button"
          onClick={onClose}
          className="inline-flex min-h-14 w-full items-center justify-center rounded-md border border-line-strong bg-surface-2 px-6 text-lg font-bold text-text sm:w-auto"
        >
          Cerrar
        </button>
      }
    >
      {k && index !== null && (
        <>
          <div className="relative min-h-0 flex-1 overflow-hidden rounded-md bg-black">
            {/* eslint-disable-next-line @next/next/no-img-element -- URL firmada o de /api/files; next/image no aplica */}
            <img src={k.url} alt={k.caption || keyFrameLabel(k)} className="absolute inset-0 size-full object-contain" />
          </div>
          <div className="flex items-center gap-2">
            {many && (
              <button
                type="button"
                aria-label="Imagen anterior"
                onClick={() => onChange((index - 1 + frames.length) % frames.length)}
                className="grid size-14 shrink-0 place-items-center rounded-md border border-line-strong bg-surface-2 text-text"
              >
                <ChevronLeft aria-hidden className="size-8" />
              </button>
            )}
            <p className="min-w-0 flex-1 text-xl leading-snug text-text">{k.caption || "Sin leyenda"}</p>
            {many && (
              <button
                type="button"
                aria-label="Imagen siguiente"
                onClick={() => onChange((index + 1) % frames.length)}
                className="grid size-14 shrink-0 place-items-center rounded-md border border-line-strong bg-surface-2 text-text"
              >
                <ChevronRight aria-hidden className="size-8" />
              </button>
            )}
          </div>
        </>
      )}
    </Dialog>
  );
}
