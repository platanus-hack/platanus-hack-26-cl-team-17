import assert from "node:assert/strict";
import { test } from "node:test";
import { ZelloClient, type IncomingStream, type WebSocketLike, type ZelloChannelState } from "./client";
import { parseZelloPacket } from "./protocol";

/** Socket falso: guarda lo que manda el cliente y deja simular al servidor de Zello. */
class FakeSocket implements WebSocketLike {
  binaryType = "blob";
  readyState = 0;
  sent: (string | Uint8Array)[] = [];
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string | Uint8Array) {
    this.sent.push(data);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  json(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  binary(bytes: number[]) {
    this.onmessage?.({ data: new Uint8Array(bytes).buffer });
  }
  commands(): Record<string, unknown>[] {
    return this.sent.filter((d): d is string => typeof d === "string").map((d) => JSON.parse(d) as Record<string, unknown>);
  }
  last(command: string): Record<string, unknown> {
    const c = this.commands().filter((x) => x.command === command).at(-1);
    assert.ok(c, `no se mandó ${command}`);
    return c;
  }
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function setup(extra: Partial<ConstructorParameters<typeof ZelloClient>[0]> = {}) {
  const sockets: FakeSocket[] = [];
  const states: ZelloChannelState[] = [];
  const streams: IncomingStream[] = [];
  const client = new ZelloClient({
    url: "wss://zello.test/ws",
    username: "vigia_bot",
    password: "clave",
    channel: "demo",
    authToken: () => "jwt-1",
    handlers: { onState: (s) => states.push(s), onStream: (s) => streams.push(s) },
    createSocket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    baseBackoffMs: 5,
    maxBackoffMs: 20,
    commandTimeoutMs: 500,
    ...extra,
  });
  return { client, sockets, states, streams };
}

async function logIn(sock: FakeSocket) {
  sock.open();
  const logon = sock.last("logon");
  sock.json({ seq: logon.seq, success: true, refresh_token: "refresh-1" });
  await tick();
  sock.json({ command: "on_channel_status", channel: "demo", status: "online", users_online: 3 });
  return logon;
}

test("logon manda token, usuario, clave y un solo canal; queda en línea con el canal", async () => {
  const { client, sockets, states } = setup();
  client.start();
  const logon = await logIn(sockets[0]);
  assert.equal(sockets[0].binaryType, "arraybuffer");
  assert.equal(logon.auth_token, "jwt-1");
  assert.equal(logon.username, "vigia_bot");
  assert.equal(logon.password, "clave");
  assert.deepEqual(logon.channels, ["demo"]);
  assert.deepEqual(logon.features, { transcriptions: true });
  assert.deepEqual(states.at(-1), { online: true, usersOnline: 3, error: null });
  client.stop();
});

test("arma la transmisión entrante y no entrega la de la propia cuenta", async () => {
  const { client, sockets, streams } = setup();
  client.start();
  const s = sockets[0];
  await logIn(s);
  s.json({ command: "on_stream_start", stream_id: 9, channel: "demo", from: "B-3", codec_header: "gD4BPA==", packet_duration: 60 });
  assert.equal(client.receiving, true);
  s.binary([1, 0, 0, 0, 9, 0, 0, 0, 1, 0xaa]);
  s.binary([1, 0, 0, 0, 9, 0, 0, 0, 2, 0xbb, 0xcc]);
  s.binary([1, 0, 0, 0, 8, 0, 0, 0, 1, 0xdd]); // otra transmisión: se ignora
  s.json({ command: "on_stream_stop", stream_id: 9 });
  s.json({ command: "on_stream_start", stream_id: 10, channel: "demo", from: "Vigia_Bot", codec_header: "gD4BPA==" });
  s.binary([1, 0, 0, 0, 10, 0, 0, 0, 1, 0xee]);
  s.json({ command: "on_stream_stop", stream_id: 10 });
  assert.equal(streams.length, 1);
  assert.equal(streams[0].from, "B-3");
  assert.equal(streams[0].packetDurationMs, 60);
  assert.equal(streams[0].codec.sampleRate, 16000);
  assert.deepEqual(streams[0].packets.map((p) => [...p]), [[0xaa], [0xbb, 0xcc]]);
  assert.equal(client.receiving, false);
  client.stop();
});

test("una transmisión cortada sin on_stream_stop se entrega igual", async () => {
  const { client, sockets, streams } = setup({ streamIdleMs: 40 });
  client.start();
  const s = sockets[0];
  await logIn(s);
  s.json({ command: "on_stream_start", stream_id: 4, channel: "demo", from: "B-5" });
  s.binary([1, 0, 0, 0, 4, 0, 0, 0, 1, 0x11]);
  await tick(120);
  assert.equal(streams.length, 1);
  assert.equal(streams[0].from, "B-5");
  client.stop();
});

test("si se corta, reconecta solo y usa el refresh_token", async () => {
  const { client, sockets, states } = setup();
  client.start();
  await logIn(sockets[0]);
  sockets[0].close();
  assert.equal(states.at(-1)?.online, false);
  await tick(30);
  assert.equal(sockets.length, 2);
  sockets[1].open();
  const logon = sockets[1].last("logon");
  assert.equal(logon.refresh_token, "refresh-1");
  assert.equal(logon.auth_token, undefined);
  client.stop();
});

test("logon rechazado: muestra el motivo y reintenta", async () => {
  const { client, sockets, states } = setup();
  client.start();
  sockets[0].open();
  sockets[0].json({ seq: sockets[0].last("logon").seq, error: "not authorized" });
  await tick();
  assert.match(states.at(-1)?.error ?? "", /rechazó/);
  assert.equal(sockets[0].closed, true);
  await tick(40);
  assert.equal(sockets.length, 2);
  client.stop();
});

test("expulsado una y otra vez (otro puente con la misma cuenta): deja de reconectar y lo explica", async () => {
  const { client, sockets, states } = setup({ baseBackoffMs: 1, maxBackoffMs: 5, maxKicks: 3, kickWindowMs: 60_000 });
  client.start();
  for (let i = 0; i < 3; i++) {
    await logIn(sockets[i]);
    sockets[i].json({ command: "on_error", error: "kicked" });
    await tick(20);
  }
  assert.equal(sockets.length, 3, "después de la tercera expulsión no abre otra conexión");
  await tick(30);
  assert.equal(sockets.length, 3);
  assert.equal(states.at(-1)?.online, false);
  assert.match(states.at(-1)?.error ?? "", /3 veces en 1 min.*dejó de reconectar/);
  client.stop();
});

test("sendVoice: start_stream con codec_header, paquetes con el stream_id y stop_stream", async () => {
  const { client, sockets } = setup();
  client.start();
  const s = sockets[0];
  await logIn(s);
  const sending = client.sendVoice([new Uint8Array([1, 2]), new Uint8Array([3])], { codecHeader: "gD4BPA==", packetDurationMs: 2 });
  await tick();
  const start = s.last("start_stream");
  assert.equal(start.channel, "demo");
  assert.equal(start.codec, "opus");
  assert.equal(start.codec_header, "gD4BPA==");
  assert.equal(start.packet_duration, 2);
  assert.equal("for" in start, false);
  s.json({ seq: start.seq, success: true, stream_id: 77 });
  await tick(20);
  const stop = s.last("stop_stream");
  assert.equal(stop.stream_id, 77);
  s.json({ seq: stop.seq, success: true });
  await sending;
  const bins = s.sent.filter((d): d is Uint8Array => typeof d !== "string").map((b) => parseZelloPacket(b));
  assert.deepEqual(bins.map((p) => [p?.streamId, [...(p?.data ?? [])]]), [
    [77, [1, 2]],
    [77, [3]],
  ]);
  client.stop();
});

test("sendVoice falla si el canal no está en línea", async () => {
  const { client } = setup();
  await assert.rejects(client.sendVoice([new Uint8Array([1])], { codecHeader: "gD4BPA==", packetDurationMs: 60 }), /no está en línea/);
});

test("expulsado por otra sesión de la cuenta: lo explica y espera el máximo antes de reintentar", async () => {
  const { client, sockets, states } = setup({ baseBackoffMs: 1, maxBackoffMs: 80 });
  client.start();
  await logIn(sockets[0]);
  sockets[0].json({ command: "on_error", error: "kicked" });
  assert.equal(sockets[0].closed, true);
  assert.match(states.at(-1)?.error ?? "", /otra sesión/);
  await tick(30);
  assert.equal(sockets.length, 1); // todavía no reintenta
  await tick(80);
  assert.equal(sockets.length, 2);
  client.stop();
});
