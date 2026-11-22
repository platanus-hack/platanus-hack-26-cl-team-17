import assert from "node:assert/strict";
import { test } from "node:test";
import type { CommEntry } from "@/lib/domain";
import { UNTRANSCRIBED_COMM_TEXT } from "@/lib/labels";
import { sanitizeForObac, speechAllowed } from "@/lib/vigia/rules";
import { BLOCKED_ANSWER_TEXT, ZelloBridge, type RadioPort, type SpeechRules } from "./bridge";
import type { IncomingStream, ZelloChannelState } from "./client";
import { isObacCommWith, isVigiaVoiceComm } from "./channels";
import type { NewZelloComm, SalidaItem, VigiaApi } from "./vigia-api";

const RULES: SpeechRules = { sanitize: sanitizeForObac, allowed: speechAllowed };

/** Paquete Opus de 60 ms (TOC config 3, code 0). */
const PKT = () => new Uint8Array([3 << 3, 1, 2, 3]);

function stream(from: string, n: number, id = 1): IncomingStream {
  return {
    streamId: id,
    channel: "demo-platanus",
    from,
    codec: { sampleRate: 16000, framesPerPacket: 1, frameSizeMs: 60 },
    packetDurationMs: 60,
    startedAt: new Date("2026-11-21T18:00:00.000Z"),
    packets: Array.from({ length: n }, PKT),
  };
}

class FakeVigia implements VigiaApi {
  incidents = [
    { id: "inc-2", code: "VG-BBBB" },
    { id: "inc-1", code: "VG-AAAA" },
  ];
  comms: { incident: string; comm: NewZelloComm }[] = [];
  uploads: string[] = [];
  asked: { incident: string; question: string }[] = [];
  salidaItems: SalidaItem[] | "missing" = "missing";
  async openIncidents() {
    return this.incidents;
  }
  async uploadAudio(incidentId: string, ogg: Uint8Array) {
    assert.equal(new TextDecoder().decode(ogg.subarray(0, 4)), "OggS");
    this.uploads.push(incidentId);
    return `incidents/${incidentId}/comms/a.ogg`;
  }
  async addComm(incidentId: string, comm: NewZelloComm) {
    this.comms.push({ incident: incidentId, comm });
    return { id: "c", seq: this.comms.length } as unknown as CommEntry;
  }
  async salida(_incidentId: string, after: number | null) {
    if (this.salidaItems === "missing") return "missing" as const;
    const items = this.salidaItems.filter((i) => after === null || i.seq > after);
    return { items, last_seq: Math.max(after ?? -1, ...this.salidaItems.map((i) => i.seq)) };
  }
  async ask(incident: string, question: string) {
    this.asked.push({ incident, question });
    return { answer: "No hay nadie en el lado B; lo cubren 2 de 7 videos." };
  }
  async postStatus() {}
}

class FakeRadio implements RadioPort {
  state: ZelloChannelState = { online: true, usersOnline: 3, error: null };
  receiving = false;
  sent: number[] = [];
  async sendVoice(packets: Uint8Array[]) {
    this.sent.push(packets.length);
  }
}

function setup(opts: { voice?: boolean; obac?: string; pinned?: string | null } = {}) {
  let now = Date.parse("2026-11-21T18:00:10.000Z");
  const vigia = new FakeVigia();
  const radio = new FakeRadio();
  const spoken: string[] = [];
  const logs: string[] = [];
  const bridge = new ZelloBridge({
    channel: "demo-platanus",
    obacUsername: opts.obac ?? "agustin_obac",
    pinnedIncident: opts.pinned ?? null,
    vigia,
    radio,
    rules: RULES,
    transcribe: async () => "B-3 en 6-3, fuego en segundo piso",
    voice:
      opts.voice === false
        ? null
        : async (text) => {
            spoken.push(text);
            return { packets: [PKT(), PKT()], codecHeader: "gD4BPA==", packetDurationMs: 60 };
          },
    log: (m) => logs.push(m),
    now: () => now,
    transcriptionWaitMs: { unseen: 5, seen: 50 },
    floorWaitMs: 0,
  });
  return { bridge, vigia, radio, spoken, logs, advance: (ms: number) => (now += ms) };
}

test("una transmisión entra solo a la bitácora de la emergencia abierta más nueva, con su grabación", async () => {
  const { bridge, vigia } = setup();
  await bridge.onStream(stream("B-3", 20));
  assert.deepEqual(vigia.uploads, ["inc-2"]);
  assert.deepEqual(
    vigia.comms.map((c) => c.incident),
    ["inc-2"],
  );
  const c = vigia.comms[0].comm;
  assert.equal(c.speaker, "B-3");
  assert.equal(c.channel, "demo-platanus");
  assert.equal(c.text, "B-3 en 6-3, fuego en segundo piso");
  assert.equal(c.at, "2026-11-21T18:00:00.000Z");
  assert.equal(c.audio_path, "incidents/inc-2/comms/a.ogg");
  assert.equal(bridge.status(false).last_transmission?.from, "B-3");
});

