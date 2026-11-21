import { FlaskConical } from "lucide-react";
import type { RuntimeMode } from "@/lib/contract";
import { cn } from "@/lib/cn";

/** Props del aviso de resultado simulado. */
export interface SimulatedNoticeProps {
  className?: string;
  /** Una sola línea, con aspecto de badge; el texto completo queda en title y para lectores de pantalla. */
  compact?: boolean;
  /** Sujeto de la frase, p. ej. "Este análisis". Por defecto "Este resultado". */
  what?: string;
  /**
   * Modo de la instancia. Con IA real configurada, un resultado simulado viene del motor de reglas
   * de respaldo (o de datos de demostración): no se pide configurar la clave que ya existe.
   */
  mode?: RuntimeMode | null;
  /** true si el resultado pertenece a un incidente de demostración (datos ficticios). */
  demo?: boolean;
}

interface NoticeText {
  /** Explicación tras "<sujeto> es SIMULADO: ". */
  reason: string;
  /** Resumen para la versión compacta. */
  short: string;
  /** Sugerencia final; null si no aplica. */
  tip: string | null;
}

function noticeText(mode: RuntimeMode | null | undefined, demo: boolean): NoticeText {
  if (demo) {
    return { reason: "son datos de demostración, ficticios", short: "datos de demostración", tip: null };
  }
  if (mode?.ai === "simulated") {
    return {
      reason: "no proviene de los videos",
      short: "no proviene de los videos",
      tip: "Configura ANTHROPIC_API_KEY para análisis real.",
    };
  }
  if (mode?.ai === "claude") {
    return {
      reason: "lo generó el motor de reglas de respaldo, no el modelo de IA",
      short: "motor de reglas, no IA",
      tip: "Reanaliza para intentarlo de nuevo con el modelo.",
    };
  }
  return { reason: "lo generó el motor de reglas, no el modelo de IA", short: "motor de reglas, no IA", tip: null };
}

/** Aviso visible de que un resultado no lo produjo el modelo de IA (motor de reglas o datos de demostración). */
export function SimulatedNotice({ className, compact = false, what, mode, demo = false }: SimulatedNoticeProps) {
  const subject = what ?? "Este resultado";
  const text = noticeText(mode, demo);
  const full = `${subject} es SIMULADO: ${text.reason}.${text.tip ? ` ${text.tip}` : ""}`;

  if (compact) {
    return (
      <p
        role="note"
        title={full}
        className={cn(
          "inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-md border border-warning/40 bg-warning-soft px-2 py-0.5 text-xs text-warning",
          className,
        )}
      >
        <FlaskConical aria-hidden className="size-3.5 shrink-0" />
        <span aria-hidden className="truncate">
          <span className="label-caps">Simulado</span> · {text.short}
        </span>
        <span className="sr-only">{full}</span>
      </p>
    );
  }

  return (
    <div
      role="note"
      className={cn(
        "flex items-start gap-2.5 rounded-md border border-warning/40 bg-warning-soft px-3 py-2.5 text-sm text-text",
        className,
      )}
    >
      <FlaskConical aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
      <p className="min-w-0 leading-snug">
        {subject} es <strong className="font-semibold text-warning">SIMULADO</strong>: {text.reason}.
        {text.tip ? <span className="text-muted"> {text.tip}</span> : null}
      </p>
    </div>
  );
}
