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
  /**
   * Zello: lo usa el puente aparte (tools/zello-bridge), no el servidor web.
   * Cuenta del bot de Vigía (el *username* de Zello, no el correo).
   */
  get zelloUsername() {
    return env("ZELLO_USERNAME");
  },
  get zelloPassword() {
    return env("ZELLO_PASSWORD");
  },
  /**
   * Token de la Channel API para zello.io: el de desarrollo (dura 30 días), o se firma
   * uno con ZELLO_ISSUER + ZELLO_PRIVATE_KEY (PEM RSA de developers.zello.com).
   */
  get zelloAuthToken() {
    return env("ZELLO_AUTH_TOKEN");
  },
  get zelloIssuer() {
    return env("ZELLO_ISSUER");
  },
  get zelloPrivateKey() {
    // En variables de entorno los saltos de línea del PEM suelen venir como "\n".
    return env("ZELLO_PRIVATE_KEY").replace(/\\n/g, "\n");
  },
  /** wss://zello.io/ws (Zello gratis) o wss://zellowork.io/ws/<red> (Zello Work). */
  get zelloWsUrl() {
    return env("ZELLO_WS_URL") || "wss://zello.io/ws";
  },
  /** Canal de Zello que escucha el puente y en el que habla Vigía. */
  get zelloChannel() {
    return env("ZELLO_CHANNEL") || "demo-platanus";
  },
  /** Usuario de Zello del OBAC: lo que dice es una pregunta para Vigía. Vacío = solo el vocativo «Vigía, …». */
  get zelloObacUsername() {
    return env("ZELLO_OBAC_USERNAME");
  },
  /**
   * Token interno del puente Zello (Authorization: Bearer). Con él, el puente registra
   * comunicaciones y su estado sin sesión del personal. Vacío = solo en modo local abierto.
   */
  get bridgeToken() {
    return env("VIGIA_BRIDGE_TOKEN");
  },
  /** Llave de ElevenLabs: transcribe lo que llega por Zello y pone la voz de Vigía. */
  get elevenLabsApiKey() {
    return env("ELEVENLABS_API_KEY");
  },
  get sttModel() {
    return env("VIGIA_STT_MODEL") || "scribe_v1";
  },
  /** Voz de Vigía en ElevenLabs. Vacío = una voz de prueba (ver src/lib/server/zello/voice.ts). */
  get elevenLabsVoiceId() {
    return env("ELEVENLABS_VOICE_ID");
  },
  get ttsModel() {
    return env("VIGIA_TTS_MODEL") || "eleven_flash_v2_5";
  },
  /**
   * Detector YOLO (vigia/detector, p. ej. http://127.0.0.1:8765). Con él, cada cuadro pasa
   * primero por YOLO y Claude razona sobre las detecciones más un cuadro anotado.
   * Vacío = sin detector: el análisis manda los fotogramas a Claude con visión, como antes.
   */
  get detectorUrl() {
    return env("VIGIA_DETECTOR_URL").replace(/\/$/, "");
  },
  /**
   * "gcp" = el detector es un servicio privado de Cloud Run (deploy/detector.sh): cada llamada
   * lleva un token de identidad de la cuenta del servicio. Vacío = sin autenticación (local).
   */
  get detectorAuth() {
    return env("VIGIA_DETECTOR_AUTH").toLowerCase();
  },
  /**
   * Reconstrucción 3D en vivo (vigia-live3d, gpu/splat/LIVE3D.md, p. ej. http://127.0.0.1:8790).
   * Con él, los cuadros del video en vivo del dron se reenvían y el puesto de mando ve la nube
   * de puntos crecer. Vacío = sin vista 3D en vivo (todo lo demás sigue igual).
   */
  get live3dUrl() {
    return env("VIGIA_LIVE3D_URL").replace(/\/$/, "");
  },
  /** "gcp" = Cloud Run privado: cada llamada lleva un token de identidad. Vacío = sin autenticación (local). */
  get live3dAuth() {
    return env("VIGIA_LIVE3D_AUTH").toLowerCase();
  },
  /** Agente Vigía: escucha continua de las emergencias activas. VIGIA_AGENT=0 lo apaga. */
  get vigiaAgent() {
    return env("VIGIA_AGENT") !== "0";
  },
  /** Modelo del agente Vigía. Responde en segundos: por defecto esfuerzo bajo y modo rápido. */
  get vigiaAgentModel() {
    return env("VIGIA_AGENT_MODEL") || "claude-opus-5-5";
  },
  get vigiaAgentEffort(): "low" | "medium" | "high" | "xhigh" | "max" {
    const v = env("VIGIA_AGENT_EFFORT");
    return v === "medium" || v === "high" || v === "xhigh" || v === "max" ? v : "low";
  },
  /** VIGIA_AGENT_FAST=0 apaga el modo rápido del agente (solo existe en Opus). */
  get vigiaAgentFast() {
    return env("VIGIA_AGENT_FAST") !== "0";
  },
  get hasAnthropic() {
    return Boolean(env("ANTHROPIC_API_KEY") || env("ANTHROPIC_AUTH_TOKEN"));
  },
  /** Modelo de Claude para todos los análisis. */
  get aiModel() {
    return env("VIGIA_AI_MODEL") || "claude-opus-5-5";
  },
  /**
   * Modelo del observador en vivo del dron (una mirada cada 15 s a cuadros chicos).
   * Corre todo el vuelo: por eso no es el modelo principal de análisis.
   */
  get aiLiveModel() {
    return env("VIGIA_AI_LIVE_MODEL") || "claude-opus-5-5";
  },
  get aiLiveEffort(): "low" | "medium" | "high" | "xhigh" | "max" {
    const v = env("VIGIA_AI_LIVE_EFFORT");
    return v === "medium" || v === "high" || v === "xhigh" || v === "max" ? v : "low";
  },
  /**
   * Modo rápido en el observador (por defecto sí; VIGIA_AI_LIVE_FAST=0 lo apaga).
   * Solo existe en Opus: con otro modelo se ignora. Medido: ~2,2 s por mirada.
   */
  get aiLiveFast() {
    return env("VIGIA_AI_LIVE_FAST") !== "0";
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
  /**
   * Iteraciones de entrenamiento por defecto de una reconstrucción (las del paper original).
   * El job termina antes si se le acaba el tiempo de la tarea, así que es un techo, no un costo fijo.
   */
  get splatIterations() {
    const n = Number(env("SPLAT_ITERATIONS"));
    return Number.isInteger(n) && n >= 500 && n <= 30000 ? n : 30000;
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
