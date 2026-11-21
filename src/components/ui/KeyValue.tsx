import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

/** Un par rótulo/valor de `KeyValue`. */
export interface KeyValueItem {
  label: ReactNode;
  value: ReactNode;
  /** Valor en monoespaciada (coordenadas, identificadores, horas). */
  mono?: boolean;
  /** Texto auxiliar bajo el valor. */
  hint?: ReactNode;
}

/** Props de `KeyValue`: lista de definiciones en grilla. */
export interface KeyValueProps extends Omit<HTMLAttributes<HTMLDListElement>, "children"> {
  items: KeyValueItem[];
  /** Columnas en pantallas anchas (en teléfonos se reduce). */
  columns?: 1 | 2 | 3;
  /** Espaciado reducido. */
  dense?: boolean;
  className?: string;
}

const columnsClass: Record<NonNullable<KeyValueProps["columns"]>, string> = {
  1: "grid-cols-1",
  2: "grid-cols-1 min-[380px]:grid-cols-2",
  3: "grid-cols-1 min-[380px]:grid-cols-2 sm:grid-cols-3",
};

function isEmpty(value: ReactNode): boolean {
  return value === null || value === undefined || value === false || value === "";
}

/** Lista rótulo/valor como `<dl>` en grilla; los valores vacíos se muestran como "—". */
export function KeyValue({ items, columns = 1, dense = false, className, ...rest }: KeyValueProps) {
  return (
    <dl
      {...rest}
      className={cn("grid gap-x-4", dense ? "gap-y-1.5" : "gap-y-3", columnsClass[columns], className)}
    >
      {items.map((item, index) => (
        <div key={index} className="min-w-0">
          <dt className="label-caps text-xs text-muted">{item.label}</dt>
          <dd className={cn("mt-0.5 break-words text-text", item.mono ? "font-mono text-[13px] tabular" : "text-sm")}>
            {isEmpty(item.value) ? (
              <span className="text-faint">
                <span aria-hidden="true">—</span>
                <span className="sr-only">Sin dato</span>
              </span>
            ) : (
              item.value
            )}
          </dd>
          {item.hint != null && <dd className="mt-0.5 text-xs text-faint">{item.hint}</dd>}
        </div>
      ))}
    </dl>
  );
}
