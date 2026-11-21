import type { ReactNode } from "react";
import {
  FlaskConical,
  Gauge,
  SearchX,
  ArrowDown,
  Drone,
  MonitorDot,
  Radio,
  Route,
  ScanEye,
  ShieldCheck,
  Smartphone,
  Video,
  type LucideIcon,
} from "lucide-react";
import { Wordmark } from "@/components/brand/Wordmark";
import { Button } from "@/components/ui/Button";
import { Panel } from "@/components/ui/Panel";

const STEPS: { title: string; body: string }[] = [
  {
    title: "Vecinos graban",
    body: "Desde el teléfono y sin crear cuenta: abren el enlace, graban lo que ven y envían el video.",
  },
  {
    title: "La IA reconstruye y detecta riesgos",
    body: "Busca indicios de personas atrapadas, peligros y accesos, y arma una reconstrucción 3D esquemática de la estructura.",
  },
  {
    title: "Las unidades llegan sabiendo a qué van",
    body: "El briefing llega a las unidades en ruta: lo que se sabe, con qué confianza y lo que aún falta confirmar.",
  },
];

const SOURCES: { icon: LucideIcon; label: string; detail: string }[] = [
  { icon: Smartphone, label: "Video de vecinos", detail: "Grabado en el lugar" },
  { icon: Drone, label: "Dron", detail: "Telemetría y cuadros" },
  { icon: Radio, label: "Comunicaciones radiales", detail: "Cruzadas con el video" },
];

const PRINCIPLES: { icon: LucideIcon; label: string; detail: string }[] = [
  { icon: Gauge, label: "Confianza visible", detail: "Cada hallazgo dice si la confianza es baja, media o alta y qué medio lo respalda." },
  { icon: SearchX, label: "Sin evidencia no es descarte", detail: "Solo una unidad en el lugar puede descartar personas atrapadas." },
  { icon: FlaskConical, label: "Nada simulado pasa por real", detail: "Sin IA configurada, Vigía funciona en modo demostración y rotula cada resultado como SIMULADO." },
];

const FINDINGS = ["Personas atrapadas", "Peligros", "Accesos", "Reconstrucción 3D"];

