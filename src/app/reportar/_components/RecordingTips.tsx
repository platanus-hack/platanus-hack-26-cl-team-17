import { ArrowLeftRight, Clock, Lock, ScanEye, ShieldCheck, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";

const TIPS: readonly { icon: LucideIcon; text: string }[] = [
  { icon: Clock, text: "Graba 10 a 30 segundos." },
  { icon: ScanEye, text: "Muestra el frente completo y luego dónde está el fuego o los vehículos." },
  { icon: ArrowLeftRight, text: "Si puedes, graba desde dos lados." },
  { icon: ShieldCheck, text: "Mantén distancia: tu seguridad va primero." },
];

/** Consejos breves para que el video le sirva a Bomberos. */
export function RecordingTips({ className }: { className?: string }) {
  return (
    <section aria-labelledby="consejos-grabar" className={cn("rounded-lg border border-line bg-surface p-4", className)}>
      <h2 id="consejos-grabar" className="font-display text-xl font-semibold text-text">
        Cómo grabar
      </h2>
      <ul className="mt-3 flex flex-col gap-3">
        {TIPS.map(({ icon: Icon, text }) => (
          <li key={text} className="flex items-start gap-3 text-base leading-snug text-text">
            <Icon aria-hidden className="mt-0.5 size-5 shrink-0 text-accent" />
            <span className="min-w-0">{text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Línea de privacidad, siempre visible cerca del envío. */
export function PrivacyNote({ className }: { className?: string }) {
  return (
    <p className={cn("flex items-start gap-2.5 text-base leading-snug text-muted", className)}>
      <Lock aria-hidden className="mt-0.5 size-5 shrink-0" />
      <span className="min-w-0">Tu video solo lo ve el personal de Bomberos a cargo de la emergencia.</span>
    </p>
  );
}
