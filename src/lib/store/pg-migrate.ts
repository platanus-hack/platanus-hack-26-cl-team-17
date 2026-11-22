/**
 * Migraciones SQL propias (db/migrations/*.sql). Solo servidor.
 *
 * Cada archivo se aplica una vez, en orden alfabético, dentro de su propia
 * transacción, y queda registrado en schema_migrations. Un candado consultivo
 * de Postgres serializa a varias instancias de Cloud Run que arrancan a la vez.
 *
 * La carpeta se busca en process.cwd()/db/migrations: en desarrollo es la raíz
 * del proyecto y en la imagen standalone el Dockerfile copia db/ junto a server.js.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import type { Pool, QueryConfig } from "pg";
import { config } from "../config";
import { getPool } from "./pg-pool";

/** Clave fija del candado consultivo de migraciones ("vigia" + 1). */
const MIGRATION_LOCK_KEY = 7_316_201_001;
/** Espera máxima del candado y de cada migración (el resto de las consultas corta a los 10–15 s). */
const MIGRATION_TIMEOUT_MS = 10 * 60_000;

/** node-postgres acepta `query_timeout` por consulta (pisa el del pool); sus tipos no lo declaran. */
type TimedQuery = QueryConfig & { query_timeout?: number };

type GlobalWithMigration = typeof globalThis & { __vigiaPgMigrated?: Promise<void> };

function migrationsDir(): string {
  return path.join(process.cwd(), "db", "migrations");
}

async function listMigrationFiles(): Promise<string[]> {
  const dir = migrationsDir();
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`No se encontró la carpeta de migraciones ${dir} (${reason}).`);
  }
  return names.filter((n) => n.endsWith(".sql")).sort();
}

/** Aplica las migraciones pendientes y devuelve los nombres aplicados (vacío si no había). */
export async function migrate(pool: Pool = getPool()): Promise<string[]> {
  const files = await listMigrationFiles();
  const client = await pool.connect();
  let broken: Error | undefined;
  const applied: string[] = [];
  try {
    // Esperar el candado (otra instancia migrando) y una migración pesada pueden pasar el tope
    // normal de las consultas: aquí se espera hasta 10 min. RESET al final lo devuelve al del pool.
    await client.query("SET statement_timeout = 0");
    const lock: TimedQuery = { text: "select pg_advisory_lock($1)", values: [MIGRATION_LOCK_KEY], query_timeout: MIGRATION_TIMEOUT_MS };
    await client.query(lock);
    try {
      await client.query(
        `create table if not exists schema_migrations (
           name text primary key,
           applied_at timestamptz not null default now()
         )`,
      );
      const done = await client.query<{ name: string }>("select name from schema_migrations");
      const already = new Set(done.rows.map((r) => r.name));
      for (const name of files) {
        if (already.has(name)) continue;
        const sql = await fsp.readFile(path.join(migrationsDir(), name), "utf8");
        await client.query("BEGIN");
        try {
          // Sin parámetros: protocolo simple, admite varias sentencias y cuerpos $$.
          const run: TimedQuery = { text: sql, query_timeout: MIGRATION_TIMEOUT_MS };
          await client.query(run);
          await client.query("insert into schema_migrations (name) values ($1)", [name]);
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK").catch((rollbackErr: unknown) => {
            broken = rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr));
          });
          const reason = err instanceof Error ? err.message : String(err);
          throw new Error(`Falló la migración ${name}: ${reason}`, { cause: err });
        }
        applied.push(name);
      }
    } finally {
      if (!broken) {
        await client.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => {
          // Si falla, el candado se libera igual al cerrar la conexión.
          broken = new Error("No se pudo liberar el candado de migraciones.");
        });
      }
    }
  } finally {
    if (!broken) await client.query("RESET statement_timeout").catch(() => (broken = new Error("No se pudo restaurar statement_timeout.")));
    // Una conexión en mal estado (o con el candado tomado) se descarta en vez de volver al pool.
    client.release(broken);
  }
  return applied;
}

/**
 * Migra una sola vez por proceso antes de la primera consulta del store.
 * No hace nada con VIGIA_AUTO_MIGRATE=0. Si falla, el próximo llamado reintenta.
 */
export function ensureMigrated(): Promise<void> {
  if (!config.autoMigrate) return Promise.resolve();
  const g = globalThis as GlobalWithMigration;
  if (!g.__vigiaPgMigrated) {
    const run = migrate()
      .then((names) => {
        if (names.length > 0) console.info(`[vigia:pg] migraciones aplicadas: ${names.join(", ")}`);
      })
      .catch((err: unknown) => {
        if (g.__vigiaPgMigrated === run) g.__vigiaPgMigrated = undefined;
        throw err;
      });
    g.__vigiaPgMigrated = run;
  }
  return g.__vigiaPgMigrated;
}
