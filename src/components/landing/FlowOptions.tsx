/**
 * «Flujo de información» de la portada: sin panel ni cajas, tres niveles unidos por una
 * línea fina, en blanco sobre la foto. Cada nivel dice qué entra, qué hace y qué sale.
 */

const LEVELS: { label: string; items: string; detail: string; main?: boolean }[] = [
  { label: "Fuentes", items: "Vecinos · Dron · Radio", detail: "Video por QR sin cuenta, cuadros del dron con GPS y la radio por Zello." },
  {
    label: "vigilia",
    items: "Personas · Fuego · Riesgos · 3D",
    detail: "Cruza las fuentes, cita de dónde sale cada dato y avisa lo nuevo cada 2 s.",
    main: true,
  },
  { label: "Mando", items: "Oficial a cargo · Unidades en ruta", detail: "Ficha en la mesa de mando, briefing en la tablet y voz por Zello." },
];

export function FlowMinimal() {
  return (
    <ol className="relative flex flex-col gap-10 text-white lg:ml-auto lg:w-full lg:max-w-lg">
      <span aria-hidden="true" className="absolute top-2 bottom-2 left-[5px] w-px bg-white/35" />
      {LEVELS.map((l) => (
        <li key={l.label} className="relative flex gap-6">
          <span
            aria-hidden="true"
            className={
              l.main
                ? "mt-2 size-[11px] shrink-0 rounded-full bg-brand-amber ring-4 ring-brand-amber/25"
                : "mt-1.5 size-[11px] shrink-0 rounded-full border-2 border-white"
            }
          />
          <div className="min-w-0">
            <p className={l.main ? "font-display text-2xl font-bold" : "font-mono text-[12px] tracking-[0.14em] text-white/65 uppercase"}>{l.label}</p>
            <p className="mt-2 text-[18px] font-semibold text-white">{l.items}</p>
            <p className="mt-1 text-[15px] leading-relaxed text-white/70">{l.detail}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}
