/**
 * Memoria del agente Vigía (solo servidor). Un documento por emergencia:
 *  - con Postgres: tabla vigia_state (migración 0005), actualizada en una transacción
 *    con SELECT … FOR UPDATE para que dos instancias no se pisen;
 *  - sin Postgres: .data/vigia/<incidente>.json, escrito con rename atómico.
 * En ambos casos las actualizaciones de una misma emergencia se encadenan en el proceso.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { config, isPostgresConfigured } from "@/lib/config";
import { emptyVigiaState, type VigiaState } from "./types";

type GlobalWithVigiaStore = typeof globalThis & {
  __vigiaStateChains?: Map<string, Promise<unknown>>;
  __vigiaStateCache?: Map<string, VigiaState>;
};

function chains(): Map<string, Promise<unknown>> {
  const g = globalThis as GlobalWithVigiaStore;
  g.__vigiaStateChains ??= new Map();
  return g.__vigiaStateChains;
}

/** Caché del modo local (el archivo se lee una vez por proceso). */
function cache(): Map<string, VigiaState> {
  const g = globalThis as GlobalWithVigiaStore;
  g.__vigiaStateCache ??= new Map();
  return g.__vigiaStateCache;
}

/** Ejecuta fn en serie con las demás operaciones de la misma emergencia. */
function serialize<T>(incidentId: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains().get(incidentId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  chains().set(incidentId, tail);
  void tail.then(() => {
    if (chains().get(incidentId) === tail) chains().delete(incidentId);
  });
  return run;
}

/** Completa campos que un documento viejo no traiga (el tipo creció). */
function normalize(incidentId: string, raw: unknown): VigiaState {
  const base = emptyVigiaState(incidentId, new Date().toISOString());
  if (!raw || typeof raw !== "object") return base;
  const s = raw as Partial<VigiaState>;
  return {
    ...base,
    ...s,
    incident_id: incidentId,
    cursors: { ...base.cursors, ...(s.cursors ?? {}) },
    status: { ...base.status, ...(s.status ?? {}) },
  };
}

/* ───────────────────────────── Local (.data/vigia) ───────────────────────────── */

function localFile(incidentId: string): string {
  // El id viene de rutas: se limita a caracteres de un uuid para no salir de la carpeta.
  const safe = incidentId.replace(/[^0-9a-zA-Z-]/g, "");
  return path.resolve(config.localDataDir, "vigia", `${safe}.json`);
}

async function localRead(incidentId: string): Promise<VigiaState> {
  const hit = cache().get(incidentId);
  if (hit) return hit;
  let state: VigiaState;
  try {
    state = normalize(incidentId, JSON.parse(await fsp.readFile(localFile(incidentId), "utf8")));
  } catch {
    state = emptyVigiaState(incidentId, new Date().toISOString());
  }
  cache().set(incidentId, state);
  return state;
}

async function localWrite(state: VigiaState): Promise<void> {
  const file = localFile(state.incident_id);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(state), "utf8");
  await fsp.rename(tmp, file);
  cache().set(state.incident_id, state);
}

/* ───────────────────────────── Postgres ───────────────────────────── */

async function pg() {
  const [{ getPool, withTransaction }, { ensureMigrated }] = await Promise.all([
    import("@/lib/store/pg-pool"),
    import("@/lib/store/pg-migrate"),
  ]);
  await ensureMigrated();
  return { getPool, withTransaction };
}

/* ───────────────────────────── API ───────────────────────────── */

/** Estado actual (vacío si Vigía aún no ha trabajado en esta emergencia). */
export async function getVigiaState(incidentId: string): Promise<VigiaState> {
  if (!isPostgresConfigured()) return structuredClone(await localRead(incidentId));
  const { getPool } = await pg();
  const res = await getPool().query<{ state: unknown }>("select state from vigia_state where incident_id = $1", [
    incidentId,
  ]);
  return normalize(incidentId, res.rows[0]?.state);
}

/** Solo el contador de revisión (sondeo barato). */
export async function getVigiaRev(incidentId: string): Promise<number> {
  if (!isPostgresConfigured()) return (await localRead(incidentId)).rev;
  const { getPool } = await pg();
  const res = await getPool().query<{ rev: number }>("select rev from vigia_state where incident_id = $1", [incidentId]);
  return res.rows[0]?.rev ?? 0;
}

/**
 * Lee, aplica `mutate` sobre una copia y guarda. Si `mutate` devuelve false no guarda.
 * rev y updated_at los pone esta función. Devuelve el estado resultante.
 */
export function updateVigiaState(
  incidentId: string,
  mutate: (state: VigiaState) => void | boolean,
): Promise<VigiaState> {
  return serialize(incidentId, async () => {
    const now = new Date().toISOString();
    if (!isPostgresConfigured()) {
      const draft = structuredClone(await localRead(incidentId));
      if (mutate(draft) === false) return draft;
      draft.rev += 1;
      draft.updated_at = now;
      await localWrite(draft);
      return structuredClone(draft);
    }
    const { withTransaction } = await pg();
    return withTransaction(async (client) => {
      await client.query(
        "insert into vigia_state (incident_id, state, rev) values ($1, $2, 0) on conflict (incident_id) do nothing",
        [incidentId, JSON.stringify(emptyVigiaState(incidentId, now))],
      );
      const res = await client.query<{ state: unknown }>(
        "select state from vigia_state where incident_id = $1 for update",
        [incidentId],
      );
      const draft = normalize(incidentId, res.rows[0]?.state);
      if (mutate(draft) === false) return draft;
      draft.rev += 1;
      draft.updated_at = now;
      await client.query("update vigia_state set state = $2, rev = $3, updated_at = now() where incident_id = $1", [
        incidentId,
        JSON.stringify(draft),
        draft.rev,
      ]);
      return draft;
    });
  });
}
