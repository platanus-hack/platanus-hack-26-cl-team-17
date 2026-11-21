/**
 * Lanzamiento del job de GPU con la API v2 de Cloud Run (`jobs/<job>:run`).
 * Credenciales: ADC de google-auth-library (en Cloud Run, la cuenta del servicio).
 * Solo servidor.
 */
import type { GoogleAuth } from "google-auth-library";

const JOB_NAME_RE = /^projects\/[a-z0-9-]+\/locations\/[a-z0-9-]+\/jobs\/[a-z0-9-]+$/;

export function isValidJobName(job: string): boolean {
  return JOB_NAME_RE.test(job);
}

export interface RunJobInput {
  /** Nombre completo: projects/<p>/locations/<región>/jobs/<job>. */
  job: string;
  manifestUri: string;
  callbackToken: string;
}

/** Cuerpo de `jobs:run`: solo se sobrescriben las variables de entorno del contenedor. */
export function buildRunRequest(input: Pick<RunJobInput, "manifestUri" | "callbackToken">) {
  return {
    overrides: {
      containerOverrides: [
        {
          env: [
            { name: "SPLAT_MANIFEST_URI", value: input.manifestUri },
            { name: "SPLAT_CALLBACK_TOKEN", value: input.callbackToken },
          ],
        },
      ],
    },
  };
}

type GlobalWithAuth = typeof globalThis & { __vigiaGoogleAuth?: GoogleAuth };

async function getAuth(): Promise<GoogleAuth> {
  const g = globalThis as GlobalWithAuth;
  if (!g.__vigiaGoogleAuth) {
    const { GoogleAuth: Auth } = await import("google-auth-library");
    g.__vigiaGoogleAuth = new Auth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  }
  return g.__vigiaGoogleAuth;
}

/** Mensaje legible de un error de gaxios (la API de Google trae `error.message`). */
export function describeGoogleError(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const e = err as {
      message?: unknown;
      status?: unknown;
      response?: { status?: unknown; data?: { error?: { message?: unknown } } } | null;
    };
    const apiMsg = e.response?.data?.error?.message;
    const status = e.response?.status ?? e.status;
    if (typeof apiMsg === "string" && apiMsg) return status ? `${apiMsg} (HTTP ${String(status)})` : apiMsg;
    if (typeof e.message === "string" && e.message) return e.message;
  }
  return "Error desconocido al llamar a Cloud Run.";
}

/** Ejecuta el job y devuelve el nombre de la operación de larga duración (para los registros). */
export async function runSplatJob(input: RunJobInput): Promise<{ operation: string | null }> {
  if (!isValidJobName(input.job)) {
    throw new Error(
      `SPLAT_JOB inválido: se espera projects/<proyecto>/locations/<región>/jobs/<job> (recibido "${input.job.slice(0, 120)}").`,
    );
  }
  const auth = await getAuth();
  const res = await auth.request<{ name?: string }>({
    url: `https://run.googleapis.com/v2/${input.job}:run`,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    data: buildRunRequest(input),
  });
  return { operation: typeof res.data?.name === "string" ? res.data.name : null };
}
