/**
 * Lógica del puente Zello ⇄ Vigía, sin red propia: recibe las piezas (cliente de
 * Zello, API de Vigía, transcripción, voz, reglas) y las conecta. Probado en
 * bridge.test.ts; el proceso real lo arma tools/zello-bridge/main.mts.
 *
 * Entrada: cada transmisión del canal → Ogg Opus → texto (on_transcription si
 * llega, si no ElevenLabs) → bitácora de TODAS las emergencias abiertas, con
 * speaker = usuario de Zello, channel = canal y source "zello".
 *
 * Salida: los mensajes del agente con speak = true (GET …/vigia/salida) se dicen
 * en el canal. Reglas duras, como última barrera antes del audio:
 *  - se pasa el texto por sanitize (filtro de «no hay nadie», sin órdenes a unidades);
 *  - como máximo un mensaje cada ~20 s salvo prioridad "persona" (rules.allowed);
 *  - Vigía no habla encima de alguien: espera a que suelte el PTT.
 * Mientras la salida del agente no exista (404), las preguntas del OBAC se
 * responden con POST …/ask. Lo que Vigía dice también queda en la bitácora de la
 * emergencia de origen, con speaker "Vigía" y su grabación.
 */
import type { ZelloBridgeStatus } from "@/lib/contract";
import { UNTRANSCRIBED_COMM_TEXT } from "@/lib/labels";
import type { IncomingStream, ZelloChannelState, ZelloTranscription, ZelloTextMessage } from "./client";
import { isObacCommWith, VIGIA_SPEAKER } from "./channels";
import { buildOggOpus, opusDurationSeconds } from "./protocol";
import type { VoicePackets } from "./voice";
import type { OpenIncident, SalidaItem, VigiaApi } from "./vigia-api";

export type SpeechPriority = "persona" | "riesgo" | "recursos" | "resto";

/** Reglas duras de lo que Vigía dice (las de src/lib/vigia/rules.ts). */
export interface SpeechRules {
  sanitize(text: string): { text: string; blocked: boolean; reasons: string[] };
  /** kind "respuesta" (el OBAC preguntó) no espera los 20 s; "persona" pasa siempre. */
  allowed(p: { priority: SpeechPriority; kind?: string; lastSpokenAt: number | null; now: number; silenced: boolean }): boolean;
}

/** Lo que el puente usa del cliente de Zello. */
export interface RadioPort {
  readonly state: ZelloChannelState;
  readonly receiving: boolean;
  sendVoice(packets: Uint8Array[], opts: { codecHeader: string; packetDurationMs: number }): Promise<void>;
}

export interface BridgeDeps {
  channel: string;
  /** Usuario de Zello del OBAC; vacío = solo el vocativo «Vigía, …». */
  obacUsername: string;
  /** Id o código de una emergencia: solo a esa. null = todas las abiertas. */
  pinnedIncident: string | null;
  vigia: VigiaApi;
  radio: RadioPort;
  rules: SpeechRules;
  transcribe: (ogg: Uint8Array) => Promise<string | null>;
  /** null = solo escucha (sin ElevenLabs o con --listen-only). */
  voice: ((text: string) => Promise<VoicePackets>) | null;
  log: (msg: string) => void;
  now?: () => number;
  /** Espera de on_transcription tras el fin de la transmisión: si aún no llegó ninguna / si ya llegaron. */
  transcriptionWaitMs?: { unseen: number; seen: number };
  /** Tiempo máximo esperando que alguien suelte el PTT antes de hablar. */
  floorWaitMs?: number;
}

/** Transmisiones más cortas que esto son toques accidentales del PTT. */
const MIN_TRANSMISSION_S = 0.4;
/** Un mensaje que no se alcanzó a decir en este tiempo ya no sirve por voz (queda en pantalla). */
const SPEECH_TTL_MS = 45_000;
/** Al empezar a leer la salida de una emergencia, solo se dice lo de los últimos segundos. */
const FRESH_MS = 30_000;
const INCIDENTS_TTL_MS = 10_000;
const PRIORITY_ORDER: SpeechPriority[] = ["persona", "riesgo", "recursos", "resto"];

