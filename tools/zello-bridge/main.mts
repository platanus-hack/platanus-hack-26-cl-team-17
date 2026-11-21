/**
 * Puente Zello ⇄ Vigía. Proceso aparte (notebook o Jetson) que mantiene abierta la
 * conexión con Zello: no cabe en una ruta de Next.js en Cloud Run.
 *
 *   npm run zello -- [--url https://vigia.example] [--incident VG-XXXX] [--listen-only]
 *
 * Lee la configuración de .env.local (ZELLO_*, ELEVENLABS_*, VIGIA_BRIDGE_TOKEN) o del entorno.
 * - Escucha el canal ZELLO_CHANNEL y registra cada transmisión, transcrita, en la
 *   bitácora de todas las emergencias abiertas (o solo la de --incident).
 * - Dice en el canal lo que el agente marca para hablar, con las reglas duras de
 *   src/lib/vigia/rules.ts (20 s entre mensajes salvo persona, filtro de «no hay
 *   nadie», sin órdenes a las unidades).
 * - Informa su estado a la mesa de mando cada 10 s.
 * Sin credenciales de Zello avisa y termina: la app sigue funcionando sin él.
 */
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { config } from "@/lib/config";
import { ZelloBridge } from "@/lib/server/zello/bridge";
import { ZelloClient } from "@/lib/server/zello/client";
import { zelloTokenSource } from "@/lib/server/zello/jwt";
import { createVigiaApi } from "@/lib/server/zello/vigia-api";
import { speakToPackets, TEST_VOICE_ID } from "@/lib/server/zello/voice";
import { transcribeAudio } from "@/lib/server/transcribe";
import { sanitizeForObac, speechAllowed } from "@/lib/vigia/rules";

const POLL_MS = 1_500;
const SPEAK_TICK_MS = 500;
const HEARTBEAT_MS = 10_000;

function log(msg: string): void {
  const t = new Date().toLocaleTimeString("es-CL", { hour12: false });
  console.log(`[${t}] ${msg}`);
}

const HELP = `Puente Zello ⇄ Vigía

Uso: npm run zello -- [opciones]

  --url URL        URL base de Vigía (por defecto VIGIA_URL o http://localhost:3000)
  --incident ID    Registrar solo en esta emergencia (id o código VG-XXXX).
                   Por defecto: todas las emergencias abiertas.
  --listen-only    Solo escuchar: Vigía no habla en el canal.
  --channel NOMBRE Canal de Zello (por defecto ZELLO_CHANNEL o demo-platanus).
  -h, --help       Esta ayuda.

Variables (.env.local): ZELLO_USERNAME, ZELLO_PASSWORD, ZELLO_AUTH_TOKEN o
ZELLO_ISSUER + ZELLO_PRIVATE_KEY, ZELLO_CHANNEL, ZELLO_OBAC_USERNAME,
ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID, VIGIA_BRIDGE_TOKEN.`;

