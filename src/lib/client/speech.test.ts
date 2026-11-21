import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  collectResults,
  createDictation,
  describeDictationError,
  DICTATION_UNSUPPORTED_MESSAGE,
  EMPTY_CURSOR,
  isDictationSupported,
  isSpeaking,
  isSpeechSynthesisSupported,
  pickVoice,
  planRestart,
  speak,
  speechChunkLength,
  splitForSpeech,
  stopSpeaking,
  type Dictation,
  type DictationError,
  type RecognitionResultListLike,
} from "@/lib/client/speech";

/* ---------------------------- splitForSpeech ---------------------------- */

describe("splitForSpeech", () => {
  test("texto vacío o solo espacios → sin trozos", () => {
    assert.deepEqual(splitForSpeech(""), []);
    assert.deepEqual(splitForSpeech("   \n\n  "), []);
  });

  test("texto corto queda en un solo trozo, con espacios normalizados", () => {
    assert.deepEqual(splitForSpeech("  Incendio   en casa.  Dos pisos. "), ["Incendio en casa. Dos pisos."]);
  });

  test("corta por oraciones y junta las cortas hasta el máximo", () => {
    const out = splitForSpeech("Uno dos tres. Cuatro cinco seis. Siete ocho nueve.", 35);
    assert.deepEqual(out, ["Uno dos tres. Cuatro cinco seis.", "Siete ocho nueve."]);
  });

  test("no corta en decimales ni abreviaturas pegadas", () => {
    const out = splitForSpeech("Hay 3.5 metros de altura. Fin.", 26);
    assert.deepEqual(out, ["Hay 3.5 metros de altura.", "Fin."]);
  });

  test("respeta signos de exclamación, interrogación y comillas de cierre", () => {
    const out = splitForSpeech('¿Hay gente adentro? ¡Sí!" Confirmado.', 20);
    assert.deepEqual(out, ["¿Hay gente adentro?", '¡Sí!" Confirmado.']);
  });

  test("oración larga se parte en una coma antes que en un espacio cualquiera", () => {
    const s = "Personas atrapadas en el segundo piso del edificio, acceso por calle lateral sin cables";
    const out = splitForSpeech(s, 60);
    assert.equal(out[0], "Personas atrapadas en el segundo piso del edificio,");
    assert.equal(out.join(" "), s);
  });

  test("palabra más larga que el máximo se corta a la fuerza", () => {
    const out = splitForSpeech("a".repeat(25), 10);
    assert.deepEqual(out, ["a".repeat(10), "a".repeat(10), "a".repeat(5)]);
  });

  test("los saltos de línea son fin de oración", () => {
    assert.deepEqual(splitForSpeech("Incendio en casa\nDos atrapados\nSin gas", 18), [
      "Incendio en casa.",
      "Dos atrapados.",
      "Sin gas",
    ]);
  });

  test("ningún trozo supera el máximo y no se pierden palabras (texto largo)", () => {
    const words = [
      "Incendio",
      "estructural",
      "en",
      "vivienda",
      "de",
      "dos",
      "pisos,",
      "con",
      "humo",
      "negro.",
      "Posible",
      "persona",
      "atrapada",
      "en",
      "el",
      "segundo",
      "piso;",
      "cilindros",
      "de",
      "gas",
      "en",
      "el",
      "patio!",
    ];
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let round = 0; round < 50; round++) {
      const n = 20 + Math.floor(rand() * 200);
      const text = Array.from({ length: n }, () => words[Math.floor(rand() * words.length)]).join(" ");
      for (const max of [40, 80, 180]) {
        const out = splitForSpeech(text, max);
        for (const c of out) assert.ok(c.length <= max, `trozo de ${c.length} > ${max}`);
        assert.equal(out.join(" ").replace(/\s+/g, ""), text.replace(/\s+/g, ""));
      }
    }
  });

  test("máximo por defecto 180", () => {
    const text = Array.from({ length: 30 }, (_, i) => `Oración número ${i} del briefing.`).join(" ");
    const out = splitForSpeech(text);
    assert.ok(out.length > 1);
    for (const c of out) assert.ok(c.length <= 180);
  });
});