interface QueuedSpeech {
  text: string;
  priority: SpeechPriority;
  expiresAt: number;
  origin: string;
  /** Emergencia de origen: ahí se anota lo que Vigía dijo. */
  incidentId: string | null;
  /** kind de la salida del agente ("respuesta", "alerta", "resumen"…); "respuesta" para /ask. */
  kind: string | null;
  /** true = responde una pregunta del OBAC: sale sin esperar los 20 s y nunca se queda callado. */
  answer: boolean;
}

/** Si el filtro bloquea toda la respuesta a una pregunta, Vigía dice esto en vez de callar. */
export const BLOCKED_ANSWER_TEXT = "OBAC, Vigía: eso es una decisión del mando. No doy indicaciones por radio.";

function splitSentences(text: string): string[] {
  return text.match(/[^.!?¿¡]*[.!?]+|[^.!?]+$/g)?.map((x) => x.trim()).filter(Boolean) ?? [text];
}

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

export class ZelloBridge {
  private readonly now: () => number;
  private readonly wait: { unseen: number; seen: number };
  private readonly floorWaitMs: number;
  private transcriptionsSeen = false;
  private readonly transcripts = new Map<number, { text: string; at: number }>();
  private readonly waiters = new Map<number, (text: string) => void>();
  private incidentsCache: { at: number; list: OpenIncident[] } | null = null;
  private readonly cursors = new Map<string, number>();
  /** null = no se sabe; true = el servidor no tiene la salida del agente (se usa /ask). */
  private salidaMissing: boolean | null = null;
  private readonly queue: QueuedSpeech[] = [];
  private speaking = false;
  private lastSpokenAt: number | null = null;
  private lastSpoken: ZelloBridgeStatus["last_spoken"] = null;
  private lastTransmission: ZelloBridgeStatus["last_transmission"] = null;
  private incidentCodes: string[] = [];
  /** Cadena de transmisiones: se registran en la bitácora en el orden en que se dijeron. */
  private chain: Promise<void> = Promise.resolve();
  /** Las preguntas a /ask van aparte: una respuesta lenta no atrasa el registro de la radio. */
  private askChain: Promise<void> = Promise.resolve();
  private warnedMulti = 0;

  constructor(private readonly d: BridgeDeps) {
    this.now = d.now ?? Date.now;
    this.wait = d.transcriptionWaitMs ?? { unseen: 1_500, seen: 6_000 };
    this.floorWaitMs = d.floorWaitMs ?? 10_000;
  }

  /* ───────────── Entrada ───────────── */

  onTranscription(t: ZelloTranscription): void {
    if (t.truncated) return; // la parcial (al minuto) la reemplaza la final
    this.transcriptionsSeen = true;
    const waiter = this.waiters.get(t.streamId);
    if (waiter) waiter(t.text);
    else this.transcripts.set(t.streamId, { text: t.text, at: this.now() });
  }

