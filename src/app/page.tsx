import Link from "next/link";
import type { ReactNode } from "react";
import {
  ArrowRight,
  Boxes,
  Drone,
  EyeOff,
  FlaskConical,
  Gauge,
  MonitorDot,
  Radio,
  Route,
  ShieldCheck,
  Smartphone,
  UserRound,
  Video,
  type LucideIcon,
} from "lucide-react";
import { Logo } from "@/components/brand/Logo";
import { Wordmark } from "@/components/brand/Wordmark";
import { cn } from "@/lib/cn";

const STEPS: { icon: LucideIcon; title: string; body: string }[] = [
  { icon: Smartphone, title: "Vecinos graban", body: "Escanean el QR y envían video. Sin cuenta." },
  { icon: Boxes, title: "vigilia analiza", body: "Detecta personas, fuego y riesgos. Arma el 3D." },
  { icon: ShieldCheck, title: "El mando decide", body: "Una ficha clara, en ruta y en el puesto de mando." },
];

const FEATURES: { icon: LucideIcon; title: string; body: string }[] = [
  { icon: Boxes, title: "Mapa 3D", body: "La casa, el foco y los accesos." },
  { icon: UserRound, title: "Personas atrapadas", body: "Con su confianza y su fuente." },
  { icon: Radio, title: "Radio resumida", body: "Claves y unidades, al día." },
  { icon: Route, title: "Briefing en ruta", body: "Llegan sabiendo a qué van." },
];

const PRINCIPLES: { icon: LucideIcon; title: string; body: string }[] = [
  { icon: Gauge, title: "Confianza visible", body: "Cada dato dice qué tan seguro es." },
  { icon: EyeOff, title: "«No se ve» no es «no hay»", body: "Solo una unidad en el lugar descarta." },
  { icon: FlaskConical, title: "Nada simulado pasa por real", body: "Lo de demostración va rotulado." },
];

const SOURCES: { icon: LucideIcon; label: string }[] = [
  { icon: Smartphone, label: "Vecinos" },
  { icon: Drone, label: "Dron" },
  { icon: Radio, label: "Radio" },
];

const FINDINGS = ["Personas", "Fuego", "Riesgos", "3D"];

/** Botón de la portada (enlace), con variantes para fondo claro u oscuro. */
function Cta({
  href,
  icon: Icon,
  children,
  variant,
  size = "lg",
}: {
  href: string;
  icon: LucideIcon;
  children: ReactNode;
  variant: "light" | "glass" | "dark" | "outline";
  size?: "sm" | "lg";
}) {
  return (
    <Link
      href={href}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-full font-bold transition-colors",
        size === "lg" ? "h-14 px-7 text-[17px]" : "h-9 px-4 text-[14px]",
        variant === "light" && "bg-white text-text hover:bg-white/90",
        variant === "glass" && "border border-white/35 bg-white/10 text-white backdrop-blur-md hover:bg-white/20",
        variant === "dark" && "bg-text text-white hover:bg-text/85",
        variant === "outline" && "border border-line-strong text-text hover:bg-surface-2",
      )}
    >
      <Icon className={size === "lg" ? "size-5" : "size-4"} aria-hidden="true" />
      {children}
    </Link>
  );
}

