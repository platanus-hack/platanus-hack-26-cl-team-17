/**
 * Emergencia en foco: la única que atienden Vigía, el puente Zello y el puente del dron.
 * Por defecto es la abierta (activa o controlada) más nueva; desde el tablero se puede fijar
 * otra. La fijación se guarda en el storage (Cloud Storage o .data/files) para que la vean
 * todas las instancias del servidor. Solo servidor.
 */
import { z } from "zod";
import type { IncidentFocus, StaffPublic } from "@/lib/contract";
import type { IncidentStatus } from "@/lib/domain";
import { getFiles } from "@/lib/store";
import { storagePaths, type FileStorage } from "@/lib/store/types";

/** Cuánto se reusa la última lectura del storage (el tablero y los puentes consultan cada pocos segundos). */
const CACHE_MS = 3_000;

export const SetFocusInputSchema = z.object({
  incident_id: z.string().trim().min(1).max(64).nullable(),
});

interface StoredFocus {
  incident_id: string | null;
  set_by: string;
  set_at: string;
}

let cache: { at: number; value: StoredFocus | null } | null = null;

/** Id de la emergencia fijada en el tablero, o null en modo automático. */
export async function loadFocusPin(files: FileStorage = getFiles(), now = Date.now()): Promise<string | null> {
  if (cache && now - cache.at < CACHE_MS) return cache.value?.incident_id ?? null;
  let value: StoredFocus | null = null;
  try {
    if (await files.exists(storagePaths.focus)) {
      const { bytes } = await files.download(storagePaths.focus);
      value = JSON.parse(new TextDecoder().decode(bytes)) as StoredFocus;
    }
  } catch (err) {
    // Sin poder leerla, se sigue en automático: Vigía no se queda sin emergencia.
    console.warn("[vigia] no se pudo leer la emergencia fijada:", err);
  }
  cache = { at: now, value };
  return typeof value?.incident_id === "string" ? value.incident_id : null;
}

/** Fija la emergencia en foco (null vuelve a la más nueva). */
export async function saveFocusPin(
  incidentId: string | null,
  by: Pick<StaffPublic, "email">,
  files: FileStorage = getFiles(),
  now = new Date(),
): Promise<void> {
  const value: StoredFocus = { incident_id: incidentId, set_by: by.email, set_at: now.toISOString() };
  await files.upload(storagePaths.focus, new TextEncoder().encode(JSON.stringify(value)), "application/json");
  cache = { at: now.getTime(), value };
}

interface FocusCandidate {
  id: string;
  status: IncidentStatus;
  created_at: string;
}

const isOpen = (i: FocusCandidate) => i.status === "active" || i.status === "controlled";

/** La fijada si sigue abierta; si no, la abierta más nueva. */
export function resolveFocus(incidents: readonly FocusCandidate[], pinnedId: string | null): IncidentFocus {
  const open = incidents.filter(isOpen);
  if (pinnedId && open.some((i) => i.id === pinnedId)) return { incident_id: pinnedId, pinned: true };
  let newest: FocusCandidate | null = null;
  for (const i of open) if (!newest || i.created_at > newest.created_at) newest = i;
  return { incident_id: newest?.id ?? null, pinned: false };
}

/** Para pruebas: olvida la lectura en caché. */
export function resetFocusCache(): void {
  cache = null;
}
