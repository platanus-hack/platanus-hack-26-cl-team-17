import type { ReactNode } from "react";
import { CircleCheck, KeyRound, Link2Off, FlaskConical, Smartphone, type LucideIcon } from "lucide-react";
import { Logo } from "@/components/brand";
import { cn } from "@/lib/cn";

/** Pantallas del modo sensor que no llegan a encender sensores (enlace incompleto, token inválido…). */
export type SensorGateKind = "no_token" | "invalid" | "simulated" | "ended";

const GATE: Record<SensorGateKind, { icon: LucideIcon; tone: "critical" | "warning" | "info" | "ok"; title: string }> = {
  no_token: { icon: KeyRound, tone: "warning", title: "Falta el código de acceso del enlace" },
  invalid: { icon: Link2Off, tone: "critical", title: "Este enlace no es válido" },
  simulated: { icon: FlaskConical, tone: "warning", title: "Esta misión es simulada" },
  ended: { icon: CircleCheck, tone: "info", title: "La misión ya terminó" },
};

const TONE: Record<"critical" | "warning" | "info" | "ok", string> = {
  critical: "border-critical/40 bg-critical-soft text-critical",
  warning: "border-warning/40 bg-warning-soft text-warning",
  info: "border-info/40 bg-info-soft text-info",
  ok: "border-ok/40 bg-ok-soft text-ok",
};

/** Marco común del modo sensor: pantalla completa oscura con la marca arriba. */
export function SensorFrame({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-h-dvh flex-col bg-bg pt-[env(safe-area-inset-top)] text-text", className)}>
      <header className="flex items-center gap-2 px-4 pt-3 pb-2">
        <Logo size={24} title="Vigía" />
        <span className="font-display text-lg leading-none font-semibold">Vigía</span>
        <span className="label-caps ml-1 flex items-center gap-1 rounded border border-drone/40 bg-drone-soft px-1.5 py-0.5 text-[11px] text-drone">
          <Smartphone aria-hidden="true" className="size-3" />
          Modo sensor
        </span>
      </header>
      {children}
    </div>
  );
}

export interface SensorGateProps {
  kind: SensorGateKind;
  /** Texto específico (p. ej. el dron y el incidente) bajo el título. */
  detail?: ReactNode;
}

const MESSAGE: Record<SensorGateKind, ReactNode> = {
  no_token: (
    <>
      <p>
        Abre el enlace <strong>completo</strong> que muestra el puesto de mando al desplegar un dron en modo
        «Teléfono como sensor»: termina en <span className="font-mono">?t=…</span>.
      </p>
      <ol className="list-decimal space-y-1 pl-5">
        <li>En el puesto de mando, abre el incidente y la pestaña «Dron».</li>
        <li>Toca «Desplegar dron» y elige «Teléfono como sensor».</li>
        <li>Escanea el código QR con este teléfono.</li>
      </ol>
    </>
  ),
  invalid: (
    <p>
      El código de acceso no corresponde a esta misión, o la misión no existe. El código solo se muestra una vez al
      desplegar el dron: pide al puesto de mando que despliegue uno nuevo y escanea el nuevo código QR.
    </p>
  ),
  simulated: (
    <p>
      Su telemetría la genera la plataforma y no recibe datos de un teléfono. Para usar este teléfono como sensor, pide
      al puesto de mando un dron en modo «Teléfono como sensor».
    </p>
  ),
  ended: (
    <p>
      Ya no recibe datos. Si necesitas volver a enviar imágenes, pide al puesto de mando que despliegue un dron nuevo y
      escanea el nuevo código QR.
    </p>
  ),
};

export function SensorGate({ kind, detail }: SensorGateProps) {
  const g = GATE[kind];
  const Icon = g.icon;
  return (
    <SensorFrame>
      <main className="flex flex-1 flex-col gap-4 px-4 pt-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        <div role={kind === "invalid" ? "alert" : "status"} className={cn("flex flex-col gap-3 rounded-lg border p-4", TONE[g.tone])}>
          <Icon aria-hidden="true" className="size-8" />
          <h1 className="font-display text-3xl leading-tight font-bold">{g.title}</h1>
          {detail && <p className="text-base text-text">{detail}</p>}
        </div>
        <div className="flex flex-col gap-3 text-base leading-relaxed text-muted">{MESSAGE[kind]}</div>
      </main>
    </SensorFrame>
  );
}