test("con --incident solo va a esa emergencia (por id o por código)", async () => {
  const { bridge, vigia } = setup({ pinned: "vg-aaaa" });
  await bridge.onStream(stream("B-3", 20));
  assert.deepEqual(
    vigia.comms.map((c) => c.incident),
    ["inc-1"],
  );
});

test("usa on_transcription de Zello si llega, y si no, la transcripción propia", async () => {
  const { bridge, vigia } = setup();
  const job = bridge.onStream(stream("B-5", 20, 42));
  bridge.onTranscription({ streamId: 42, text: "B-5 llegando", sender: "B-5", confidence: 0.9, truncated: false });
  await job;
  assert.equal(vigia.comms[0].comm.text, "B-5 llegando");
});

test("toques cortos del PTT no se registran; sin texto queda «sin transcribir» con la grabación", async () => {
  const { bridge, vigia } = setup();
  await bridge.onStream(stream("B-3", 3)); // 0,18 s
  assert.equal(vigia.comms.length, 0);

  const b = setup();
  (b.bridge as unknown as { d: { transcribe: () => Promise<null> } }).d.transcribe = async () => null;
  await b.bridge.onStream(stream("B-3", 20));
  assert.equal(b.vigia.comms[0].comm.text, UNTRANSCRIBED_COMM_TEXT);
  assert.ok(b.vigia.comms[0].comm.audio_path);
});

test("pregunta del OBAC sin salida del agente: responde con /ask y lo dice en el canal", async () => {
  const { bridge, vigia, radio, spoken } = setup();
  (bridge as unknown as { d: { transcribe: () => Promise<string> } }).d.transcribe = async () => "Vigía, ¿se ve alguien en el lado B?";
  await bridge.onStream(stream("agustin_obac", 20));
  await bridge.idle();
  assert.deepEqual(vigia.asked, [{ incident: "inc-2", question: "Vigía, ¿se ve alguien en el lado B?" }]);
  assert.equal(await bridge.speakNext(), true);
  // El filtro de «no hay nadie» corrige la respuesta antes de hablar.
  assert.equal(spoken[0], "No veo a nadie en el lado B; lo cubren 2 de 7 videos.");
  assert.deepEqual(radio.sent, [2]);
  // Lo que dijo Vigía queda en la bitácora de esa emergencia, con su grabación.
  await new Promise((r) => setTimeout(r, 0));
  const said = vigia.comms.at(-1);
  assert.equal(said?.incident, "inc-2");
  assert.equal(said?.comm.speaker, "Vigía");
  assert.equal(said?.comm.text, spoken[0]);
  assert.ok(said?.comm.audio_path);
});

test("con la salida del agente: dice solo speak = true y no vuelve a usar /ask", async () => {
  const { bridge, vigia, spoken, advance } = setup();
  vigia.salidaItems = [
    { seq: 1, at: "2026-11-21T17:50:00.000Z", text: "Mensaje viejo.", priority: "resto", speak: true },
    { seq: 2, at: "2026-11-21T18:00:05.000Z", text: "Resumen: B-3 en 6-3.", priority: "resto", speak: true },
    { seq: 3, at: "2026-11-21T18:00:06.000Z", text: "Solo pantalla.", priority: "resto", speak: false },
  ];
  await bridge.pollSalida();
  assert.equal(await bridge.speakNext(), true);
  assert.equal(await bridge.speakNext(), false); // no hay más: el viejo y el de pantalla no se dicen
  assert.deepEqual(spoken, ["Resumen: B-3 en 6-3."]);

  (bridge as unknown as { d: { transcribe: () => Promise<string> } }).d.transcribe = async () => "Vigía, ¿qué tenemos?";
  advance(1000);
  await bridge.onStream(stream("agustin_obac", 20));
  await bridge.idle();
  assert.equal(vigia.asked.length, 0);
});