  private waitTranscription(streamId: number): Promise<string | null> {
    const ready = this.transcripts.get(streamId);
    if (ready) {
      this.transcripts.delete(streamId);
      return Promise.resolve(ready.text);
    }
    const ms = this.transcriptionsSeen ? this.wait.seen : this.wait.unseen;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(streamId);
        resolve(null);
      }, ms);
      this.waiters.set(streamId, (text) => {
        clearTimeout(timer);
        this.waiters.delete(streamId);
        resolve(text);
      });
    });
  }

  /** Una transmisión terminó. Devuelve la promesa de su registro (para pruebas). */
  onStream(stream: IncomingStream): Promise<void> {
    const job = this.chain.then(() => this.handleStream(stream)).catch((err) => this.d.log(`no se pudo registrar la transmisión de ${stream.from}: ${String(err)}`));
    this.chain = job;
    return job;
  }

  onText(m: ZelloTextMessage): Promise<void> {
    const job = this.chain
      .then(() => this.record({ text: m.text, from: m.from, at: m.at.toISOString(), ogg: null }))
      .catch((err) => this.d.log(`no se pudo registrar el texto de ${m.from}: ${String(err)}`));
    this.chain = job;
    return job;
  }

  private async handleStream(s: IncomingStream): Promise<void> {
    const fallbackSamples = s.codec.frameSizeMs * 48 * s.codec.framesPerPacket;
    const seconds = opusDurationSeconds(s.packets, fallbackSamples);
    if (s.packets.length === 0 || seconds < MIN_TRANSMISSION_S) {
      this.d.log(`transmisión de ${s.from} de ${seconds.toFixed(1)} s: se ignora (toque del PTT)`);
      return;
    }
    const ogg = buildOggOpus(s.packets, { sampleRate: s.codec.sampleRate, fallbackSamples });
    const zelloText = await this.waitTranscription(s.streamId);
    const text = zelloText ?? (await this.d.transcribe(ogg));
    this.d.log(`${s.from} (${seconds.toFixed(1)} s): ${text ?? "[sin transcribir]"}${zelloText ? " · transcripción de Zello" : ""}`);
    await this.record({ text: text ?? "", from: s.from, at: s.startedAt.toISOString(), ogg });
  }

  private async record(t: { text: string; from: string; at: string; ogg: Uint8Array | null }): Promise<void> {
    const targets = await this.openIncidents();
    this.lastTransmission = { at: t.at, from: t.from, text: clip(t.text || UNTRANSCRIBED_COMM_TEXT, 300) };
    if (targets.length === 0) {
      this.d.log(`no hay emergencias abiertas: la transmisión de ${t.from} no se registra`);
      return;
    }
    for (const inc of targets) {
      try {
        const audio_path = t.ogg ? await this.d.vigia.uploadAudio(inc.id, t.ogg) : undefined;
        await this.d.vigia.addComm(inc.id, {
          text: clip((t.text || UNTRANSCRIBED_COMM_TEXT).trim(), 2000),
          speaker: clip(t.from, 60),
          channel: clip(this.d.channel, 40),
          at: t.at,
          audio_path,
        });
      } catch (err) {
        this.d.log(`no se pudo registrar en ${inc.code}: ${String(err)}`);
      }
    }
    if (t.text && isObacCommWith({ source: "zello", speaker: t.from, text: t.text }, this.d.obacUsername)) {
      const inc = targets[0];
      const question = t.text;
      this.askChain = this.askChain.then(() => this.answerWithAskIfNeeded(inc, question)).catch(() => undefined);
    }
  }

  /** Espera a que terminen las preguntas en curso (para pruebas). */
  idle(): Promise<void> {
    return this.chain.then(() => this.askChain);
  }

  /** Sin la salida del agente, la pregunta del OBAC se responde con /ask (la emergencia más reciente). */
  private async answerWithAskIfNeeded(inc: OpenIncident, question: string): Promise<void> {
    if (this.salidaMissing === null) await this.pollIncident(inc);
    if (this.salidaMissing !== true) return; // la responde el agente por su salida
    try {
      const { answer } = await this.d.vigia.ask(inc.id, question);
      if (answer.trim()) this.enqueue({ text: answer.trim(), priority: "resto", origin: `/ask ${inc.code}`, incidentId: inc.id, kind: "respuesta" });
    } catch (err) {
      this.d.log(`/ask no respondió: ${String(err)}`);
    }
  }

  /** Emergencias que reciben las transmisiones (caché corta). */
  async openIncidents(): Promise<OpenIncident[]> {
    const now = this.now();
    if (this.incidentsCache && now - this.incidentsCache.at < INCIDENTS_TTL_MS) return this.incidentsCache.list;
    let list = await this.d.vigia.openIncidents();
    const pin = this.d.pinnedIncident?.trim().toUpperCase();
    if (pin) list = list.filter((i) => i.id.toUpperCase() === pin || i.code.toUpperCase() === pin);
    this.incidentsCache = { at: now, list };
    this.incidentCodes = list.map((i) => i.code);
    if (!pin && list.length > 1 && list.length !== this.warnedMulti) {
      this.warnedMulti = list.length;
      this.d.log(
        `hay ${list.length} emergencias abiertas: cada transmisión entra a todas y las preguntas del OBAC se responden con la más reciente (${list[0].code}). Usa --incident para fijar una.`,
      );
    }
    return list;
  }

  /* ───────────── Salida ───────────── */

  /** Lee la salida del agente de todas las emergencias abiertas y encola lo que hay que decir. */
  async pollSalida(): Promise<void> {
    let list: OpenIncident[];
    try {
      list = await this.openIncidents();
    } catch (err) {
      this.d.log(`no se pudo leer la lista de emergencias: ${String(err)}`);
      return;
    }
    for (const inc of list) await this.pollIncident(inc);
  }

  private async pollIncident(inc: OpenIncident): Promise<void> {
    const cursor = this.cursors.get(inc.id) ?? null;
    let res: Awaited<ReturnType<VigiaApi["salida"]>>;
    try {
      res = await this.d.vigia.salida(inc.id, cursor);
    } catch (err) {
      this.d.log(`no se pudo leer la salida de ${inc.code}: ${String(err)}`);
      return;
    }
    if (res === "missing") {
      if (this.salidaMissing !== true) this.d.log("el servidor aún no tiene la salida del agente: las preguntas del OBAC se responden con /ask");
      this.salidaMissing = true;
      return;
    }
    if (this.salidaMissing !== false) this.d.log("salida del agente disponible: Vigía habla lo que decide el agente");
    this.salidaMissing = false;
    const now = this.now();
    const items = cursor === null ? res.items.filter((i) => now - Date.parse(i.at) <= FRESH_MS) : res.items;
    for (const item of items) if (item.speak) this.enqueueItem(item, inc);
    this.cursors.set(inc.id, Math.max(res.last_seq, cursor ?? -1));
  }

  private enqueueItem(item: SalidaItem, inc: OpenIncident): void {
    const at = Date.parse(item.at);
    const base = Number.isFinite(at) ? Math.min(at, this.now()) : this.now();
    this.enqueue({
      text: item.text,
      priority: item.priority,
      origin: `${inc.code} #${item.seq}`,
      expiresAt: base + SPEECH_TTL_MS,
      incidentId: inc.id,
      kind: item.kind ?? null,
    });
  }

  enqueue(s: {
    text: string;
    priority: SpeechPriority;
    origin: string;
    expiresAt?: number;
    incidentId?: string | null;
    kind?: string | null;
    answer?: boolean;
  }): void {
    const kind = s.kind ?? (s.answer ? "respuesta" : null);
    this.queue.push({
      text: s.text,
      priority: s.priority,
      origin: s.origin,
      expiresAt: s.expiresAt ?? this.now() + SPEECH_TTL_MS,
      incidentId: s.incidentId ?? null,
      kind,
      answer: kind === "respuesta",
    });
  }

  /**
   * Texto que se puede decir: el filtrado entero, o solo las oraciones que pasan el
   * filtro. Si no queda nada, la frase fija para una respuesta, o null (no se dice).
   */
  private speakable(item: QueuedSpeech): { text: string; note: string | null } | null {
    const whole = this.d.rules.sanitize(item.text);
    if (!whole.blocked) return { text: whole.text, note: null };
    const kept = splitSentences(item.text)
      .map((x) => this.d.rules.sanitize(x))
      .filter((r) => !r.blocked)
      .map((r) => r.text);
    const note = `bloqueado por las reglas (${whole.reasons.join(", ") || "sin motivo"})`;
    if (kept.length > 0) return { text: kept.join(" "), note: `${note}: se dice solo lo permitido` };
    if (item.answer) return { text: BLOCKED_ANSWER_TEXT, note: `${note}: se dice la frase fija` };
    return null;
  }

  /**
   * Siguiente mensaje que las reglas dejan decir ahora: primero "persona", luego las
   * respuestas al OBAC, luego por prioridad y orden de llegada. Un resumen que espera
   * sus 20 s no tapa una respuesta que puede salir ya.
   */
  private nextSpeech(now: number): QueuedSpeech | null {
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i].expiresAt < now) {
        this.d.log(`no se alcanzó a decir (${this.queue[i].origin}): ${clip(this.queue[i].text, 80)}`);
        this.queue.splice(i, 1);
      }
    }
    const rank = (q: QueuedSpeech) => (q.priority === "persona" ? 0 : q.answer ? 1 : 2 + PRIORITY_ORDER.indexOf(q.priority));
    const ordered = this.queue.map((q, i) => ({ q, i })).sort((a, b) => rank(a.q) - rank(b.q) || a.i - b.i);
    for (const { q } of ordered) {
      const ok = this.d.rules.allowed({ priority: q.priority, kind: q.kind ?? undefined, lastSpokenAt: this.lastSpokenAt, now, silenced: false });
      if (ok) return q;
    }
    return null;
  }

  /**
   * Dice el siguiente mensaje si las reglas lo permiten. Lo llama un reloj cada
   * ~0,5 s. Devuelve true si habló (para pruebas).
   */
  async speakNext(): Promise<boolean> {
    if (this.speaking) return false;
    const now = this.now();
    const item = this.nextSpeech(now);
    if (!item) return false;

    const clean = this.speakable(item);
    if (!clean) {
      this.queue.splice(this.queue.indexOf(item), 1);
      this.d.log(`bloqueado por las reglas, no se dice: ${clip(item.text, 100)}`);
      return false;
    }
    if (clean.note) this.d.log(`${clean.note}: ${clip(item.text, 100)}`);
    if (!this.d.radio.state.online) return false;
    if (this.d.radio.receiving) {
      // No hablar encima de nadie; si alguien no suelta el PTT, el mensaje igual caduca.
      return false;
    }

    this.queue.splice(this.queue.indexOf(item), 1);
    if (!this.d.voice) {
      this.d.log(`(solo escucha) no se dice: ${clip(clean.text, 100)}`);
      return false;
    }
    this.speaking = true;
    this.lastSpokenAt = now;
    try {
      const voice = await this.d.voice(clean.text);
      await this.waitFloor();
      await this.d.radio.sendVoice(voice.packets, { codecHeader: voice.codecHeader, packetDurationMs: voice.packetDurationMs });
      const at = new Date(now).toISOString();
      this.lastSpoken = { at, text: clip(clean.text, 300) };
      this.d.log(`Vigía dijo (${item.priority}, ${item.origin}): ${clean.text}`);
      if (item.incidentId) void this.recordSpoken(item.incidentId, clean.text, at, voice);
      return true;
    } catch (err) {
      this.d.log(`Vigía no pudo hablar: ${String(err)}`);
      return false;
    } finally {
      this.speaking = false;
    }
  }

  /** Lo que Vigía dijo queda en la bitácora de la emergencia de origen, con su grabación. */
  private async recordSpoken(incidentId: string, text: string, at: string, voice: VoicePackets): Promise<void> {
    try {
      const ogg = buildOggOpus(voice.packets, { sampleRate: 16_000, fallbackSamples: voice.packetDurationMs * 48 });
      const audio_path = await this.d.vigia.uploadAudio(incidentId, ogg);
      await this.d.vigia.addComm(incidentId, { text: clip(text, 2000), speaker: VIGIA_SPEAKER, channel: clip(this.d.channel, 40), at, audio_path });
    } catch (err) {
      this.d.log(`no se pudo anotar en la bitácora lo que dijo Vigía: ${String(err)}`);
    }
  }

  /** Si alguien empezó a hablar mientras se sintetizaba la voz, espera a que suelte (con tope). */
  private async waitFloor(): Promise<void> {
    const until = this.now() + this.floorWaitMs;
    while (this.d.radio.receiving && this.now() < until) await new Promise((r) => setTimeout(r, 200));
  }

  /* ───────────── Estado ───────────── */

  status(listenOnly: boolean, stopped = false): ZelloBridgeStatus {
    const s = this.d.radio.state;
    return {
      stopped,
      connected: !stopped && s.online,
      channel: this.d.channel,
      users_online: s.usersOnline,
      listen_only: listenOnly || !this.d.voice,
      error: s.error,
      incident_codes: this.incidentCodes,
      last_transmission: this.lastTransmission,
      last_spoken: this.lastSpoken,
      sent_at: new Date(this.now()).toISOString(),
    };
  }
}
