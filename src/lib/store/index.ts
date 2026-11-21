/**
 * Fábrica de persistencia. Solo servidor.
 *  - DATABASE_URL → PostgresStore (Cloud SQL); si no, LocalStore (.data/db.json).
 *  - GCS_BUCKET   → GcsFiles (Cloud Storage); si no, LocalFiles (.data/files).
 *
 * Las instancias se guardan en globalThis porque Next empaqueta cada ruta por
 * separado y recarga módulos en desarrollo: una variable de módulo se duplicaría.
 */
import { isGcsConfigured, isPostgresConfigured } from "../config";
import { createGcsFiles } from "./gcs-files";
import { createLocalStore } from "./local";
import { createLocalFiles } from "./local-files";
import { createPostgresStore } from "./postgres";
import type { FileStorage, Store } from "./types";

export { StoreNotFoundError, storagePaths } from "./types";
export type { FileStorage, Store } from "./types";

type GlobalWithStore = typeof globalThis & {
  __vigiaStore?: Store;
  __vigiaFiles?: FileStorage;
};

export function getStore(): Store {
  const g = globalThis as GlobalWithStore;
  const kind: Store["kind"] = isPostgresConfigured() ? "postgres" : "local";
  // Se compara el modo en cada llamada: si cambia la configuración no queda un store viejo pegado.
  if (!g.__vigiaStore || g.__vigiaStore.kind !== kind) {
    g.__vigiaStore = kind === "postgres" ? createPostgresStore() : createLocalStore();
  }
  return g.__vigiaStore;
}

export function getFiles(): FileStorage {
  const g = globalThis as GlobalWithStore;
  const kind: FileStorage["kind"] = isGcsConfigured() ? "gcs" : "local";
  if (!g.__vigiaFiles || g.__vigiaFiles.kind !== kind) {
    g.__vigiaFiles = kind === "gcs" ? createGcsFiles() : createLocalFiles();
  }
  return g.__vigiaFiles;
}
