/**
 * Antes de arrancar, el puente mira si el Vigía al que informa ya tiene otro puente conectado.
 * Zello admite una conexión por cuenta: dos puentes se expulsarían cada 30 s. Puro.
 */
import type { ZelloStatusResponse } from "@/lib/contract";

/** Descripción del otro puente si está conectado y latiendo; null si se puede arrancar. */
export function otherBridgeOnline(res: ZelloStatusResponse | null | undefined): string | null {
  const s = res?.status;
  if (!res || !s || res.stale || s.stopped || !s.connected) return null;
  const since = res.received_at ? ` (último latido ${res.received_at})` : "";
  return `ya hay un puente Zello conectado al canal «${s.channel}» informando a este Vigía${since}`;
}