/* ------------------------------ pickVoice ------------------------------- */

describe("pickVoice", () => {
  const v = (lang: string, name: string, localService = true) => ({ lang, name, localService });

  test("prefiere es-CL sobre todo lo demás", () => {
    const voices = [v("es-ES", "Mónica"), v("es-US", "Google US"), v("es-CL", "Chile"), v("es-419", "LatAm")];
    assert.equal(pickVoice(voices)?.name, "Chile");
  });

  test("orden es-419 > es-US > es-MX > otro latinoamericano > es-ES", () => {
    const all = [v("es-ES", "España"), v("es-AR", "Argentina"), v("es-MX", "México"), v("es-US", "EEUU"), v("es-419", "LatAm")];
    const order: string[] = [];
    let pool = [...all];
    while (pool.length) {
      const best = pickVoice(pool);
      assert.ok(best);
      order.push(best.name);
      pool = pool.filter((x) => x !== best);
    }
    assert.deepEqual(order, ["LatAm", "EEUU", "México", "Argentina", "España"]);
  });

  test("acepta guion bajo y mayúsculas (Android: es_CL)", () => {
    assert.equal(pickVoice([v("es-US", "EEUU"), v("ES_cl", "Chile")])?.name, "Chile");
  });

  test("dentro del mismo nivel prefiere la voz local", () => {
    const voices = [v("es-US", "Google red", false), v("es-US", "Local", true)];
    assert.equal(pickVoice(voices)?.name, "Local");
  });

  test("una voz en red de mejor nivel gana a una local de peor nivel", () => {
    const voices = [v("es-MX", "Local MX", true), v("es-US", "Red US", false)];
    assert.equal(pickVoice(voices)?.name, "Red US");
  });

  test("sin voces en español → null", () => {
    assert.equal(pickVoice([v("en-US", "Samantha"), v("pt-BR", "Luciana"), v("", "Vacía")]), null);
    assert.equal(pickVoice([]), null);
  });

  test("'es' a secas sirve como último recurso", () => {
    assert.equal(pickVoice([v("en-US", "Samantha"), v("es", "Genérica")])?.name, "Genérica");
  });
});

/* ----------------------- dictado: lógica pura --------------------------- */

function resultList(items: Array<[string, boolean]>): RecognitionResultListLike {
  const list: { [i: number]: { isFinal: boolean; length: number; 0: { transcript: string } }; length: number } = {
    length: items.length,
  };
  items.forEach(([transcript, isFinal], i) => {
    list[i] = { isFinal, length: 1, 0: { transcript } };
  });
  return list;
}

describe("collectResults", () => {
  test("separa finales e interinos", () => {
    const out = collectResults(resultList([[" hola ", true], [" cómo", false], [" estás", false]]), 0, EMPTY_CURSOR);
    assert.deepEqual(out.finals, ["hola"]);
    assert.equal(out.interim, "cómo estás");
    assert.equal(out.cursor.emitted, 1);
  });

  test("no repite finales ya entregados aunque resultIndex retroceda", () => {
    const first = collectResults(resultList([["uno", true]]), 0, EMPTY_CURSOR);
    const second = collectResults(resultList([["uno", true], ["dos", true]]), 0, first.cursor);
    assert.deepEqual(second.finals, ["dos"]);
  });

  test("modo acumulativo (Android) entrega solo lo nuevo", () => {
    let cursor = EMPTY_CURSOR;
    const got: string[] = [];
    const steps: Array<Array<[string, boolean]>> = [
      [["hay fuego", true]],
      [["hay fuego", true], ["hay fuego en el segundo piso", true]],
      [["hay fuego", true], ["hay fuego en el segundo piso", true], ["hay fuego en el segundo piso", true]],
    ];
    steps.forEach((items, idx) => {
      const out = collectResults(resultList(items), idx, cursor, true);
      cursor = out.cursor;
      got.push(...out.finals);
    });
    assert.deepEqual(got, ["hay fuego", "en el segundo piso"]);
  });

  test("modo acumulativo (Android): lo provisional no repite lo ya entregado", () => {
    const first = collectResults(resultList([["hay fuego", true]]), 0, EMPTY_CURSOR, true);
    const second = collectResults(
      resultList([["hay fuego", true], ["hay fuego en el", false]]),
      1,
      first.cursor,
      true,
    );
    assert.deepEqual(second.finals, []);
    assert.equal(second.interim, "en el");
    const same = collectResults(resultList([["hay fuego", true], ["Hay fuego", false]]), 1, first.cursor, true);
    assert.equal(same.interim, "");
  });

  test("sin modo acumulativo, frases repetidas se entregan tal cual", () => {
    const out = collectResults(resultList([["sí", true], ["sí", true]]), 0, EMPTY_CURSOR, false);
    assert.deepEqual(out.finals, ["sí", "sí"]);
  });

  test("resultados vacíos no generan finales", () => {
    const out = collectResults(resultList([["  ", true]]), 0, EMPTY_CURSOR);
    assert.deepEqual(out.finals, []);
    assert.equal(out.cursor.emitted, 1);
  });
});

