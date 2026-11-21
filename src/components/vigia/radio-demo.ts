"use client";

/**
 * Modo demo: suenan dos radios a la vez (audios de public/demo/) y sus líneas entran a la
 * bitácora como "simulado" cuando termina cada frase. Antes se registra un pedido de hace
 * 6 minutos que nadie confirmó, para que Vigía lo recuerde. Funciona sin red de audio: si
 * un archivo no carga, sus líneas igual se registran.
 */
import { errorFromResponse } from "@/lib/client/api";
import { DEMO_EARLIER_LINE, DEMO_RADIOS } from "@/lib/vigia/demo-script";

async function postComm(incidentId: string, line: { speaker: string; channel: string; text: string }, at?: string) {
  const res = await fetch(`/api/incidents/${encodeURIComponent(incidentId)}/comms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: line.text, speaker: line.speaker, channel: line.channel, source: "simulated", ...(at ? { at } : {}) }),
  });
  if (!res.ok) throw await errorFromResponse(res);
}

/** Corre la demo de radio. Devuelve cómo cortarla. */
export async function runRadioDemo(incidentId: string): Promise<() => void> {
  const earlierAt = new Date(Date.now() - DEMO_EARLIER_LINE.minutes_ago * 60_000).toISOString();
  await postComm(incidentId, DEMO_EARLIER_LINE, earlierAt);

  const audios = DEMO_RADIOS.map((r) => {
    const a = new Audio(r.src);
    a.preload = "auto";
    return a;
  });
  // Las dos radios a la vez; si el navegador bloquea el audio, la demo sigue sin sonido.
  await Promise.allSettled(audios.map((a) => a.play()));

  const timers = DEMO_RADIOS.flatMap((r) =>
    r.lines.map((line) =>
      setTimeout(() => {
        void postComm(incidentId, line).catch((error: unknown) => console.warn("[vigia-demo] no se registró una línea", error));
      }, line.offset_ms),
    ),
  );
  return () => {
    timers.forEach(clearTimeout);
    audios.forEach((a) => a.pause());
  };
}
