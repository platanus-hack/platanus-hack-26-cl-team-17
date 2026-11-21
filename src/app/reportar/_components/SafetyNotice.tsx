import { TriangleAlert } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * Aviso de seguridad al inicio. La franja fija de VecinoShell ya enlaza a tel:132;
 * aquí no se repite el enlace, solo la instrucción de no exponerse.
 */
export function SafetyNotice({ className }: { className?: string }) {
  return (
    <div
      role="note"
      className={cn(
        "flex items-start gap-3 rounded-lg border border-critical/40 bg-critical-soft px-4 py-3.5",
        className,
      )}
    >
      <TriangleAlert aria-hidden className="mt-0.5 size-6 shrink-0 text-critical" strokeWidth={2.25} />
      <p className="min-w-0 text-lg leading-snug text-text">
        <strong className="font-bold">Primero llama al 132.</strong> No te acerques ni te expongas para grabar.
      </p>
    </div>
  );
}