describe("planRestart", () => {
  test("sesión sana reinicia con la espera base y reinicia el contador", () => {
    assert.deepEqual(planRestart(3, 5000, false), { shortSessions: 0, delayMs: 250 });
    assert.deepEqual(planRestart(3, 100, true), { shortSessions: 0, delayMs: 250 });
  });

  test("sesiones cortas seguidas alargan la espera y al final se rinde", () => {
    let short = 0;
    const delays: number[] = [];
    for (;;) {
      const plan = planRestart(short, 50, false);
      if (!plan) break;
      short = plan.shortSessions;
      delays.push(plan.delayMs);
    }
    assert.deepEqual(delays, [500, 750, 1000, 1250]);
  });
});

describe("describeDictationError", () => {
  test("no-speech y aborted se ignoran", () => {
    assert.equal(describeDictationError("no-speech"), null);
    assert.equal(describeDictationError("aborted"), null);
  });

  test("not-allowed al primer toque explica el bloqueo del micrófono", () => {
    const err = describeDictationError("not-allowed");
    assert.equal(err?.code, "not-allowed");
    assert.match(err?.message ?? "", /^Bloqueaste el micrófono/);
  });

  test("not-allowed en un reinicio no culpa al usuario", () => {
    const err = describeDictationError("not-allowed", true);
    assert.equal(err?.code, "not-allowed");
    assert.doesNotMatch(err?.message ?? "", /Bloqueaste/);
  });

  test("service-not-allowed, network y desconocidos se informan", () => {
    assert.match(describeDictationError("service-not-allowed")?.message ?? "", /^Bloqueaste/);
    assert.equal(describeDictationError("network")?.code, "network");
    assert.equal(describeDictationError("algo-raro")?.code, "unknown");
  });
});

/* ------------------- dictado: controlador con un falso ------------------ */

type Handler<T> = ((ev: T) => void) | null;

class FakeRecognition {
  static instances: FakeRecognition[] = [];
  lang = "";
  continuous = false;
  interimResults = false;
  maxAlternatives = 1;
  onresult: Handler<{ resultIndex: number; results: RecognitionResultListLike }> = null;
  onerror: Handler<{ error: string }> = null;
  onend: (() => void) | null = null;
  started = false;
  stopped = false;
  aborted = false;
  constructor() {
    FakeRecognition.instances.push(this);
  }
  start() {
    this.started = true;
  }
  stop() {
    this.stopped = true;
  }
  abort() {
    this.aborted = true;
  }
  emit(items: Array<[string, boolean]>, resultIndex = 0) {
    this.onresult?.({ resultIndex, results: resultList(items) });
  }
  fail(code: string) {
    this.onerror?.({ error: code });
  }
  end() {
    this.onend?.();
  }
}

const g = globalThis as unknown as Record<string, unknown>;

function installRecognition() {
  FakeRecognition.instances = [];
  g.webkitSpeechRecognition = FakeRecognition;
}

