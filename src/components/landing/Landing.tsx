import Link from "next/link";
import type { ReactNode } from "react";
import { MonitorDot, Video, type LucideIcon } from "lucide-react";
import { Logo } from "@/components/brand/Logo";
import { FichaShowcase } from "./FichaShowcase";
import { FlowMinimal } from "./FlowOptions";
import { LandingHeader } from "./LandingHeader";
import { cn } from "@/lib/cn";

/** Reglas que sigue la IA (las mismas reglas duras del agente y de la ficha). */
const RULES: { title: string; body: string }[] = [
  { title: "Informa, no decide", body: "No dice por dónde entrar ni si es seguro. La decisión es del oficial a cargo." },
  { title: "Confianza en cada dato", body: "Alta, media o baja, siempre a la vista junto al hallazgo." },
  { title: "Cita su fuente", body: "Cada hallazgo dice de dónde sale: el video M1, la radio C5, el dron D1." },
  { title: "«No se ve» no es «no hay»", body: "Sin evidencia no descarta nada. Solo una unidad en el lugar puede hacerlo." },
  { title: "Habla poco", body: "Un mensaje por radio cada ~20 s, salvo que haya una persona en riesgo." },
  { title: "Nada simulado pasa por real", body: "Sin IA configurada funciona igual, y todo queda rotulado como simulado." },
];

/** Datos del sistema (medidos en la demo). */
const FACTS: { value: string; label: string }[] = [
  { value: "~4 s", label: "de la pregunta por radio a la respuesta de Vigía" },
  { value: "2 s", label: "ciclo del agente: observa, cruza fuentes y avisa" },
  { value: "3", label: "fuentes cruzadas: vecinos, dron y radio" },
  { value: "0", label: "cuentas para el vecino: escanea el QR y envía" },
];

const STACK = ["Claude (visión y agente)", "YOLOE + pose en el dron", "Reconstrucción 3DGS en GPU", "Zello", "ElevenLabs", "Next.js en Cloud Run", "Postgres"];

/** Botón de la portada (enlace), para fondo oscuro. */
function Cta({ href, icon: Icon, children, variant }: { href: string; icon: LucideIcon; children: ReactNode; variant: "light" | "glass" }) {
  return (
    <Link
      href={href}
      className={cn(
        "inline-flex h-12 items-center justify-center gap-2 rounded-full px-6 text-[15px] font-bold transition-colors sm:h-14 sm:px-7 sm:text-[17px]",
        variant === "light" ? "bg-white text-text hover:bg-white/90" : "border border-white/35 bg-white/10 text-white backdrop-blur-md hover:bg-white/20",
      )}
    >
      <Icon className="size-4 sm:size-5" aria-hidden="true" />
      {children}
    </Link>
  );
}

function SectionTitle({ id, eyebrow, children, tone = "light" }: { id: string; eyebrow: string; children: ReactNode; tone?: "light" | "dark" }) {
  return (
    <div>
      <p className={cn("text-[12px] font-semibold tracking-[0.12em] uppercase sm:text-[13px]", tone === "dark" ? "text-brand-amber" : "text-brand-red")}>{eyebrow}</p>
      <h2
        id={id}
        className={cn("mt-3 max-w-2xl font-display text-[28px] leading-tight font-bold tracking-[-0.02em] sm:text-4xl lg:text-5xl", tone === "dark" && "text-white")}
      >
        {children}
      </h2>
    </div>
  );
}