test("reglas duras: 20 s entre mensajes salvo persona, y no se transmiten órdenes", async () => {
  const { bridge, spoken, advance, logs } = setup();
  bridge.enqueue({ text: "Resumen: B-5 llegando.", priority: "resto", origin: "t" });
  bridge.enqueue({ text: "Resumen: B-3 pide 2-2.", priority: "resto", origin: "t" });
  assert.equal(await bridge.speakNext(), true);
  advance(5_000);
  assert.equal(await bridge.speakNext(), false); // espera los 20 s
  bridge.enqueue({ text: "OBAC, Vigía: posible persona en ventana del tercer piso, lado B.", priority: "persona", origin: "t" });
  assert.equal(await bridge.speakNext(), true); // persona pasa antes
  advance(20_000);
  assert.equal(await bridge.speakNext(), true);
  assert.equal(spoken.length, 3);
  assert.match(spoken[1], /persona/);

  advance(20_000);
  bridge.enqueue({ text: "B-3, entren por el lado C.", priority: "riesgo", origin: "t" });
  assert.equal(await bridge.speakNext(), false);
  assert.equal(spoken.length, 3);
  assert.ok(logs.some((l) => l.startsWith("bloqueado por las reglas")));
});

test("no habla encima de alguien que transmite, y el mensaje caduca si no alcanza", async () => {
  const { bridge, radio, spoken, advance } = setup();
  radio.receiving = true;
  bridge.enqueue({ text: "Resumen: sin novedades.", priority: "resto", origin: "t" });
  assert.equal(await bridge.speakNext(), false);
  radio.receiving = false;
  advance(60_000);
  assert.equal(await bridge.speakNext(), false);
  assert.equal(spoken.length, 0);
});

test("solo escucha: no sintetiza ni transmite, y el estado lo dice", async () => {
  const { bridge, radio } = setup({ voice: false });
  bridge.enqueue({ text: "Resumen: B-5 llegando.", priority: "resto", origin: "t" });
  assert.equal(await bridge.speakNext(), false);
  assert.deepEqual(radio.sent, []);
  const st = bridge.status(false);
  assert.equal(st.listen_only, true);
  assert.equal(st.connected, true);
  assert.equal(st.users_online, 3);
});

test("isObacCommWith: el usuario del OBAC o el vocativo «Vigía, …», solo en entradas de Zello", () => {
  const z = (speaker: string, text: string) => ({ source: "zello" as const, speaker, text });
  assert.equal(isObacCommWith(z("Agustin_OBAC", "¿qué tenemos?"), "agustin_obac"), true);
  assert.equal(isObacCommWith(z("B-3", "Vigía, ¿hay agua cerca?"), "agustin_obac"), true);
  assert.equal(isObacCommWith(z("B-3", "vigia: repite"), ""), true);
  assert.equal(isObacCommWith(z("B-3", "en 6-3 con 8 voluntarios"), "agustin_obac"), false);
  assert.equal(isObacCommWith({ source: "manual", speaker: "agustin_obac", text: "Vigía, hola" }, "agustin_obac"), false);
  // Vocativos con puntuación, saludo y lo que oyó la transcripción en la prueba real.
  for (const t of ["¿Vigía, se ve alguien?", "Oye, Vigía, ¿qué tenemos?", "Hola, Vigía.", "Vigilia, repite", "Wikipedia, ¿hay agua?"]) {
    assert.equal(isObacCommWith(z("B-3", t), ""), true, t);
  }
  // Lo que dijo Vigía nunca es una pregunta para Vigía.
  assert.equal(isObacCommWith(z("Vigía", "Vigía, en el puesto de mando."), "agustin_obac"), false);
  assert.equal(isVigiaVoiceComm({ source: "zello", speaker: "Vigia" }), true);
  assert.equal(isVigiaVoiceComm({ source: "manual", speaker: "Vigía" }), false);
});

test("respuesta bloqueada: dice las oraciones permitidas o la frase fija, nunca silencio", async () => {
  const { bridge, spoken, advance } = setup();
  bridge.enqueue({ text: "B-3 está en 6-3. Entren por el lado C.", priority: "resto", origin: "t", answer: true });
  assert.equal(await bridge.speakNext(), true);
  assert.equal(spoken[0], "B-3 está en 6-3.");
  advance(20_000);
  bridge.enqueue({ text: "Entren por el lado C.", priority: "resto", origin: "t", answer: true });
  assert.equal(await bridge.speakNext(), true);
  assert.equal(spoken[1], BLOCKED_ANSWER_TEXT);
  advance(20_000);
  bridge.enqueue({ text: "Entren por el lado C.", priority: "resto", origin: "t" }); // aviso propio, no respuesta
  assert.equal(await bridge.speakNext(), false);
  assert.equal(spoken.length, 2);
});

