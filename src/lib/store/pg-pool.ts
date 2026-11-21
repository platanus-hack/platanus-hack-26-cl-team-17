/**
 * Pool de conexiones a Postgres (Cloud SQL). Solo servidor.
 *
 * Un único Pool por proceso, guardado en globalThis: Next empaqueta cada ruta
 * por separado y recarga módulos en desarrollo, y una variable de módulo
 * abriría un pool nuevo por bundle.
 *
 * Tipos: numeric (1700) e int8 (20) llegan como number (lat/lng, conteos,
 * size_bytes). timestamptz llega como Date (el valor por defecto de pg).
 */
import pg, { type Pool, type PoolClient } from "pg";
import { config } from "../config";

type GlobalWithPgPool = typeof globalThis & { __vigiaPgPool?: Pool };

/**
 * Una base que acepta la conexión pero no contesta no debe colgar las páginas hasta el límite
 * de Cloud Run (900 s): Postgres corta la sentencia a los 10 s y el cliente deja de esperar a
 * los 15 s aunque la red se trague la respuesta. Las migraciones esperan más (pg-migrate.ts).
 */
export const STATEMENT_TIMEOUT_MS = 10_000;
export const QUERY_TIMEOUT_MS = 15_000;

const NUMERIC_OID = 1700;
const INT8_OID = 20;

function buildTypes(): InstanceType<typeof pg.TypeOverrides> {
  const types = new pg.TypeOverrides();
  types.setTypeParser(NUMERIC_OID, "text", (v: string) => Number(v));
  types.setTypeParser(INT8_OID, "text", (v: string) => Number(v));
  return types;
}

function createPool(): Pool {
  const connectionString = config.databaseUrl;
  if (!connectionString) {
    throw new Error("Falta DATABASE_URL: no hay base de datos Postgres configurada.");
  }
  const pool = new pg.Pool({
    connectionString,
    // Con el socket de Cloud SQL (/cloudsql/...) no hace falta SSL; DATABASE_SSL=1 lo exige.
    ssl: config.databaseSsl ? { rejectUnauthorized: true } : undefined,
    max: config.databasePoolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
    application_name: "vigia",
    types: buildTypes(),
  });
  // Un cliente inactivo que se cae (reinicio de Cloud SQL, red) emite 'error' en el pool;
  // sin este manejador el proceso entero terminaría.
  pool.on("error", (err) => {
    console.error(`[vigia:pg] error en una conexión inactiva del pool: ${err.message}`);
  });
  return pool;
}

export function getPool(): Pool {
  const g = globalThis as GlobalWithPgPool;
  if (!g.__vigiaPgPool) g.__vigiaPgPool = createPool();
  return g.__vigiaPgPool;
}

/** Ejecuta `fn` dentro de BEGIN/COMMIT; ROLLBACK si lanza. */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  let broken: Error | undefined;
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      // Si ni el ROLLBACK funciona, la conexión no se devuelve al pool.
      broken = rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr));
    }
    throw err;
  } finally {
    client.release(broken);
  }
}

/** Cierra el pool y olvida el singleton (pruebas y scripts). */
export async function closePool(): Promise<void> {
  const g = globalThis as GlobalWithPgPool;
  const pool = g.__vigiaPgPool;
  g.__vigiaPgPool = undefined;
  if (pool) await pool.end();
}