/** Portada: qué es vigilia, la ficha del oficial, las reglas de la IA y la tecnología. */
export function Landing() {
  return (
    <div className="flex min-h-dvh flex-col">
      <LandingHeader />

      <main className="flex-1">
        {/* Portada a pantalla completa sobre Santiago de noche (foto de Unsplash, licencia libre). */}
        <section aria-labelledby="portada-titulo" className="relative isolate overflow-hidden bg-[#18212C]">
          {/* eslint-disable-next-line @next/next/no-img-element -- foto de fondo fija */}
          <img src="/portada/fotos/santiago-noche.jpg" alt="" className="pointer-events-none absolute inset-0 -z-10 size-full object-cover" />
          {/* Velo gris azulado: oscurece la foto y deja leer el texto sin apagar las luces de la ciudad. */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 -z-10 bg-gradient-to-r from-[#141C26]/54 via-[#1A2430]/42 to-[#1A2430]/24"
          />
          <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-40 bg-gradient-to-t from-[#141C26]/48 to-transparent" />

          <div className="mx-auto grid min-h-dvh w-full max-w-7xl items-center gap-14 px-5 pt-24 pb-16 sm:px-6 sm:pt-28 sm:pb-20 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-16">
            <div className="flex min-w-0 flex-col gap-8">
              <h1
                id="portada-titulo"
                className="font-display text-[34px] leading-[1.08] font-bold tracking-[-0.03em] text-white [text-shadow:0_2px_24px_rgb(0_0_0/0.45)] sm:text-5xl lg:text-6xl"
              >
                La emergencia, vista antes de llegar.
              </h1>
              <p className="max-w-xl text-[16px] leading-relaxed text-white [text-shadow:0_1px_12px_rgb(0_0_0/0.55)] sm:text-xl">
                Reúne los videos de los vecinos, el dron y la radio en una sola ficha, para que el oficial a cargo decida
                con más información y las unidades lleguen sabiendo a qué van.
              </p>
              <div className="flex flex-col gap-3 sm:flex-row">
                <Cta href="/mando" icon={MonitorDot} variant="light">
                  Puesto de mando
                </Cta>
                <Cta href="/reportar" icon={Video} variant="glass">
                  Soy vecino: enviar video
                </Cta>
              </div>
            </div>

            <FlowMinimal />
          </div>
        </section>

        <section id="ficha" aria-labelledby="ficha-titulo" className="scroll-mt-24 border-b border-line bg-surface-2">
          <div className="mx-auto w-full max-w-7xl px-4 py-16 sm:px-6 sm:py-20 md:py-28">
            <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between lg:gap-12">
              <SectionTitle id="ficha-titulo" eyebrow="La ficha del oficial">
                Todo el incidente en una pantalla.
              </SectionTitle>
              <p className="max-w-md text-[15px] leading-relaxed text-muted sm:text-[17px] lg:pb-1.5 lg:text-right">
                Mapa 3D con la casa y el foco, personas atrapadas, riesgos, unidades y lo que dice Vigía. Se lee en tres
                segundos desde tres metros.
              </p>
            </div>
            <FichaShowcase className="mt-12 md:mt-14" />
          </div>
        </section>

        <section id="reglas" aria-labelledby="reglas-titulo" className="scroll-mt-24">
          <div className="mx-auto w-full max-w-7xl px-4 py-16 sm:px-6 sm:py-20 md:py-28">
            <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between lg:gap-12">
              <SectionTitle id="reglas-titulo" eyebrow="Reglas de la IA">
                La IA informa. Decide el oficial.
              </SectionTitle>
              <p className="max-w-md text-[15px] leading-relaxed text-muted sm:text-[17px] lg:pb-1.5 lg:text-right">
                Son reglas duras: el agente no puede saltárselas y la ficha las aplica en cada dato.
              </p>
            </div>
            <ol className="mt-14 grid gap-x-12 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
              {RULES.map((r, i) => (
                <li key={r.title} className="border-t border-line pt-6">
                  <span className="font-mono text-[13px] text-brand-red tabular" aria-hidden="true">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <h3 className="mt-3 font-display text-lg font-bold sm:text-xl">{r.title}</h3>
                  <p className="mt-2 text-[15px] leading-relaxed text-muted sm:text-[16px]">{r.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section id="tecnologia" aria-labelledby="tecnologia-titulo" className="scroll-mt-24 bg-[#18212C]">
          <div className="mx-auto w-full max-w-7xl px-4 py-16 sm:px-6 sm:py-20 md:py-28">
            <SectionTitle id="tecnologia-titulo" eyebrow="Tecnología" tone="dark">
              Hecho para el terreno.
            </SectionTitle>
            <dl className="mt-14 grid gap-x-10 gap-y-10 sm:grid-cols-2 lg:grid-cols-4">
              {FACTS.map((f) => (
                <div key={f.label} className="border-t border-white/15 pt-6">
                  <dt className="sr-only">{f.label}</dt>
                  <dd>
                    <span className="block font-display text-4xl font-bold tracking-[-0.02em] text-white tabular sm:text-5xl">{f.value}</span>
                    <span className="mt-2 block text-[15px] leading-relaxed text-white/65 sm:mt-3 sm:text-[16px]">{f.label}</span>
                  </dd>
                </div>
              ))}
            </dl>
            <ul className="mt-14 flex flex-wrap gap-2" aria-label="Tecnologías">
              {STACK.map((s) => (
                <li key={s} className="rounded-full border border-white/15 px-3 py-1 text-[13px] text-white/80 sm:px-3.5 sm:py-1.5 sm:text-[14px]">
                  {s}
                </li>
              ))}
            </ul>
            <div className="mt-16 flex flex-col items-start gap-6 border-t border-white/15 pt-10 md:flex-row md:items-center md:justify-between">
              <p className="flex items-center gap-4 font-display text-xl font-bold text-white sm:text-3xl">
                <Logo size={44} title="" />
                Pruébalo con un incidente de demostración.
              </p>
              <div className="flex flex-col gap-3 sm:flex-row">
                <Cta href="/mando" icon={MonitorDot} variant="light">
                  Puesto de mando
                </Cta>
                <Cta href="/reportar" icon={Video} variant="glass">
                  Soy vecino
                </Cta>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="bg-[#141C26]">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-2 px-4 py-6 text-sm text-white/50 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <span className="inline-flex items-center gap-2">
            <Logo size={20} title="" />
            vigilia · Puesto de mando asistido por IA para Bomberos
          </span>
          <span>Platanus Hack 26</span>
        </div>
      </footer>
    </div>
  );
}