function recorder() {
  const log: string[] = [];
  const errors: DictationError[] = [];
  return {
    log,
    errors,
    opts: {
      onFinal: (t: string) => log.push(`final:${t}`),
      onInterim: (t: string) => log.push(`interim:${t}`),
      onError: (e: DictationError) => {
        errors.push(e);
        log.push(`error:${e.code}`);
      },
      onEnd: () => log.push("end"),
    },
  };
}

describe("createDictation", () => {
  afterEach(() => {
    delete g.webkitSpeechRecognition;
    delete g.SpeechRecognition;
  });

  test("sin soporte: se puede crear, start() devuelve false con mensaje en español y sin onEnd", () => {
    assert.equal(isDictationSupported(), false);
    const r = recorder();
    const d = createDictation(r.opts);
    assert.equal(d.start(), false);
    assert.equal(d.active, false);
    assert.deepEqual(r.errors, [{ code: "unsupported", message: DICTATION_UNSUPPORTED_MESSAGE }]);
    assert.deepEqual(r.log, ["error:unsupported"]);
  });

  test("configura continuo, interinos y es-CL; entrega finales e interinos", () => {
    installRecognition();
    assert.equal(isDictationSupported(), true);
    const r = recorder();
    const d = createDictation(r.opts);
    assert.equal(d.start(), true);
    assert.equal(d.active, true);
    assert.equal(d.isActive(), true);
    const rec = FakeRecognition.instances[0];
    assert.equal(rec.lang, "es-CL");
    assert.equal(rec.continuous, true);
    assert.equal(rec.interimResults, true);
    assert.equal(rec.started, true);
    rec.emit([["hay humo", false]]);
    rec.emit([["hay humo negro", true]]);
    assert.deepEqual(r.log, ["interim:hay humo", "interim:", "final:hay humo negro"]);
  });

  test("reinicia solo en 'end' mientras siga activo; stop() espera el final y llama onEnd una vez", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    installRecognition();
    const r = recorder();
    const d = createDictation(r.opts);
    d.start();
    t.mock.timers.tick(5000);
    FakeRecognition.instances[0].fail("no-speech");
    FakeRecognition.instances[0].end();
    assert.equal(FakeRecognition.instances.length, 1);
    t.mock.timers.tick(250);
    assert.equal(FakeRecognition.instances.length, 2);
    assert.equal(FakeRecognition.instances[1].started, true);
    assert.equal(d.active, true);

    d.stop();
    assert.equal(d.active, false);
    assert.equal(FakeRecognition.instances[1].stopped, true);
    FakeRecognition.instances[1].emit([["última frase", true]]);
    FakeRecognition.instances[1].end();
    assert.deepEqual(r.log, ["final:última frase", "end"]);
    t.mock.timers.tick(5000);
    assert.equal(FakeRecognition.instances.length, 2);
    assert.deepEqual(r.log, ["final:última frase", "end"]);
  });

  test("not-allowed detiene, informa en español y no reinicia", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    installRecognition();
    const r = recorder();
    const d = createDictation(r.opts);
    d.start();
    FakeRecognition.instances[0].fail("not-allowed");
    FakeRecognition.instances[0].end();
    t.mock.timers.tick(10000);
    assert.equal(d.active, false);
    assert.equal(FakeRecognition.instances.length, 1);
    assert.deepEqual(r.log, ["error:not-allowed", "end"]);
    assert.match(r.errors[0].message, /^Bloqueaste el micrófono/);
  });

  test("network se informa y detiene", () => {
    installRecognition();
    const r = recorder();
    const d = createDictation(r.opts);
    d.start();
    FakeRecognition.instances[0].fail("network");
    assert.equal(d.active, false);
    assert.deepEqual(r.log, ["error:network", "end"]);
  });

  test("sesiones que terminan al tiro: se rinde tras el tope en vez de quedar en bucle", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    installRecognition();
    const r = recorder();
    const d = createDictation(r.opts);
    d.start();
    for (let i = 0; i < 20 && d.active; i++) {
      const rec = FakeRecognition.instances[FakeRecognition.instances.length - 1];
      rec.end();
      t.mock.timers.tick(2000);
    }
    assert.equal(d.active, false);
    assert.equal(FakeRecognition.instances.length, 5);
    assert.deepEqual(r.log, ["error:too-many-restarts", "end"]);
  });

  test("Safari: lo provisional pendiente al terminar se entrega como final", () => {
    installRecognition();
    const r = recorder();
    const d = createDictation(r.opts);
    d.start();
    FakeRecognition.instances[0].emit([["cables caídos", false]]);
    d.stop();
    FakeRecognition.instances[0].end();
    assert.deepEqual(r.log, ["interim:cables caídos", "interim:", "final:cables caídos", "end"]);
  });

  test("abort() corta de inmediato, sin entregar lo provisional", () => {
    installRecognition();
    const r = recorder();
    const d = createDictation(r.opts);
    d.start();
    FakeRecognition.instances[0].emit([["algo", false]]);
    d.abort();
    assert.equal(FakeRecognition.instances[0].aborted, true);
    FakeRecognition.instances[0].emit([["algo más", true]]);
    FakeRecognition.instances[0].end();
    assert.deepEqual(r.log, ["interim:algo", "interim:", "end"]);
  });

  test("si el navegador no manda 'end' tras stop(), onEnd llega igual", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    installRecognition();
    const r = recorder();
    const d = createDictation(r.opts);
    d.start();
    d.stop();
    assert.deepEqual(r.log, []);
    t.mock.timers.tick(2000);
    assert.deepEqual(r.log, ["end"]);
    assert.equal(FakeRecognition.instances[0].aborted, true);
  });

  test("onError que vuelve a llamar a start() parte limpio y sin onEnd de la sesión anterior", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    installRecognition();
    const log: string[] = [];
    let retried = false;
    const d: Dictation = createDictation({
      onFinal: (x) => log.push(`final:${x}`),
      onError: (e) => {
        log.push(`error:${e.code}`);
        if (!retried) {
          retried = true;
          log.push(`restart:${d.start()}`);
        }
      },
      onEnd: () => log.push("end"),
    });
    d.start();
    FakeRecognition.instances[0].fail("network");
    assert.deepEqual(log, ["error:network", "restart:true"]);
    assert.equal(d.active, true);
    assert.equal(FakeRecognition.instances.length, 2);
    assert.equal(FakeRecognition.instances[0].aborted, true);
    assert.equal(FakeRecognition.instances[1].started, true);
    FakeRecognition.instances[1].emit([["sigo aquí", true]]);
    t.mock.timers.tick(10000);
    assert.equal(d.active, true, "la sesión nueva no debe morir");
    d.stop();
    FakeRecognition.instances[1].end();
    assert.deepEqual(log, ["error:network", "restart:true", "final:sigo aquí", "end"]);
  });

  test("abort() dentro de onFinal no entrega los finales que quedaban", () => {
    installRecognition();
    const got: string[] = [];
    const d: Dictation = createDictation({
      onFinal: (x) => {
        got.push(x);
        d.abort();
      },
    });
    d.start();
    FakeRecognition.instances[0].emit([["uno", true], ["dos", true]]);
    assert.deepEqual(got, ["uno"]);
  });

  test("start() mientras se detiene reactiva sin onEnd intermedio", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    installRecognition();
    const r = recorder();
    const d = createDictation(r.opts);
    d.start();
    t.mock.timers.tick(3000);
    d.stop();
    assert.equal(d.start(), true);
    FakeRecognition.instances[0].end();
    t.mock.timers.tick(250);
    assert.equal(FakeRecognition.instances.length, 2);
    t.mock.timers.tick(5000);
    assert.equal(FakeRecognition.instances.length, 2, "el temporizador de stop no debe matar la sesión nueva");
    assert.deepEqual(r.log, []);
    assert.equal(d.active, true);
  });
});