/** Portada: qué es vigilia, cómo funciona y accesos al puesto de mando y al reporte de vecinos. */
export default function Home() {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-40 border-b border-line bg-white/85 backdrop-blur-xl">
        <div className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between gap-4 px-4 sm:px-6">
          <Wordmark size="sm" href="/" />
          <nav aria-label="Secciones" className="hidden items-center gap-7 text-[15px] font-medium text-muted md:flex">
            <a href="#como-funciona" className="hover:text-text">
              Cómo funciona
            </a>
            <a href="#que-ve" className="hover:text-text">
              Qué ve el mando
            </a>
            <a href="#principios" className="hover:text-text">
              Principios
            </a>
          </nav>
          <div className="flex items-center gap-2">
            <span className="hidden sm:inline-flex">
              <Cta href="/reportar" icon={Video} variant="outline" size="sm">
                Soy vecino
              </Cta>
            </span>
            <Cta href="/mando" icon={MonitorDot} variant="dark" size="sm">
              Puesto de mando
            </Cta>
          </div>
        </div>
      </header>

      <main className="flex-1">
        {/* Portada sobre el timelapse real de Santiago desde el San Cristóbal (Costanera Center y cordillera). */}
        <section aria-labelledby="portada-titulo" className="relative isolate overflow-hidden">
          <picture
            className="pointer-events-none absolute inset-0 -z-10 bg-cover bg-bottom"
            style={{ backgroundImage: "url(/portada/santiago-poster.jpg)" }}
          >
            <source srcSet="/portada/santiago-poster.jpg" media="(prefers-reduced-motion: reduce)" />
            <img src="/portada/santiago.gif" alt="" className="size-full object-cover object-bottom" />
          </picture>
          {/* Velo Carbón suave: el texto blanco (con sombra) se lee sin apagar la ciudad. */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 -z-10 bg-gradient-to-r from-[#151A21]/55 via-[#151A21]/20 to-transparent max-lg:bg-[#151A21]/40"
          />

          <div className="mx-auto grid min-h-[min(88dvh,980px)] w-full max-w-7xl items-center gap-12 px-4 py-20 sm:px-6 md:py-32 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:gap-16">
            <div className="flex min-w-0 flex-col gap-8">
              <h1
                id="portada-titulo"
                className="font-display text-5xl leading-[1.05] font-bold tracking-[-0.03em] text-white [text-shadow:0_2px_24px_rgb(0_0_0/0.45)] sm:text-6xl"
              >
                La emergencia, vista antes de llegar.
              </h1>
              <p className="max-w-xl text-xl leading-relaxed text-white [text-shadow:0_1px_12px_rgb(0_0_0/0.55)]">
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

            <FlowCard />
          </div>
        </section>

        <section id="como-funciona" aria-labelledby="como-funciona-titulo" className="scroll-mt-16 border-b border-line">
          <div className="mx-auto w-full max-w-7xl px-4 py-20 sm:px-6 md:py-28">
            <SectionTitle id="como-funciona-titulo" eyebrow="Cómo funciona">
              De un video a una decisión.
            </SectionTitle>
            {/* Flujo: tres pasos unidos por una línea, sin cajas. */}
            <ol className="relative mt-14 grid gap-10 md:grid-cols-3 md:gap-8">
              <span
                aria-hidden="true"
                className="absolute top-7 right-[16.5%] left-[16.5%] hidden h-px bg-gradient-to-r from-brand-red via-brand-amber to-[#30A46C] md:block"
              />
              <span aria-hidden="true" className="absolute top-7 bottom-7 left-7 w-px bg-gradient-to-b from-brand-red via-brand-amber to-[#30A46C] md:hidden" />
              {STEPS.map((s, i) => (
                <li key={s.title} className="relative flex gap-5 md:flex-col md:items-center md:text-center">
                  <span className="relative grid size-14 shrink-0 place-items-center rounded-full border border-line bg-white shadow-[0_4px_16px_rgb(21_26_33/0.08)]">
                    <s.icon className="size-6 text-text" aria-hidden="true" />
                    <span className="absolute -top-1 -right-1 grid size-6 place-items-center rounded-full bg-text font-mono text-[11px] text-white">
                      {i + 1}
                    </span>
                  </span>
                  <div className="md:mt-2">
                    <h3 className="font-display text-2xl font-bold tracking-[-0.01em]">
                      <span className="sr-only">Paso {i + 1}: </span>
                      {s.title}
                    </h3>
                    <p className="mt-2 max-w-xs text-[17px] leading-relaxed text-muted md:mx-auto">{s.body}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section id="que-ve" aria-labelledby="que-ve-titulo" className="scroll-mt-16 border-b border-line bg-surface-2">
          <div className="mx-auto grid w-full max-w-7xl items-center gap-14 px-4 py-20 sm:px-6 md:py-28 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
            <div>
              <SectionTitle id="que-ve-titulo" eyebrow="Qué ve el mando">
                Lo crítico, primero.
              </SectionTitle>
              {/* Lista corrida, sin tarjetas: cada línea es lo que el oficial ve en la ficha. */}
              <ul className="mt-10 flex flex-col">
                {FEATURES.map((f) => (
                  <li key={f.title} className="flex items-baseline gap-4 border-t border-line py-4 last:border-b">
                    <f.icon className="size-5 shrink-0 translate-y-0.5 text-brand-red" aria-hidden="true" />
                    <span className="font-display text-xl font-bold">{f.title}</span>
                    <span className="ml-auto hidden text-right text-[16px] text-muted sm:inline">{f.body}</span>
                  </li>
                ))}
              </ul>
            </div>
            {/* La ficha real de un incidente de demostración. */}
            <figure className="overflow-hidden rounded-2xl border border-line bg-white shadow-[0_30px_80px_rgb(21_26_33/0.18)]">
              {/* eslint-disable-next-line @next/next/no-img-element -- captura estática, ya optimizada (190 KB) */}
              <img src="/portada/ficha.jpg" alt="Ficha de un incendio estructural: mapa 3D con la casa afectada, personas atrapadas y el historial de Vigía" className="block w-full" />
            </figure>
          </div>
        </section>

        <section id="principios" aria-labelledby="principios-titulo" className="scroll-mt-16">
          <div className="mx-auto grid w-full max-w-7xl gap-12 px-4 py-20 sm:px-6 md:py-28 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
            <SectionTitle id="principios-titulo" eyebrow="Principios">
              La IA informa. Decide el oficial.
            </SectionTitle>
            <dl className="flex flex-col divide-y divide-line">
              {PRINCIPLES.map((p) => (
                <div key={p.title} className="flex items-start gap-5 py-6 first:pt-0">
                  <span className="grid size-11 shrink-0 place-items-center rounded-full bg-brand-amber/15">
                    <p.icon className="size-5 text-[#8f5a12]" aria-hidden="true" />
                  </span>
                  <div>
                    <dt className="font-display text-xl font-bold">{p.title}</dt>
                    <dd className="mt-1 text-[17px] text-muted">{p.body}</dd>
                  </div>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <section aria-labelledby="cierre-titulo" className="px-4 pb-20 sm:px-6">
          <div className="relative mx-auto flex w-full max-w-7xl flex-col items-start gap-8 overflow-hidden rounded-[32px] bg-text px-8 py-14 sm:px-14 md:flex-row md:items-center md:justify-between">
            <div
              aria-hidden="true"
              className="pointer-events-none absolute -top-24 -right-16 size-72 rounded-full bg-brand-amber/25 blur-3xl"
            />
            <div className="relative flex items-center gap-5">
              <Logo size={64} title="" />
              <h2 id="cierre-titulo" className="font-display text-3xl leading-tight font-bold tracking-[-0.02em] text-white sm:text-4xl">
                Una sola lectura
                <br />
                del incidente.
              </h2>
            </div>
            <div className="relative flex flex-col gap-3 sm:flex-row">
              <Cta href="/mando" icon={MonitorDot} variant="light">
                Puesto de mando
              </Cta>
              <Cta href="/reportar" icon={Video} variant="glass">
                Soy vecino
              </Cta>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-2 px-4 py-6 text-sm text-faint sm:flex-row sm:items-center sm:justify-between sm:px-6">
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

function SectionTitle({ id, eyebrow, children }: { id: string; eyebrow: string; children: ReactNode }) {
  return (
    <div>
      <p className="text-[13px] font-semibold tracking-[0.12em] text-brand-red uppercase">{eyebrow}</p>
      <h2 id={id} className="mt-3 max-w-2xl font-display text-4xl leading-tight font-bold tracking-[-0.02em] sm:text-5xl">
        {children}
      </h2>
    </div>
  );
}

/** Esquema del flujo, sin fondo sobre la foto: tres fuentes convergen en vigilia y se reparten al mando. */
function FlowCard() {
  return (
    <div className="text-white">
      <div className="flex items-center justify-between">
        <p className="font-display text-lg font-bold [text-shadow:0_1px_10px_rgb(0_0_0/0.5)]">Flujo de información</p>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-2.5 py-1 text-[12px] font-semibold backdrop-blur-md">
          <span className="size-1.5 rounded-full bg-brand-red motion-safe:animate-pulse" aria-hidden="true" />
          En vivo
        </span>
      </div>

      <ul className="mt-5 grid grid-cols-3 gap-3" aria-label="Fuentes">
        {SOURCES.map((s) => (
          <li key={s.label} className="flex flex-col items-center gap-2 rounded-2xl border border-white/25 bg-white/10 px-2 py-4 backdrop-blur-md">
            <s.icon className="size-6" aria-hidden="true" />
            <span className="text-[15px] font-semibold">{s.label}</span>
          </li>
        ))}
      </ul>

      {/* Las tres fuentes convergen */}
      <svg viewBox="0 0 300 36" className="h-9 w-full" aria-hidden="true" preserveAspectRatio="none">
        <path d="M50 0 C50 22 150 14 150 36 M150 0 V36 M250 0 C250 22 150 14 150 36" fill="none" stroke="rgb(255 255 255 / 0.55)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      </svg>

      <div className="flex items-center gap-4 rounded-2xl border border-white/15 bg-[#151A21]/70 px-5 py-4 backdrop-blur-md">
        <Logo size={40} title="" />
        <div className="min-w-0">
          <p className="font-display text-[17px] font-bold">vigilia analiza</p>
          <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Qué busca">
            {FINDINGS.map((f) => (
              <li key={f} className="rounded-full bg-white/12 px-2.5 py-0.5 text-[13px] font-medium text-white/90">
                {f}
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* Se reparte al mando */}
      <svg viewBox="0 0 300 36" className="h-9 w-full" aria-hidden="true" preserveAspectRatio="none">
        <path d="M150 0 C150 22 75 14 75 36 M150 0 C150 22 225 14 225 36" fill="none" stroke="rgb(255 255 255 / 0.55)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      </svg>

      <div className="grid grid-cols-2 gap-3">
        <FlowEnd icon={ShieldCheck} title="Oficial a cargo" detail="Revisa y decide" />
        <FlowEnd icon={Route} title="Unidades en ruta" detail="Llegan informadas" />
      </div>
      <Link href="/mando" className="mt-5 inline-flex items-center gap-1.5 text-[15px] font-semibold [text-shadow:0_1px_10px_rgb(0_0_0/0.5)] hover:gap-2.5">
        Ver un incidente
        <ArrowRight className="size-4 transition-all" aria-hidden="true" />
      </Link>
    </div>
  );
}

function FlowEnd({ icon: Icon, title, detail }: { icon: LucideIcon; title: string; detail: string }) {
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-white/25 bg-white/10 px-4 py-3.5 backdrop-blur-md">
      <span className="grid size-10 shrink-0 place-items-center rounded-full bg-[#30A46C]/25">
        <Icon className="size-5 text-[#7ee2ae]" aria-hidden="true" />
      </span>
      <div className="min-w-0">
        <p className="text-[16px] font-bold">{title}</p>
        <p className="text-[14px] text-white/75">{detail}</p>
      </div>
    </div>
  );
}