function main(): number | void {
  const { values } = parseArgs({
    options: {
      url: { type: "string" },
      incident: { type: "string" },
      "listen-only": { type: "boolean", default: false },
      channel: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }

  const url = values.url || process.env.VIGIA_URL || "http://localhost:3000";
  const channel = values.channel || config.zelloChannel;
  const tokenSource = zelloTokenSource({ authToken: config.zelloAuthToken, issuer: config.zelloIssuer, privateKey: config.zelloPrivateKey });
  const missing = [
    !config.zelloUsername && "ZELLO_USERNAME",
    !config.zelloPassword && "ZELLO_PASSWORD",
    !tokenSource && "ZELLO_AUTH_TOKEN (o ZELLO_ISSUER + ZELLO_PRIVATE_KEY)",
  ].filter(Boolean);
  if (missing.length > 0) {
    console.error(`Falta configurar Zello en .env.local: ${missing.join(", ")}.\nEl puente no arranca; Vigía sigue funcionando sin Zello.`);
    return 1;
  }

  const hasEleven = Boolean(config.elevenLabsApiKey);
  const hasFfmpeg = spawnSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" }).stdout?.includes("libopus") ?? false;
  const listenOnly = values["listen-only"] || !hasEleven || !hasFfmpeg;
  if (!hasEleven) log("sin ELEVENLABS_API_KEY: no se transcribe (queda la grabación) y Vigía no habla");
  else if (!hasFfmpeg) log("sin ffmpeg con libopus: Vigía no puede hablar (solo escucha)");
  if (!config.bridgeToken) log("sin VIGIA_BRIDGE_TOKEN: solo funciona contra un Vigía en modo local abierto");
  if (!listenOnly && !config.elevenLabsVoiceId) log(`sin ELEVENLABS_VOICE_ID: se usa la voz de prueba ${TEST_VOICE_ID}`);

  const vigia = createVigiaApi(url, config.bridgeToken);
  let bridge: ZelloBridge | null = null;
  let heartbeatSoon: ReturnType<typeof setTimeout> | null = null;

  const client = new ZelloClient({
    url: config.zelloWsUrl,
    username: config.zelloUsername,
    password: config.zelloPassword,
    channel,
    authToken: tokenSource!,
    log,
    handlers: {
      onState: () => {
        // El cambio de estado llega a la mesa sin esperar el latido.
        if (heartbeatSoon) clearTimeout(heartbeatSoon);
        heartbeatSoon = setTimeout(() => void heartbeat(), 300);
      },
      onStream: (s) => void bridge?.onStream(s),
      onTranscription: (t) => bridge?.onTranscription(t),
      onText: (m) => void bridge?.onText(m),
    },
  });

  bridge = new ZelloBridge({
    channel,
    obacUsername: config.zelloObacUsername,
    pinnedIncident: values.incident ?? null,
    vigia,
    radio: client,
    rules: { sanitize: sanitizeForObac, allowed: speechAllowed },
    transcribe: (ogg) => transcribeAudio(ogg, "audio/ogg", "zello.ogg"),
    voice: listenOnly
      ? null
      : (text) => speakToPackets(text, { apiKey: config.elevenLabsApiKey, voiceId: config.elevenLabsVoiceId, modelId: config.ttsModel }),
    log,
  });

  let heartbeatFailing = false;
  let stopped = false;
  async function heartbeat(): Promise<void> {
    if (!bridge) return;
    try {
      await vigia.postStatus(bridge.status(listenOnly, stopped));
      if (heartbeatFailing) log("Vigía vuelve a recibir el estado del puente");
      heartbeatFailing = false;
    } catch (err) {
      if (!heartbeatFailing) log(`no se pudo informar el estado a ${url}: ${String(err)}`);
      heartbeatFailing = true;
    }
  }

  let polling = false;
  const pollTimer = setInterval(() => {
    if (polling || !bridge) return;
    polling = true;
    void bridge.pollSalida().finally(() => (polling = false));
  }, POLL_MS);
  const speakTimer = setInterval(() => void bridge?.speakNext(), SPEAK_TICK_MS);
  const beatTimer = setInterval(() => void heartbeat(), HEARTBEAT_MS);

  log(`puente Zello → ${url} · canal «${channel}» como ${config.zelloUsername}${listenOnly ? " · solo escucha" : ""}${values.incident ? ` · solo ${values.incident}` : " · todas las emergencias abiertas"}`);
  client.start();
  void heartbeat();

  let stopping = false;
  const shutdown = async () => {
    if (stopping) process.exit(130);
    stopping = true;
    log("deteniendo el puente…");
    clearInterval(pollTimer);
    clearInterval(speakTimer);
    clearInterval(beatTimer);
    client.stop();
    stopped = true;
    await heartbeat(); // la mesa ve «puente detenido» de inmediato
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

const code = main();
if (typeof code === "number") process.exit(code);
