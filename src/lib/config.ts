/**
 * Configuración de servidor. No importar desde componentes de cliente
 * (para el navegador usa "@/lib/public-config").
 *
 * Despliegue objetivo: Google Cloud Run + Cloud SQL (Postgres) + Cloud Storage.
 * La plataforma funciona en varios modos sin cambiar código:
 *  - DATABASE_URL definido → Postgres (Cloud SQL, o cualquier Postgres ≥ 14) y
 *    acceso del personal con cuenta (tabla staff). Si no → store local en
 *    .data/ y acceso abierto (demo).
 *  - GCS_BUCKET definido → videos y fotogramas en Cloud Storage con URLs
 *    firmadas. Si no → archivos locales en .data/files.
 *  - Credencial de Anthropic → análisis real con Claude. Si no → motor
 *    simulado, siempre rotulado como tal en la UI.
 */
import type { RuntimeMode } from "./contract";

function env(name: string): string {
  return (process.env[name] ?? "").trim();
}

export const config = {
  /**
   * Cadena de conexión de Postgres. En Cloud Run con Cloud SQL:
   * postgresql://USUARIO:CLAVE@/BASE?host=/cloudsql/PROYECTO:REGION:INSTANCIA
   */
  get databaseUrl() {
    return env("DATABASE_URL");
  },
  /** true → SSL hacia Postgres (no hace falta con el socket de Cloud SQL). */
  get databaseSsl() {
    return env("DATABASE_SSL") === "1";
  },
  /** Tamaño máximo del pool de conexiones por instancia. */
  get databasePoolMax() {
    const n = Number(env("DATABASE_POOL_MAX"));
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 8;
  },
  /** Aplica las migraciones pendientes al primer uso (con candado de Postgres). Por defecto sí. */
  get autoMigrate() {
    return env("VIGIA_AUTO_MIGRATE") !== "0";
  },
  /** Bucket de Cloud Storage para la evidencia (videos y fotogramas). */
  get gcsBucket() {
    return env("GCS_BUCKET");
  },
  /** Proyecto de Google Cloud (opcional; en Cloud Run se detecta solo). */
  get gcpProject() {
    return env("GOOGLE_CLOUD_PROJECT") || env("GCP_PROJECT");
  },
  /** Secreto para firmar la cookie de sesión del personal. Obligatorio con DATABASE_URL. */
  get sessionSecret() {
    return env("VIGIA_SESSION_SECRET");
  },
  /** Cuenta administradora inicial: se crea al primer inicio de sesión si no existe. */
  get adminEmail() {
    return env("VIGIA_ADMIN_EMAIL").toLowerCase();
  },
  get adminPassword() {
    return env("VIGIA_ADMIN_PASSWORD");
  },
  get hasAnthropic() {
    return Boolean(env("ANTHROPIC_API_KEY") || env("ANTHROPIC_AUTH_TOKEN"));
  },
  /** Modelo de Claude para todos los análisis. */
  get aiModel() {
    return env("VIGIA_AI_MODEL") || "claude-opus-5-5";
  },
  /** low | medium | high | xhigh | max. En una emergencia importa la latencia: por defecto medium. */
  get aiEffort(): "low" | "medium" | "high" | "xhigh" | "max" {
    const v = env("VIGIA_AI_EFFORT");
    return v === "low" || v === "high" || v === "xhigh" || v === "max" ? v : "medium";
  },
  /** VIGIA_AI_FAST=1 activa el modo rápido (más tokens/seg, mayor precio). */
  get aiFast() {
    return env("VIGIA_AI_FAST") === "1";
  },
  /** VIGIA_AI=simulated fuerza el motor simulado aunque haya credencial. */
  get forceSimulated() {
    return env("VIGIA_AI").toLowerCase() === "simulated";
  },
  /** Ejecutable de ffmpeg (Cloud Run lo trae en la imagen). Vacío = sin extracción en el servidor. */
  get ffmpegPath() {
    return env("FFMPEG_PATH") || "ffmpeg";
  },
  /** Secreto HMAC para firmar subidas en modo local y tokens internos. */
  get fileSecret() {
    return env("VIGIA_FILE_SECRET") || env("VIGIA_SESSION_SECRET") || "vigia-solo-desarrollo";
  },
  /** Carpeta de datos del modo local. En Cloud Run el disco es efímero (memoria): solo para demos. */
  get localDataDir() {
    return env("VIGIA_DATA_DIR") || ".data";
  },
  /** URL pública de la app (para enlaces y QR generados en el servidor). */
  get appUrl() {
    return env("NEXT_PUBLIC_APP_URL").replace(/\/$/, "");
  },
  /**
   * Job de Cloud Run con GPU para 3D Gaussian Splatting, con el nombre completo
   * (projects/<p>/locations/<región>/jobs/<job>). Vacío = sin GPU.
   */
  get splatJob() {
    return env("SPLAT_JOB");
  },
  /** Iteraciones de entrenamiento por defecto de una reconstrucción. */
  get splatIterations() {
    const n = Number(env("SPLAT_ITERATIONS"));
    return Number.isInteger(n) && n >= 500 && n <= 30000 ? n : 7000;
  },
};

export function isPostgresConfigured(): boolean {
  return Boolean(config.databaseUrl);
}

export function isGcsConfigured(): boolean {
  return Boolean(config.gcsBucket);
}

export function aiEngineKind(): RuntimeMode["ai"] {
  return config.hasAnthropic && !config.forceSimulated ? "claude" : "simulated";
}

export function runtimeMode(): RuntimeMode {
  const pg = isPostgresConfigured();
  const ai = aiEngineKind();
  return {
    store: pg ? "postgres" : "local",
    files: isGcsConfigured() ? "gcs" : "local",
    ai,
    auth: pg ? "staff" : "open",
    model: ai === "claude" ? config.aiModel : null,
    // El job lee y escribe en el bucket: sin Cloud Storage no hay GPU aunque haya job.
    splat: config.splatJob && isGcsConfigured() ? "cloud_run_gpu" : "off",
  };
}