test("una respuesta lenta de /ask no atrasa el registro de la transmisión siguiente", async () => {
  const { bridge, vigia } = setup();
  let release: () => void = () => undefined;
  vigia.ask = (incident: string, question: string) =>
    new Promise((resolve) => {
      vigia.asked.push({ incident, question });
      release = () => resolve({ answer: "Sin novedades." });
    });
  (bridge as unknown as { d: { transcribe: (o: Uint8Array) => Promise<string> } }).d.transcribe = async () => "Vigía, ¿qué tenemos?";
  await bridge.onStream(stream("agustin_obac", 20, 1));
  (bridge as unknown as { d: { transcribe: (o: Uint8Array) => Promise<string> } }).d.transcribe = async () => "B-5 llegando";
  await bridge.onStream(stream("B-5", 20, 2));
  assert.deepEqual(
    vigia.comms.map((c) => c.comm.text),
    ["Vigía, ¿qué tenemos?", "B-5 llegando"],
  );
  release();
  await bridge.idle();
});

test("avisa cuando hay varias emergencias abiertas y no hay --incident; el latido de cierre dice detenido", async () => {
  const { bridge, logs } = setup();
  await bridge.openIncidents();
  assert.ok(logs.some((l) => /hay 2 emergencias abiertas.*solo en la más nueva \(VG-BBBB\).*--incident/.test(l)));
  const st = bridge.status(false, true);
  assert.equal(st.stopped, true);
  assert.equal(st.connected, false);
});

test("una respuesta al OBAC sale sin esperar los 20 s y pasa delante de un resumen en espera", async () => {
  const { bridge, spoken, advance } = setup();
  bridge.enqueue({ text: "Resumen: B-5 llegando.", priority: "resto", origin: "t" });
  assert.equal(await bridge.speakNext(), true);
  advance(3_000);
  bridge.enqueue({ text: "Resumen: B-3 pide 2-2.", priority: "resto", origin: "t" });
  bridge.enqueue({ text: "OBAC, Vigía: B-3 está en 6-3.", priority: "resto", origin: "t", kind: "respuesta" });
  assert.equal(await bridge.speakNext(), true);
  assert.equal(spoken[1], "OBAC, Vigía: B-3 está en 6-3.");
  assert.equal(await bridge.speakNext(), false); // el resumen sí espera sus 20 s
  advance(20_000);
  assert.equal(await bridge.speakNext(), true);
  assert.equal(spoken[2], "Resumen: B-3 pide 2-2.");
});

test("la salida del agente con kind respuesta no queda retenida por el límite", async () => {
  const { bridge, vigia, spoken, advance } = setup();
  bridge.enqueue({ text: "Resumen previo.", priority: "resto", origin: "t" });
  assert.equal(await bridge.speakNext(), true);
  advance(2_000);
  vigia.salidaItems = [{ seq: 4, at: "2026-11-21T18:00:11.000Z", text: "OBAC, Vigía: no veo el lado C.", priority: "resto", speak: true, kind: "respuesta" }];
  await bridge.pollSalida();
  assert.equal(await bridge.speakNext(), true);
  assert.equal(spoken[1], "OBAC, Vigía: no veo el lado C.");
});

test("reconoce como pregunta del OBAC lo que la transcripción deformó en la prueba real", () => {
  const z = (text: string) => ({ source: "zello" as const, speaker: "Agustin_Arevalo", text });
  assert.equal(isObacCommWith(z("Eh, atento, Viking. Necesito conocer la situación del incendio."), ""), true);
  assert.equal(isObacCommWith(z("Si hay alguien que me está hablando, por favor, que se ubique. Ese vigila"), ""), true);
  assert.equal(isObacCommWith(z("Lucas por favor pide el cambio"), ""), false);
});

test("respuesta bloqueada: lo permitido sale entero aunque traiga «¿», «;» o saltos de línea", async () => {
  const { bridge, spoken, advance } = setup();
  const say = async (text: string) => {
    bridge.enqueue({ text, priority: "resto", origin: "t", answer: true });
    assert.equal(await bridge.speakNext(), true);
    advance(20_000);
    return spoken.at(-1);
  };
  assert.equal(await say("Lado B sin cobertura, ¿lo confirman? Entren por el lado C."), "Lado B sin cobertura, ¿lo confirman?");
  assert.equal(await say("Atención: no ingresen; el edificio está vacío."), "El edificio: no veo personas.");
  assert.equal(await say("No hay nadie en el lado B\nB-3, avance al segundo piso"), "No veo a nadie en el lado B");
  assert.equal(await say("Confirmo que no hay nadie. Entren."), "Confirmo que no veo a nadie.");
});

test("el latido informa la cola de voz del puente", async () => {
  const { bridge } = setup();
  bridge.enqueue({ text: "Resumen: B-5 llegando.", priority: "resto", origin: "t", incidentId: "inc-1" });
  const q = bridge.status(false).queue ?? [];
  assert.equal(q.length, 1);
  assert.equal(q[0].text, "Resumen: B-5 llegando.");
  assert.equal(q[0].incident_id, "inc-1");
  assert.equal(await bridge.speakNext(), true);
  assert.deepEqual(bridge.status(false).queue, []);
});
