/**
 * «Qué ve el mando»: la ficha real de un incidente de demostración, grande y limpia.
 * Marco claro y fino (como una pantalla, sin barra de navegador), sombra suave y, debajo,
 * lo que el oficial encuentra en ella en una sola línea.
 * La captura es de /mando/<VG-32RT> a 1280 × 800 (ficha.webp) y al doble (ficha@2x.webp).
 */
const PARTS = ["Mapa 3D con la casa y el foco", "Personas atrapadas con su confianza", "Radio resumida", "Briefing en ruta"];

export function FichaShowcase({ className }: { className?: string }) {
  return (
    <div className={className}>
      <figure>
        <div className="rounded-[22px] border border-line bg-white p-2 shadow-[0_50px_120px_-40px_rgb(21_26_33/0.35)] sm:p-2.5">
          {/* eslint-disable-next-line @next/next/no-img-element -- captura estática en WebP con versión 2x */}
          <img
            src="/portada/ficha.webp"
            srcSet="/portada/ficha.webp 1280w, /portada/ficha@2x.webp 2560w"
            sizes="(min-width: 1280px) 1216px, 100vw"
            width={1280}
            height={800}
            alt="Ficha de un incendio estructural: mapa 3D con la casa afectada, personas atrapadas, radio resumida y el historial de Vigía"
            className="block h-auto w-full rounded-[15px]"
          />
        </div>
        <figcaption className="sr-only">Captura de la ficha con un incidente de demostración (datos ficticios).</figcaption>
      </figure>

      <ul className="mt-8 flex flex-wrap items-center justify-center gap-x-3 gap-y-2 text-[15px] text-muted">
        {PARTS.map((p, i) => (
          <li key={p} className="flex items-center gap-3">
            {i > 0 && <span aria-hidden="true" className="size-1 rounded-full bg-line-strong" />}
            {p}
          </li>
        ))}
      </ul>
      <p className="mt-3 text-center text-[12px] text-faint">Datos ficticios de demostración · Mapa: OpenFreeMap · © OpenStreetMap</p>
    </div>
  );
}