/** Portada: acceso al puesto de mando y al reporte de vecinos, con una explicación sobria del flujo. */
export default function Home() {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-line">
        <div className="mx-auto flex h-12 w-full max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
          <span className="label-caps truncate text-xs text-faint">Apoyo al mando · Bomberos</span>
        </div>
      </header>

      <main className="flex-1">
        <section aria-labelledby="portada-titulo" className="relative isolate overflow-hidden border-b border-line">
          {/* Fondo: timelapse real de Santiago (Costanera Center y cordillera, del atardecer a la noche).
              La imagen fija aparece al instante mientras carga el GIF. */}
          <picture
            className="pointer-events-none absolute inset-0 -z-10 bg-cover bg-bottom"
            style={{ backgroundImage: "url(/portada/santiago-poster.jpg)" }}
          >
            <source srcSet="/portada/santiago-poster.jpg" media="(prefers-reduced-motion: reduce)" />
            <img src="/portada/santiago.gif" alt="" className="size-full object-cover object-bottom" />
          </picture>
          {/* Velo blanco a la izquierda para que el texto se lea sobre la ciudad. */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 -z-10 bg-gradient-to-r from-white/90 via-white/55 to-white/0 max-lg:bg-white/75"
          />
          <div className="mx-auto grid w-full max-w-6xl gap-10 px-4 py-10 sm:px-6 md:py-16 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:gap-14">
            <div className="flex min-w-0 flex-col gap-7">
              <h1 id="portada-titulo">
                <Wordmark size="lg" tagline />
              </h1>

              <p className="max-w-xl text-lg leading-relaxed text-muted">
                Reúne los videos que graban los vecinos, los cuadros y la telemetría del dron y las comunicaciones
                radiales en una sola lectura del incidente, para que el oficial a cargo decida con más información y
                las unidades en ruta sepan a qué van.
              </p>

              <div className="flex flex-col gap-3 sm:flex-row">
                <Button variant="primary" size="xl" href="/mando" icon={MonitorDot}>
                  Puesto de mando
                </Button>
                <Button variant="secondary" size="xl" href="/reportar" icon={Video}>
                  Soy vecino: enviar video
                </Button>
              </div>
            </div>

            <FlowDiagram />
          </div>
          <a
            href="https://www.youtube.com/watch?v=IfKadff9oAc"
            target="_blank"
            rel="noopener noreferrer"
            className="absolute right-3 bottom-2 rounded-full bg-black/35 px-2 py-0.5 text-[11px] text-white/85 backdrop-blur-sm hover:text-white"
          >
            Timelapse: Max Felis
          </a>
        </section>

        <section aria-labelledby="como-funciona" className="border-b border-line">
          <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 md:py-14">
            <h2 id="como-funciona" className="label-caps mb-5 text-sm text-muted">
              Cómo funciona
            </h2>
            <ol className="grid gap-px overflow-hidden rounded-lg border border-line bg-line md:grid-cols-3">
              {STEPS.map((step, i) => (
                <li key={step.title} className="flex flex-col gap-2 bg-surface p-5">
                  <span aria-hidden className="font-mono text-sm text-accent tabular">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <h3 className="font-display text-xl leading-tight font-semibold">
                    <span className="sr-only">Paso {i + 1}: </span>
                    {step.title}
                  </h3>
                  <p className="text-sm leading-relaxed text-muted">{step.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section aria-labelledby="criterio" className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 md:py-14">
          <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="border-l-2 border-accent pl-4">
              <h2 id="criterio" className="font-display text-2xl leading-tight font-semibold">
                La IA apoya; decide el oficial a cargo.
              </h2>
              <p className="mt-2 max-w-lg text-sm leading-relaxed text-muted">
                Vigía ordena la información y señala riesgos; las decisiones tácticas siguen siendo del mando.
              </p>
            </div>
            <dl className="grid gap-px self-start overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-3 md:grid-cols-1 lg:grid-cols-3">
              {PRINCIPLES.map((p) => (
                <div key={p.label} className="flex items-start gap-3 bg-surface px-4 py-3">
                  <p.icon aria-hidden className="mt-0.5 size-5 shrink-0 text-muted" />
                  <div className="min-w-0">
                    <dt className="text-sm font-semibold">{p.label}</dt>
                    <dd className="text-xs text-muted">{p.detail}</dd>
                  </div>
                </div>
              ))}
            </dl>
          </div>
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-1 px-4 py-5 text-xs text-faint sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <span>Vigía · Puesto de mando asistido por IA para Bomberos</span>
        </div>
      </footer>
    </div>
  );
}

/** Esquema del flujo: fuentes → análisis asistido → oficial a cargo y unidades en ruta. */
function FlowDiagram() {
  return (
    <Panel title="Flujo de información" icon={ScanEye} flush className="self-start">
      <div className="flex flex-col p-4">
        <FlowLabel>Fuentes</FlowLabel>
        <ul className="grid gap-2">
          {SOURCES.map((s) => (
            <li key={s.label} className="flex items-center gap-3 rounded-md border border-line bg-surface-2 px-3 py-2">
              <s.icon aria-hidden className="size-4 shrink-0 text-info" />
              <span className="min-w-0 flex-1 truncate text-sm">{s.label}</span>
              <span className="label-caps hidden text-[11px] text-faint sm:inline">{s.detail}</span>
            </li>
          ))}
        </ul>

        <Connector />

        <FlowLabel>Análisis asistido</FlowLabel>
        <div className="rounded-md border border-accent/50 bg-accent-soft px-3 py-2.5">
          <ul className="flex flex-wrap gap-1.5" aria-label="Qué busca">
            {FINDINGS.map((f) => (
              <li key={f} className="label-caps rounded border border-line-strong bg-surface px-2 py-0.5 text-[11px] text-text">
                {f}
              </li>
            ))}
          </ul>
        </div>

        <Connector />

        <div className="grid gap-2 sm:grid-cols-2">
          <FlowEnd icon={ShieldCheck} title="Oficial a cargo" detail="Revisa y decide" />
          <FlowEnd icon={Route} title="Unidades en ruta" detail="Reciben el briefing" />
        </div>
      </div>
    </Panel>
  );
}

/** Rótulo de etapa dentro del esquema. */
function FlowLabel({ children }: { children: ReactNode }) {
  return <p className="label-caps mb-2 text-[11px] text-faint">{children}</p>;
}

/** Conector vertical entre etapas del esquema. */
function Connector() {
  return (
    <div aria-hidden className="flex flex-col items-center py-1.5 text-line-strong">
      <span className="h-3 w-px bg-line-strong" />
      <ArrowDown className="size-3.5" />
    </div>
  );
}

/** Destino final del esquema. */
function FlowEnd({ icon: Icon, title, detail }: { icon: LucideIcon; title: string; detail: string }) {
  return (
    <div className="flex items-center gap-3 rounded-md border border-line bg-surface-2 px-3 py-2.5">
      <Icon aria-hidden className="size-4 shrink-0 text-ok" />
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold">{title}</p>
        <p className="truncate text-xs text-muted">{detail}</p>
      </div>
    </div>
  );
}
