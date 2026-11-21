"use client";

/**
 * Pedido de video de Vigía en la página de grabación del público:
 * "Bomberos necesita un video del lado C, desde la vereda. Sin acercarse."
 * Consulta cada pocos segundos; sin pedido activo no muestra nada.
 */
import { useState } from "react";
import useSWR from "swr";
import { Video } from "lucide-react";
import type { PublicVideoRequest } from "@/lib/vigia/types";

const POLL_MS = 4000;

/** Id aleatorio de la pestaña (sin datos personales) para contar a cuántas personas les llegó. */
function tabId(): string {
  try {
    const k = "vigia-pestana";
    const v = sessionStorage.getItem(k) ?? crypto.randomUUID();
    sessionStorage.setItem(k, v);
    return v;
  } catch {
    return crypto.randomUUID();
  }
}

export function VideoRequestBanner({ code }: { code: string }) {
  const [viewer] = useState(() => (typeof window === "undefined" ? "" : tabId()));
  const { data } = useSWR<{ requests: PublicVideoRequest[] }>(
    viewer ? ["vigia-pedidos", code, viewer] : null,
    async () => {
      const res = await fetch(`/api/public/incidents/${encodeURIComponent(code)}/pedidos?v=${encodeURIComponent(viewer)}`, {
        cache: "no-store",
      });
      if (!res.ok) return { requests: [] };
      return (await res.json()) as { requests: PublicVideoRequest[] };
    },
    { refreshInterval: POLL_MS, revalidateOnFocus: true },
  );
  const request = data?.requests.at(-1);
  if (!request) return null;
  return (
    <section
      role="alert"
      aria-label="Pedido de Bomberos"
      className="flex animate-enter items-start gap-3 rounded-lg border-2 border-f-orange bg-surface p-4 shadow-[0_8px_24px_rgb(247_107_21/0.18)]"
    >
      <span aria-hidden className="flex size-11 shrink-0 items-center justify-center rounded-full bg-f-orange text-white">
        <Video className="size-6" />
      </span>
      <div className="min-w-0">
        <p className="text-sm font-bold text-f-orange-ink">Pedido de Bomberos</p>
        <p className="mt-0.5 text-xl leading-snug font-bold text-text">{request.text}</p>
        <p className="mt-1 text-sm text-muted">Graba desde donde estás seguro. No te acerques ni entres a ningún lugar.</p>
      </div>
    </section>
  );
}
