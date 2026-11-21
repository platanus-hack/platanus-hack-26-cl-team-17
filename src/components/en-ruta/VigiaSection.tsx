"use client";

import { useCallback, useState } from "react";
import useSWR from "swr";
import { RadioTower } from "lucide-react";
import type { BriefingVigiaMessage } from "@/lib/contract";
import { api } from "@/lib/client/api";
import { cn } from "@/lib/cn";
import { formatClock } from "@/lib/format";
import { BriefSection, Pill } from "./parts";

const POLL_MS = 5000;
/** Un mensaje se marca "Nuevo" durante este tiempo. */
const FRESH_MS = 2 * 60_000;

/** Sondea lo último de Vigía con la clave del enlace; sin clave no pide nada. `null` = aún no llega. */
export function useBriefingVigia(id: string, shareKey: string | null): BriefingVigiaMessage[] | null {
  const { data } = useSWR(
    shareKey ? (["briefing-vigia", id, shareKey] as const) : null,
    ([, incidentId, key]) => api.briefing.vigia(incidentId, key),
    { refreshInterval: POLL_MS, keepPreviousData: true, revalidateOnFocus: true },
  );
  return data ? data.messages : null;
}

/**
 * Mensajes de Vigía que llegaron después de abrir la pantalla, para sumarlos al aviso
 * "ACTUALIZACIÓN" (lo de antes ya está en la sección). Quedan hasta que se toca el aviso.
 */
export function useNewVigia(messages: BriefingVigiaMessage[] | null): {
  fresh: BriefingVigiaMessage[];
  dismiss: () => void;
} {
  const [state, setState] = useState<{ source: BriefingVigiaMessage[] | null; seen: Set<string> | null; fresh: BriefingVigiaMessage[] }>(
    { source: null, seen: null, fresh: [] },
  );
  // Derivado del render anterior: la primera respuesta solo se registra.
  if (messages && messages !== state.source) {
    const seen = new Set(state.seen ?? []);
    const added = state.seen ? messages.filter((m) => !seen.has(m.id)) : [];
    for (const m of messages) seen.add(m.id);
    setState({ source: messages, seen, fresh: added.length ? [...added, ...state.fresh] : state.fresh });
  }
  const dismiss = useCallback(() => setState((s) => ({ ...s, fresh: [] })), []);
  return { fresh: state.fresh, dismiss };
}

/**
 * "Lo último de Vigía": sus mensajes de personas o riesgo, el más nuevo arriba. La voz de
 * Vigía sale por la radio (Zello); aquí queda escrito para quien no alcanzó a oírlo.
 */
export function VigiaSection({ messages, now, id }: { messages: BriefingVigiaMessage[] | null; now: number | null; id: string }) {
  if (!messages || messages.length === 0) return null;
  return (
    <BriefSection id={id} title="Lo último de Vigía" icon={RadioTower}>
      <ul className="flex flex-col gap-2.5">
        {messages.map((m) => {
          const person = m.priority === "persona";
          const fresh = now !== null && now - Date.parse(m.at) < FRESH_MS;
          return (
            <li
              key={m.id}
              className={cn("rounded-md border-l-[6px] bg-surface-2 py-2.5 pr-3 pl-3", person ? "border-critical" : "border-warning")}
            >
              <p className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-base">
                <span className={cn("label-caps font-bold", person ? "text-critical" : "text-warning")}>
                  {person ? "Personas" : "Riesgo"}
                </span>
                <time dateTime={m.at} className="font-mono text-muted tabular-nums">
                  {formatClock(m.at)}
                </time>
                {fresh && (
                  <Pill tone="accent" className="py-0.5 text-sm">
                    Nuevo
                  </Pill>
                )}
              </p>
              <p className="mt-1 text-xl leading-snug font-semibold text-text lg:text-2xl">{m.text}</p>
            </li>
          );
        })}
      </ul>
    </BriefSection>
  );
}