/* ------------------ lectura en voz alta con un falso -------------------- */

class FakeUtterance {
  text: string;
  lang = "";
  voice: unknown = null;
  rate = 1;
  onend: ((ev: unknown) => void) | null = null;
  onerror: ((ev: { error: string }) => void) | null = null;
  constructor(text = "") {
    this.text = text;
  }
}

function makeSynth(voices: Array<{ lang: string; name: string; localService: boolean }> = []) {
  const synth = {
    speaking: false,
    pending: false,
    paused: false,
    queue: [] as FakeUtterance[],
    spoken: [] as FakeUtterance[],
    cancels: 0,
    voices,
    getVoices() {
      return this.voices;
    },
    speak(u: FakeUtterance) {
      this.queue.push(u);
      this.spoken.push(u);
      this.speaking = true;
    },
    cancel() {
      this.cancels++;
      const q = this.queue;
      this.queue = [];
      this.speaking = false;
      for (const u of q) u.onerror?.({ error: "interrupted" });
    },
    resume() {
      this.paused = false;
    },
    addEventListener() {},
    removeEventListener() {},
    finishNext() {
      const u = this.queue.shift();
      if (this.queue.length === 0) this.speaking = false;
      u?.onend?.({});
    },
  };
  return synth;
}

describe("speak", () => {
  afterEach(() => {
    stopSpeaking();
    delete g.speechSynthesis;
    delete g.SpeechSynthesisUtterance;
  });

  test("sin síntesis no hace nada y avisa con false", () => {
    assert.equal(isSpeechSynthesisSupported(), false);
    assert.equal(speak("hola"), false);
    assert.equal(isSpeaking(), false);
  });

  test("elige voz es-CL, encola trozos y llama onEnd una sola vez al final", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const synth = makeSynth([
      { lang: "es-ES", name: "España", localService: true },
      { lang: "es_CL", name: "Chile", localService: true },
    ]);
    g.speechSynthesis = synth;
    g.SpeechSynthesisUtterance = FakeUtterance;
    let ends = 0;
    const text = Array.from({ length: 12 }, (_, i) => `Esta es la oración número ${i} del briefing.`).join(" ");
    assert.equal(speak(text, { rate: 1.1, onEnd: () => ends++ }), true);
    assert.ok(synth.spoken.length > 1);
    for (const u of synth.spoken) {
      assert.equal((u.voice as { name: string }).name, "Chile");
      assert.equal(u.lang, "es-CL");
      assert.equal(u.rate, 1.1);
      assert.ok(u.text.length <= 180);
    }
    assert.equal(isSpeaking(), true);
    while (synth.queue.length > 1) synth.finishNext();
    assert.equal(ends, 0);
    synth.finishNext();
    assert.equal(ends, 1);
    assert.equal(isSpeaking(), false);
    t.mock.timers.tick(10000);
    assert.equal(ends, 1);
  });

  test("sin voces cargadas habla igual al tiro (iOS) con lang y sin voz", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const synth = makeSynth([]);
    g.speechSynthesis = synth;
    g.SpeechSynthesisUtterance = FakeUtterance;
    assert.equal(speak("Hola."), true);
    assert.equal(synth.spoken.length, 1);
    assert.equal(synth.spoken[0].voice, null);
    assert.equal(synth.spoken[0].lang, "es-CL");
  });

  test("stopSpeaking() y un speak() nuevo NO disparan el onEnd anterior", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const synth = makeSynth([{ lang: "es-CL", name: "Chile", localService: true }]);
    g.speechSynthesis = synth;
    g.SpeechSynthesisUtterance = FakeUtterance;
    const ends: string[] = [];
    speak("Primero.", { onEnd: () => ends.push("a") });
    speak("Segundo.", { onEnd: () => ends.push("b") });
    assert.ok(synth.cancels >= 1);
    assert.deepEqual(ends, []);
    stopSpeaking();
    t.mock.timers.tick(10000);
    assert.deepEqual(ends, []);
    assert.equal(isSpeaking(), false);
  });

  test("si otra app la interrumpe, onEnd llega (la lectura terminó)", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const synth = makeSynth([{ lang: "es-CL", name: "Chile", localService: true }]);
    g.speechSynthesis = synth;
    g.SpeechSynthesisUtterance = FakeUtterance;
    let ends = 0;
    speak("Hola.", { onEnd: () => ends++ });
    synth.queue[0].onerror?.({ error: "interrupted" });
    assert.equal(ends, 1);
  });

  test("error del sintetizador: onError y luego onEnd una vez", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const synth = makeSynth([{ lang: "es-CL", name: "Chile", localService: true }]);
    g.speechSynthesis = synth;
    g.SpeechSynthesisUtterance = FakeUtterance;
    const log: string[] = [];
    speak("Uno. ".repeat(60), { onEnd: () => log.push("end"), onError: (c) => log.push(`error:${c}`) });
    synth.queue[0].onerror?.({ error: "not-allowed" });
    t.mock.timers.tick(10000);
    assert.deepEqual(log, ["error:not-allowed", "end"]);
  });

  test("si nunca llega 'end', el vigilante cierra la lectura", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const synth = makeSynth([{ lang: "es-CL", name: "Chile", localService: true }]);
    g.speechSynthesis = synth;
    g.SpeechSynthesisUtterance = FakeUtterance;
    let ends = 0;
    speak("Hola.", { onEnd: () => ends++ });
    t.mock.timers.tick(5000);
    assert.equal(ends, 0, "sigue hablando: no se cierra");
    synth.speaking = false;
    synth.queue = [];
    t.mock.timers.tick(3000);
    assert.equal(ends, 1);
  });

  test("speechChunkLength acorta los trozos al hablar más lento", () => {
    assert.equal(speechChunkLength(1), 180);
    assert.equal(speechChunkLength(1.5), 180);
    assert.equal(speechChunkLength(0.75), 135);
    assert.equal(speechChunkLength(0.5), 90);
    assert.equal(speechChunkLength(0.1), 80);
  });

  test("con rate lento los trozos son más cortos", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const synth = makeSynth([{ lang: "es-CL", name: "Chile", localService: true }]);
    g.speechSynthesis = synth;
    g.SpeechSynthesisUtterance = FakeUtterance;
    const text = Array.from({ length: 12 }, (_, i) => `Esta es la oración número ${i} del briefing.`).join(" ");
    speak(text, { rate: 0.5 });
    for (const u of synth.spoken) {
      assert.ok(u.text.length <= 90, `trozo de ${u.text.length}`);
      assert.equal(u.rate, 0.5);
    }
  });

  test("onError que lanza otro speak() no lo corta ni llama al onEnd anterior", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const synth = makeSynth([{ lang: "es-CL", name: "Chile", localService: true }]);
    g.speechSynthesis = synth;
    g.SpeechSynthesisUtterance = FakeUtterance;
    const log: string[] = [];
    speak("Uno. ".repeat(60), {
      onEnd: () => log.push("end-a"),
      onError: () => {
        log.push("error-a");
        speak("Dos.", { onEnd: () => log.push("end-b") });
      },
    });
    synth.queue[0].onerror?.({ error: "synthesis-failed" });
    assert.deepEqual(log, ["error-a"]);
    assert.equal(synth.queue.length, 1);
    assert.equal(synth.queue[0].text, "Dos.");
    synth.finishNext();
    assert.deepEqual(log, ["error-a", "end-b"]);
  });

  test("speak() nuevo cancela aunque el sintetizador diga que no habla (Safari)", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const synth = makeSynth([{ lang: "es-CL", name: "Chile", localService: true }]);
    g.speechSynthesis = synth;
    g.SpeechSynthesisUtterance = FakeUtterance;
    speak("Primero.");
    synth.speaking = false;
    const before = synth.cancels;
    speak("Segundo.");
    assert.equal(synth.cancels, before + 1);
    assert.deepEqual(
      synth.queue.map((u) => u.text),
      ["Segundo."],
    );
  });

  test("texto vacío no habla ni llama onEnd", () => {
    const synth = makeSynth([]);
    g.speechSynthesis = synth;
    g.SpeechSynthesisUtterance = FakeUtterance;
    let ends = 0;
    assert.equal(speak("   ", { onEnd: () => ends++ }), false);
    assert.equal(synth.spoken.length, 0);
    assert.equal(ends, 0);
  });
});
