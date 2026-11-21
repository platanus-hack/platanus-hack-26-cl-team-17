"use client";

/**
 * Sondeo de lo que hace Vigía en una emergencia (GET /api/incidents/[id]/vigia?rev=N) y
 * envío de mensajes del OBAC. El sondeo manda el último rev: si no cambió, la respuesta
 * es mínima.
 */
import { useCallback, useRef, useState } from "react";
import useSWR from "swr";
import { errorFromResponse } from "@/lib/client/api";
import type { VigiaUnchanged, VigiaView } from "@/lib/vigia/types";

const POLL_MS = 1500;

export interface UseVigia {
  view: VigiaView | null;
  error: unknown;
  send: (texto: string, respondeA?: string | null) => Promise<void>;
  sending: boolean;
  /** Plan B: "Vigía sin IA" (plantillas, y fusión y radio por reglas) en esta emergencia. */
  setSinIA: (on: boolean) => Promise<void>;
}

export function useVigia(incidentId: string): UseVigia {
  const last = useRef<VigiaView | null>(null);
  const { data, error, mutate } = useSWR<VigiaView, unknown, readonly [string, string]>(
    ["vigia", incidentId] as const,
    async ([, id]) => {
      const rev = last.current?.rev;
      const res = await fetch(`/api/incidents/${encodeURIComponent(id)}/vigia${rev !== undefined ? `?rev=${rev}` : ""}`, {
        cache: "no-store",
      });
      if (!res.ok) throw await errorFromResponse(res);
      const body = (await res.json()) as VigiaView | VigiaUnchanged;
      if (body.unchanged && last.current) return last.current;
      if (body.unchanged) throw new Error("Respuesta sin datos");
      last.current = body;
      return body;
    },
    { refreshInterval: POLL_MS, revalidateOnFocus: true, dedupingInterval: 500, keepPreviousData: true },
  );

  const [sending, setSending] = useState(false);
  const send = useCallback(
    async (texto: string, respondeA?: string | null) => {
      setSending(true);
      try {
        const res = await fetch(`/api/incidents/${encodeURIComponent(incidentId)}/vigia`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ texto, responde_a: respondeA ?? null }),
        });
        if (!res.ok) throw await errorFromResponse(res);
        void mutate();
      } finally {
        setSending(false);
      }
    },
    [incidentId, mutate],
  );

  const setSinIA = useCallback(
    async (on: boolean) => {
      const res = await fetch(`/api/incidents/${encodeURIComponent(incidentId)}/vigia`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sin_ia: on }),
      });
      if (!res.ok) throw await errorFromResponse(res);
      const view = (await res.json()) as VigiaView;
      last.current = view;
      void mutate(view, { revalidate: false });
    },
    [incidentId, mutate],
  );

  return { view: data ?? null, error, send, sending, setSinIA };
}
