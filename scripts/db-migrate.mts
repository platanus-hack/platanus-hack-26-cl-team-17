/**
 * Aplica las migraciones pendientes de db/migrations contra DATABASE_URL.
 *
 *   DATABASE_URL=postgresql://... npx tsx scripts/db-migrate.mts
 *   (o: npm run db:migrate)
 *
 * Se ejecuta desde la raíz del proyecto (la carpeta de migraciones se busca en
 * process.cwd()/db/migrations). Termina con código 1 si algo falla.
 */
import { migrate } from "../src/lib/store/pg-migrate";
import { closePool, getPool } from "../src/lib/store/pg-pool";

async function main(): Promise<number> {
  if (!(process.env.DATABASE_URL ?? "").trim()) {
    console.error("Falta DATABASE_URL. Ejemplo: DATABASE_URL=postgresql://usuario:clave@host:5432/base");
    return 1;
  }
  try {
    const applied = await migrate(getPool());
    if (applied.length === 0) {
      console.log("La base ya estaba al día: no había migraciones pendientes.");
    } else {
      console.log(`Migraciones aplicadas (${applied.length}):`);
      for (const name of applied) console.log(`  - ${name}`);
    }
    return 0;
  } catch (err) {
    console.error(`Error al migrar: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    await closePool().catch(() => undefined);
  }
}

process.exitCode = await main();
