/**
 * Cliente de la Zello Channel API (WebSocket) para un canal. Lo usa el puente
 * tools/zello-bridge; no corre dentro del servidor web.
 *
 * - Inicia sesión con usuario, clave y auth_token (Zello gratis exige el token), y
 *   reconecta solo con espera creciente; tras un corte breve usa el refresh_token.
 * - El ping de Zello (cada 30 s) lo responde solo el WebSocket de Node.
 * - Arma cada transmisión entrante (on_stream_start → paquetes → on_stream_stop) y
 *   la entrega completa. Ignora lo que transmite la propia cuenta del puente.
 * - sendVoice transmite paquetes Opus al canal al ritmo real del audio.
 *
 * El socket se inyecta (createSocket) para probarlo sin red: ver client.test.ts.
 */
import { encodeZelloAudioPacket, parseCodecHeader, parseZelloPacket, type ZelloCodecHeader } from "./protocol";

/** Lo mínimo del WebSocket del navegador/Node que usa el cliente. */
export interface WebSocketLike {
  binaryType: string;
  readonly readyState: number;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

const WS_OPEN = 1;

export interface IncomingStream {
  streamId: number;
  channel: string;
  from: string;
  codec: ZelloCodecHeader;
  packetDurationMs: number;
  startedAt: Date;
  packets: Uint8Array[];
}

export interface ZelloTextMessage {
  channel: string;
  from: string;
  text: string;
  at: Date;
}

export interface ZelloChannelState {
  /** Sesión iniciada y canal en línea. */
  online: boolean;
  usersOnline: number | null;
  /** Último problema, en palabras; null si no hay. */
  error: string | null;
}

export interface ZelloHandlers {
  onState?(state: ZelloChannelState): void;
  /** Una transmisión terminó (o se cortó): trae todos sus paquetes. */
  onStream?(stream: IncomingStream): void;
  onText?(m: ZelloTextMessage): void;
}

export interface ZelloClientOptions {
  url: string;
  username: string;
  password: string;
  channel: string;
  /** auth_token para el logon; se pide en cada conexión (el JWT firmado dura minutos). */
  authToken: () => string;
  handlers: ZelloHandlers;
  createSocket?: (url: string) => WebSocketLike;
  log?: (msg: string) => void;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  commandTimeoutMs?: number;
  /** Una transmisión sin paquetes nuevos por este tiempo se da por terminada. */
  streamIdleMs?: number;
  /**
   * Zello admite una conexión por cuenta: tras tantas expulsiones dentro de `kickWindowMs`
   * el cliente deja de reconectar (dos puentes con la misma cuenta se pelearían para siempre).
   */
  maxKicks?: number;
  kickWindowMs?: number;
}

/** ~2 minutos de audio a 60 ms por paquete: tope de memoria por transmisión. */
const MAX_STREAM_PACKETS = 2000;

const ERROR_TEXT: Record<string, string> = {
  "not authorized": "Zello rechazó el usuario, la clave o el token",
  "not enough params": "faltan datos para iniciar sesión en Zello",
  "channels limit exceeded": "Zello gratis permite un solo canal por conexión",
  "server closed connection": "Zello cerró la conexión",
  "channel is not ready": "el canal todavía no está en línea",
  kicked: "otra sesión con la misma cuenta de Zello tomó la conexión (¿la cuenta del bot abierta en la app?)",
};

/** Errores que no se arreglan reintentando rápido: se espera el máximo antes de reconectar. */
const SLOW_RETRY = new Set(["not authorized", "kicked"]);

export function describeZelloError(code: string): string {
  return ERROR_TEXT[code] ?? code;
}

function sameUser(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Pending {
  resolve: (msg: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ZelloClient {
  private readonly o: Required<Omit<ZelloClientOptions, "handlers" | "log">> & Pick<ZelloClientOptions, "handlers" | "log">;
  private ws: WebSocketLike | null = null;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly streams = new Map<number, { stream: IncomingStream; lastAt: number }>();
  private refreshToken: string | null = null;
  private attempt = 0;
  private lastErrorCode: string | null = null;
  private stopped = true;
  private sending = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private current: ZelloChannelState = { online: false, usersOnline: null, error: null };
  /** Horas de las últimas expulsiones por otra sesión de la cuenta. */
  private kicks: number[] = [];

  constructor(opts: ZelloClientOptions) {
    this.o = {
      createSocket: (url) => new WebSocket(url) as unknown as WebSocketLike,
      baseBackoffMs: 1_000,
      maxBackoffMs: 30_000,
      commandTimeoutMs: 10_000,
      streamIdleMs: 10_000,
      maxKicks: 3,
      kickWindowMs: 5 * 60_000,
      ...opts,
    };
  }

  get state(): ZelloChannelState {
    return this.current;
  }

  /** true mientras alguien transmite en el canal (Vigía espera a que suelte). */
  get receiving(): boolean {
    return this.streams.size > 0;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.sweepTimer = setInterval(() => this.sweepStreams(), Math.max(50, Math.floor(this.o.streamIdleMs / 2)));
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.reconnectTimer = null;
    this.sweepTimer = null;
    const ws = this.ws;
    this.ws = null;
    ws?.close(1000, "fin");
    this.failPending("el puente se detuvo");
    this.setState({ online: false, usersOnline: null, error: null });
  }

  private log(msg: string): void {
    this.o.log?.(msg);
  }

  private setState(next: ZelloChannelState): void {
    const c = this.current;
    if (c.online === next.online && c.usersOnline === next.usersOnline && c.error === next.error) return;
    this.current = next;
    this.o.handlers.onState?.(next);
  }

  private connect(): void {
    if (this.stopped) return;
    let ws: WebSocketLike;
    try {
      ws = this.o.createSocket(this.o.url);
    } catch (err) {
      this.setState({ online: false, usersOnline: null, error: `no se pudo abrir la conexión: ${String(err)}` });
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.binaryType = "arraybuffer";
    ws.onopen = () => this.logon(ws);
    ws.onmessage = (ev) => {
      if (this.ws === ws) this.onMessage(ev.data);
    };
    ws.onerror = () => {
      // Siempre llega también onclose: ahí se reconecta.
    };
    ws.onclose = (ev) => {
      if (this.ws === ws) this.onClosed(ev);
    };
  }

  private logon(ws: WebSocketLike): void {
    const body: Record<string, unknown> = {
      command: "logon",
      username: this.o.username,
      password: this.o.password,
      channels: [this.o.channel],
    };
    const usedRefresh = Boolean(this.refreshToken);
    try {
      if (this.refreshToken) body.refresh_token = this.refreshToken;
      else body.auth_token = this.o.authToken();
    } catch (err) {
      // Sin token no hay cómo entrar: se detiene en vez de reintentar.
      this.stop();
      this.setState({ online: false, usersOnline: null, error: err instanceof Error ? err.message : String(err) });
      return;
    }
    // Sin features.transcriptions: el texto lo pone siempre ElevenLabs, nunca Zello.

    this.command(body)
      .then((res) => {
        if (typeof res.refresh_token === "string") this.refreshToken = res.refresh_token;
        this.lastErrorCode = null;
        this.log(`sesión iniciada en Zello como ${this.o.username}; esperando el canal «${this.o.channel}»`);
      })
      .catch((err: Error) => {
        const code = err.message;
        this.lastErrorCode = code;
        if (usedRefresh) this.refreshToken = null; // la próxima vez, con auth_token
        this.log(`Zello rechazó el inicio de sesión: ${code}`);
        this.setState({ online: false, usersOnline: null, error: describeZelloError(code) });
        if (this.ws === ws) ws.close(1000, "logon");
      });
  }

  private command(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WS_OPEN) return Promise.reject(new Error("sin conexión con Zello"));
    const seq = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error("Zello no respondió a tiempo"));
      }, this.o.commandTimeoutMs);
      this.pending.set(seq, { resolve, reject, timer });
      ws.send(JSON.stringify({ ...body, seq }));
    });
  }

  private failPending(reason: string): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }

  private onMessage(data: unknown): void {
    if (typeof data === "string") {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data) as Record<string, unknown>;
      } catch {
        this.log("mensaje de Zello que no es JSON; se ignora");
        return;
      }
      this.onJson(msg);
      return;
    }
    const bytes = toBytes(data);
    const packet = bytes ? parseZelloPacket(bytes) : null;
    if (!packet) return;
    const entry = this.streams.get(packet.streamId);
    if (!entry) return; // transmisión propia o desconocida
    if (entry.stream.packets.length < MAX_STREAM_PACKETS) entry.stream.packets.push(packet.data.slice());
    entry.lastAt = Date.now();
  }

  private onJson(msg: Record<string, unknown>): void {
    if (typeof msg.seq === "number" && this.pending.has(msg.seq) && ("success" in msg || "error" in msg)) {
      const p = this.pending.get(msg.seq)!;
      this.pending.delete(msg.seq);
      clearTimeout(p.timer);
      if (msg.success === true) p.resolve(msg);
      else p.reject(new Error(typeof msg.error === "string" ? msg.error : "error desconocido"));
      return;
    }
    switch (msg.command) {
      case "on_channel_status": {
        const online = msg.status === "online";
        if (online) this.attempt = 0;
        const users = typeof msg.users_online === "number" ? msg.users_online : null;
        const error = typeof msg.error === "string" && msg.error ? msg.error : null;
        if (online !== this.current.online) this.log(online ? `canal «${this.o.channel}» en línea (${users ?? "?"} usuarios)` : `canal «${this.o.channel}» fuera de línea${error ? `: ${error}` : ""}`);
        this.setState({ online, usersOnline: users, error });
        break;
      }
      case "on_stream_start": {
        const id = Number(msg.stream_id);
        const from = String(msg.from ?? "");
        if (!Number.isFinite(id) || sameUser(from, this.o.username)) break;
        const codec = parseCodecHeader(typeof msg.codec_header === "string" ? msg.codec_header : undefined);
        this.streams.set(id, {
          stream: {
            streamId: id,
            channel: String(msg.channel ?? this.o.channel),
            from,
            codec,
            packetDurationMs: Number(msg.packet_duration) || codec.frameSizeMs,
            startedAt: new Date(),
            packets: [],
          },
          lastAt: Date.now(),
        });
        break;
      }
      case "on_stream_stop":
        this.finishStream(Number(msg.stream_id));
        break;
      case "on_text_message":
        if (typeof msg.text === "string" && !sameUser(String(msg.from ?? ""), this.o.username)) {
          this.o.handlers.onText?.({ channel: String(msg.channel ?? this.o.channel), from: String(msg.from ?? ""), text: msg.text, at: new Date() });
        }
        break;
      case "on_error": {
        const code = String(msg.error ?? "");
        this.log(`error de Zello: ${describeZelloError(code)}`);
        if (code === "kicked") {
          this.lastErrorCode = code;
          this.kicks.push(Date.now());
        }
        if (code === "server closed connection" || code === "kicked") this.ws?.close(1000, "servidor");
        break;
      }
      default:
        break;
    }
  }

  private finishStream(id: number): void {
    const entry = this.streams.get(id);
    if (!entry) return;
    this.streams.delete(id);
    this.o.handlers.onStream?.(entry.stream);
  }

  /** Cierra las transmisiones que dejaron de llegar sin on_stream_stop (el emisor perdió señal). */
  private sweepStreams(): void {
    const now = Date.now();
    for (const [id, e] of this.streams) if (now - e.lastAt > this.o.streamIdleMs) this.finishStream(id);
  }

  private onClosed(ev: { code?: number; reason?: string }): void {
    this.ws = null;
    this.failPending("se cortó la conexión con Zello");
    // Lo que alcanzó a llegar de una transmisión cortada igual se registra.
    for (const id of [...this.streams.keys()]) this.finishStream(id);
    const error = this.lastErrorCode ? describeZelloError(this.lastErrorCode) : `se cortó la conexión con Zello (código ${ev.code ?? "?"})`;
    this.setState({ online: false, usersOnline: null, error: this.stopped ? this.current.error : error });
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    if (this.lastErrorCode === "kicked") {
      const now = Date.now();
      this.kicks = this.kicks.filter((t) => now - t <= this.o.kickWindowMs);
      if (this.kicks.length >= this.o.maxKicks) {
        // Dos puentes (o el puente y la app) se expulsarían cada 30 s para siempre: este se retira y el otro queda.
        const minutes = Math.max(1, Math.round(this.o.kickWindowMs / 60_000));
        const error = `otra sesión con la misma cuenta de Zello tomó la conexión ${this.kicks.length} veces en ${minutes} min (¿otro puente, el de Cloud Run, o la cuenta abierta en un teléfono?). Este puente dejó de reconectar para no pelearla: deja una sola sesión y reinícialo.`;
        this.log(error);
        this.stopped = true;
        this.setState({ online: false, usersOnline: null, error });
        return;
      }
    }
    const exp = this.o.baseBackoffMs * 2 ** Math.min(this.attempt, 10);
    // Con credenciales malas, o si otra sesión de la cuenta nos expulsó, no sirve insistir rápido.
    const delay = this.lastErrorCode && SLOW_RETRY.has(this.lastErrorCode) ? this.o.maxBackoffMs : Math.min(this.o.maxBackoffMs, exp);
    this.attempt += 1;
    this.log(`reconectando a Zello en ${Math.round(delay / 100) / 10} s`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  /**
   * Transmite una voz al canal: start_stream, los paquetes al ritmo del audio y
   * stop_stream. Lanza si el canal no está en línea o se corta la conexión.
   */
  async sendVoice(packets: Uint8Array[], opts: { codecHeader: string; packetDurationMs: number }): Promise<void> {
    if (!this.current.online || !this.ws) throw new Error("Zello no está en línea.");
    if (this.sending) throw new Error("Ya hay una transmisión de Vigía en curso.");
    this.sending = true;
    let streamId: number | null = null;
    try {
      const res = await this.command({
        command: "start_stream",
        channel: this.o.channel,
        type: "audio",
        codec: "opus",
        codec_header: opts.codecHeader,
        packet_duration: opts.packetDurationMs,
      });
      streamId = Number(res.stream_id);
      if (!Number.isFinite(streamId)) throw new Error("Zello no devolvió stream_id.");
      const t0 = Date.now();
      // Un par de paquetes de adelanto absorben la variación de la red sin apurar el audio.
      const lead = opts.packetDurationMs * 2;
      for (let i = 0; i < packets.length; i++) {
        const wait = t0 + i * opts.packetDurationMs - lead - Date.now();
        if (wait > 0) await sleep(wait);
        const ws = this.ws;
        if (!ws || ws.readyState !== WS_OPEN) throw new Error("se cortó la conexión con Zello mientras Vigía hablaba");
        ws.send(encodeZelloAudioPacket(streamId, packets[i]));
      }
    } finally {
      if (streamId !== null && Number.isFinite(streamId)) {
        await this.command({ command: "stop_stream", stream_id: streamId, channel: this.o.channel }).catch(() => undefined);
      }
      this.sending = false;
    }
  }
}
