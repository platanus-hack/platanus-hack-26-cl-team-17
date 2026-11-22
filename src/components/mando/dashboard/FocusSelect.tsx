"use client";

import { useMemo, useState } from "react";
import { Bot, ChevronDown } from "lucide-react";
import { api, errorMessage } from "@/lib/client/api";
import type { IncidentFocus, IncidentSummary } from "@/lib/contract";

/** Valor de la opción "Automático" (sigue a la abierta más nueva). */
const AUTO = "";

/** Props de `FocusSelect`. */
export interface FocusSelectProps {
  incidents: IncidentSummary[];
  focus: IncidentFocus | null;
  /** Vuelve a leer la lista (y con ella el foco) tras cambiarlo. */
  onChanged: () => Promise<void>;
}

/**
 * Selector discreto de la emergencia que atiende Vigía: ahí escucha y habla por Zello y ahí va
 * el video del dron. "Automático" sigue a la abierta más nueva. Sin emergencias abiertas no se muestra.
 */
export function FocusSelect({ incidents, focus, onChanged }: FocusSelectProps) {
  const open = useMemo(
    () =>
      incidents
        .filter((i) => i.status === "active" || i.status === "controlled")
        .sort((a, b) => b.created_at.localeCompare(a.created_at)),
    [incidents],
  );
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!focus || open.length === 0) return null;

  const current = focus.pinned && focus.incident_id ? focus.incident_id : AUTO;
  const focused = open.find((i) => i.id === focus.incident_id);

  const change = async (next: string) => {
    if (next === current) return;
    setPending(next);
    setError(null);
    try {
      await api.focus.set({ incident_id: next === AUTO ? null : next });
      await onChanged().catch(() => undefined);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="flex min-w-0 items-center gap-2 text-xs text-faint">
      <label
        className="relative inline-flex min-w-0 items-center gap-1 transition-colors hover:text-muted focus-within:text-muted"
        title={
          focused
            ? `Vigía atiende ${focused.code}: ahí escucha y habla por Zello y ahí va el video del dron.`
            : "Emergencia que atiende Vigía"
        }
      >
        <Bot aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="sr-only">Emergencia que atiende Vigía</span>
        <select
          value={pending ?? current}
          disabled={pending !== null}
          onChange={(e) => void change(e.target.value)}
          className="max-w-56 min-w-0 cursor-pointer appearance-none truncate rounded bg-transparent py-0.5 pr-4 outline-none field-sizing-content focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-wait"
        >
          <option value={AUTO}>Automático · {open[0].code}</option>
          {open.map((i) => (
            <option key={i.id} value={i.id}>
              {i.code} · {i.title || "Sin título"}
            </option>
          ))}
        </select>
        <ChevronDown aria-hidden="true" className="pointer-events-none absolute right-0 size-3" />
      </label>
      {error && (
        <span role="alert" className="text-critical" title={error}>
          No se pudo cambiar
        </span>
      )}
    </div>
  );
}
