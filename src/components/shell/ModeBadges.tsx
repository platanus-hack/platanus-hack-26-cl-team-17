import { BrainCircuit, Cpu, HardDrive } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Tooltip } from "@/components/ui/Tooltip";
import type { RuntimeMode } from "@/lib/contract";
import { cn } from "@/lib/cn";

/** Props de los indicadores de modo de ejecución. */
export interface ModeBadgesProps {
  /** Modo informado por /api/status o /api/auth/me. Sin modo no se muestra nada. */
  mode?: RuntimeMode | null;
  className?: string;
  /** Versión reducida para barras estrechas (badges pequeños, sin el del modelo). */
  compact?: boolean;
}

const AI_OFF_HINT = "Sin ANTHROPIC_API_KEY: los videos y la radio no se analizan";
const LOCAL_HINT = "Sin base de datos: datos guardados en este servidor (.data/) y acceso abierto";

/** Indicadores honestos del modo de ejecución: sin IA, modelo de IA real y almacenamiento local. */
export function ModeBadges({ mode, className, compact = false }: ModeBadgesProps) {
  if (!mode) return null;

  const size = compact ? "sm" : "md";
  const aiOff = mode.ai === "off";
  const local = mode.store === "local";
  const showModel = !aiOff && !compact;

  if (!aiOff && !local && !showModel) return null;

  return (
    <div className={cn("flex min-w-0 items-center gap-1.5", className)}>
      {aiOff ? (
        <Tooltip content={AI_OFF_HINT} side="bottom">
          <Badge tone="warning" variant="solid" size={size} icon={BrainCircuit} tabIndex={0}>
            Sin IA
            <span className="sr-only">. {AI_OFF_HINT}</span>
          </Badge>
        </Tooltip>
      ) : null}
      {showModel ? (
        <Badge
          tone="neutral"
          variant="outline"
          size={size}
          icon={Cpu}
          title={`Análisis con ${mode.model ?? "Claude"}`}
          className="max-w-48"
        >
          IA · {mode.model ?? "Claude"}
        </Badge>
      ) : null}
      {local ? (
        <Tooltip content={LOCAL_HINT} side="bottom">
          <Badge tone="info" variant="soft" size={size} icon={HardDrive} tabIndex={0}>
            {compact ? "Local" : "Modo local"}
            <span className="sr-only">. {LOCAL_HINT}</span>
          </Badge>
        </Tooltip>
      ) : null}
    </div>
  );
}
