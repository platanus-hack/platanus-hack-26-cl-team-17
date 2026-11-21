/**
 * Voz en el navegador: dictado (SpeechRecognition / webkitSpeechRecognition) y
 * lectura en voz alta (speechSynthesis).
 *
 * Se puede importar en SSR y en node: los globals del navegador solo se leen
 * dentro de las funciones. Lo puro (cortar texto, elegir voz, política de
 * reinicio, lectura de resultados) está exportado y probado en speech.test.ts.
 */

/* ------------------------------------------------------------------ */
/* Tipos mínimos de SpeechRecognition                                  */
/* ------------------------------------------------------------------ */

// lib.dom de TypeScript 5.9 no declara SpeechRecognition (solo sus resultados),
// así que se declaran interfaces locales, sin tocar el ámbito global.

interface RecognitionAlternativeLike {
  readonly transcript: string;
}

export interface RecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: RecognitionAlternativeLike;
}

export interface RecognitionResultListLike {
  readonly length: number;
  readonly [index: number]: RecognitionResultLike;
}

interface RecognitionEventLike {
  readonly resultIndex: number;
  readonly results: RecognitionResultListLike;
}

interface RecognitionErrorEventLike {
  readonly error: string;
  readonly message?: string;
}

interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((ev: RecognitionEventLike) => void) | null;
  onerror: ((ev: RecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type RecognitionCtor = new () => RecognitionLike;

function getRecognitionCtor(): RecognitionCtor | null {
  const g = globalThis as unknown as {
    SpeechRecognition?: unknown;
    webkitSpeechRecognition?: unknown;
  };
  const ctor = g.SpeechRecognition ?? g.webkitSpeechRecognition;
  return typeof ctor === "function" ? (ctor as RecognitionCtor) : null;
}

function isAndroid(): boolean {
  const nav = (globalThis as unknown as { navigator?: { userAgent?: unknown } }).navigator;
  return typeof nav?.userAgent === "string" && /android/i.test(nav.userAgent);
}

/** true si el navegador ofrece dictado por voz. */
export function isDictationSupported(): boolean {
  return getRecognitionCtor() !== null;
}

/* ------------------------------------------------------------------ */
/* Dictado: lógica pura                                                */
/* ------------------------------------------------------------------ */

export type DictationErrorCode =
  | "unsupported"
  | "not-allowed"
  | "service-not-allowed"
  | "network"
  | "audio-capture"
  | "language-not-supported"
  | "too-many-restarts"
  | "start-failed"
  | "unknown";

export interface DictationError {
  code: DictationErrorCode;
  message: string;
}

export const DICTATION_UNSUPPORTED_MESSAGE =
  "Tu navegador no permite dictar por voz. Escribe el texto o prueba con Chrome o Safari.";

const TOO_MANY_RESTARTS_MESSAGE =
  "El dictado se detuvo porque el micrófono no está respondiendo. Toca el micrófono para seguir.";

const START_FAILED_MESSAGE = "No pudimos iniciar el dictado. Vuelve a intentarlo o escribe el texto.";

/**
 * Traduce el código de error de SpeechRecognition.
 * Devuelve null si el error se ignora (el dictado sigue con el reinicio automático).
 * `restarting`: el error llegó en un reinicio automático, no al primer toque.
 */
export function describeDictationError(code: string, restarting = false): DictationError | null {
  switch (code) {
    case "no-speech":
    case "aborted":
      return null;
    case "not-allowed":
      // En un reinicio el permiso ya se había dado: el navegador cortó el micrófono.
      return restarting
        ? { code: "not-allowed", message: "El dictado se detuvo. Toca el micrófono para seguir." }
        : {
            code: "not-allowed",
            message:
              "Bloqueaste el micrófono. Para dictar, permítelo en la configuración del navegador (el candado junto a la dirección) y vuelve a intentarlo.",
          };
    case "service-not-allowed":
      return {
        code: "service-not-allowed",
        message:
          "Bloqueaste el micrófono o el dictado por voz está desactivado en este equipo. Actívalo en la configuración o escribe el texto.",
      };
    case "network":
      return {
        code: "network",
        message: "El dictado necesita internet y se perdió la conexión. Vuelve a intentarlo o escribe el texto.",
      };
    case "audio-capture":
      return {
        code: "audio-capture",
        message: "No pudimos usar el micrófono. Revisa que esté conectado y que otra app no lo esté usando.",
      };
    case "language-not-supported":
      return {
        code: "language-not-supported",
        message: "Este navegador no puede dictar en español. Escribe el texto.",
      };
    default:
      return { code: "unknown", message: "El dictado falló. Vuelve a intentarlo o escribe el texto." };
  }
}

export interface RestartPolicy {
  /** Espera antes de reiniciar tras un 'end'; crece con cada sesión corta seguida. */
  baseDelayMs: number;
  /** Una sesión más larga que esto (o con resultados) cuenta como sana. */
  healthySessionMs: number;
  /** Sesiones cortas seguidas, sin resultados, tras las que se deja de reiniciar. */
  maxShortSessions: number;
}

export const DEFAULT_RESTART_POLICY: RestartPolicy = {
  baseDelayMs: 250,
  healthySessionMs: 2000,
  maxShortSessions: 5,
};

/**
 * Decide si se reinicia el reconocimiento tras un 'end' mientras el dictado sigue activo.
 * Devuelve null si hay que rendirse (bucle de sesiones que terminan al tiro).
 */
export function planRestart(
  shortSessions: number,
  sessionMs: number,
  hadResults: boolean,
  policy: RestartPolicy = DEFAULT_RESTART_POLICY,
): { shortSessions: number; delayMs: number } | null {
  const isShort = !hadResults && sessionMs < policy.healthySessionMs;
  const next = isShort ? shortSessions + 1 : 0;
  if (next >= policy.maxShortSessions) return null;
  return { shortSessions: next, delayMs: policy.baseDelayMs * (1 + next) };
}

export interface ResultCursor {
  /** Índice del primer resultado final aún no entregado en esta sesión. */
  emitted: number;
  /** Último final completo visto (para el modo acumulativo de Android). */
  lastFinal: string;
}

export const EMPTY_CURSOR: ResultCursor = { emitted: 0, lastFinal: "" };

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Lee un evento 'result': frases finales nuevas y el texto provisional actual.
 * `cumulative` (Chrome en Android): cada final repite lo anterior de la sesión,
 * así que solo se entrega lo que se agregó al final.
 */
export function collectResults(
  results: RecognitionResultListLike,
  resultIndex: number,
  cursor: ResultCursor,
  cumulative = false,
): { finals: string[]; interim: string; cursor: ResultCursor } {
  const finals: string[] = [];
  const interimParts: string[] = [];
  let { emitted, lastFinal } = cursor;
  const from = Math.max(0, Math.min(resultIndex, results.length));
  for (let i = from; i < results.length; i++) {
    const result = results[i];
    const text = collapse(result && result.length > 0 ? result[0].transcript : "");
    if (!result || !result.isFinal) {
      if (text) interimParts.push(text);
      continue;
    }
    if (i < emitted) continue;
    emitted = i + 1;
    if (!text) continue;
    if (cumulative && lastFinal) {
      const prev = lastFinal.toLowerCase();
      const cur = text.toLowerCase();
      if (cur === prev) continue;
      if (cur.startsWith(`${prev} `)) {
        const added = text.slice(lastFinal.length).trim();
        lastFinal = text;
        if (added) finals.push(added);
        continue;
      }
    }
    lastFinal = text;
    finals.push(text);
  }
  let interim = interimParts.join(" ");
  // En modo acumulativo lo provisional también repite lo ya entregado: se quita ese prefijo.
  if (cumulative && lastFinal && interim) {
    const prev = lastFinal.toLowerCase();
    const cur = interim.toLowerCase();
    if (cur === prev) interim = "";
    else if (cur.startsWith(`${prev} `)) interim = interim.slice(lastFinal.length).trim();
  }
  return { finals, interim, cursor: { emitted, lastFinal } };
}

/* ------------------------------------------------------------------ */
/* Dictado: controlador                                                */
/* ------------------------------------------------------------------ */

export interface DictationOptions {
  /** BCP-47; por defecto "es-CL". */
  lang?: string;
  /** Cada frase final reconocida (ya sin espacios sobrantes). */
  onFinal: (text: string) => void;
  /** Texto provisional de la frase en curso; "" cuando se limpia. */
  onInterim?: (text: string) => void;
  /**
   * Error que detuvo el dictado. Si ocurre durante el dictado, luego viene onEnd
   * (salvo que onError vuelva a llamar a start() y este parta);
   * si start() no pudo partir (sin soporte, fallo al iniciar), start() devuelve false y no hay onEnd.
   */
  onError?: (err: DictationError) => void;
  /** Una vez, cuando el dictado termina de verdad (stop, abort o error); no en los reinicios internos. */
  onEnd?: () => void;
}

export interface Dictation {
  /**
   * Empieza a escuchar. Llamar desde un toque del usuario.
   * Devuelve false si no se pudo (sin soporte o fallo al iniciar; en ese caso ya se llamó a onError).
   */
  start(): boolean;
  /** Deja de escuchar y espera la última frase final antes de onEnd. */
  stop(): void;
  /** Corta de inmediato y descarta lo que no se haya entregado (p. ej. al desmontar). */
  abort(): void;
  readonly active: boolean;
  isActive(): boolean;
}

function configureRecognition(Ctor: RecognitionCtor, lang: string): RecognitionLike | null {
  try {
    const r = new Ctor();
    r.lang = lang;
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;
    return r;
  } catch {
    return null;
  }
}

/** Si el navegador no manda 'end' tras stop(), se corta igual después de esto. */
const STOP_GRACE_MS = 2000;

/**
 * Dictado continuo con reinicio automático mientras siga activo.
 * Nunca lanza: sin soporte, start() llama a onError({ code: "unsupported" }) y devuelve false.
 */
export function createDictation(options: DictationOptions): Dictation {
  const lang = options.lang ?? "es-CL";
  let active = false;
  let rec: RecognitionLike | null = null;
  let ended = true;
  let cursor: ResultCursor = EMPTY_CURSOR;
  let lastInterim = "";
  let sessionStart = 0;
  let sessionHadResults = false;
  let sessionCount = 0;
  let shortSessions = 0;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let stopTimer: ReturnType<typeof setTimeout> | null = null;
  let cumulative = false;

  const emitInterim = (text: string) => {
    if (text === lastInterim) return;
    lastInterim = text;
    options.onInterim?.(text);
  };

  const clearTimers = () => {
    if (restartTimer !== null) clearTimeout(restartTimer);
    if (stopTimer !== null) clearTimeout(stopTimer);
    restartTimer = null;
    stopTimer = null;
  };

  const detach = (r: RecognitionLike) => {
    r.onresult = null;
    r.onerror = null;
    r.onend = null;
  };

  const dropCurrent = (hard: boolean) => {
    const r = rec;
    rec = null;
    if (!r) return;
    detach(r);
    if (hard) {
      try {
        r.abort();
      } catch {
        // ya estaba detenido
      }
    }
  };

  const finish = () => {
    clearTimers();
    dropCurrent(true);
    active = false;
    emitInterim("");
    if (!ended) {
      ended = true;
      options.onEnd?.();
    }
  };

  const fail = (err: DictationError) => {
    // Se desarma todo antes de avisar: si onError llama a start(), parte limpio.
    clearTimers();
    dropCurrent(true);
    active = false;
    emitInterim("");
    const wasRunning = !ended;
    ended = true;
    options.onError?.(err);
    // Si onError ya reinició el dictado, su onEnd llegará cuando esa sesión termine.
    if (wasRunning && !active) options.onEnd?.();
  };

  const launch = (): boolean => {
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      fail({ code: "unsupported", message: DICTATION_UNSUPPORTED_MESSAGE });
      return false;
    }
    const r = configureRecognition(Ctor, lang);
    if (!r) {
      fail({ code: "start-failed", message: START_FAILED_MESSAGE });
      return false;
    }
    r.onresult = (ev) => {
      if (rec !== r) return;
      const out = collectResults(ev.results, ev.resultIndex, cursor, cumulative);
      cursor = out.cursor;
      if (out.finals.length > 0 || out.interim) sessionHadResults = true;
      // Se limpia lo provisional antes de entregar el final, para no mostrarlo dos veces.
      emitInterim(out.interim);
      for (const text of out.finals) {
        // onFinal/onInterim pueden haber llamado a abort().
        if (rec !== r) break;
        options.onFinal(text);
      }
    };
    r.onerror = (ev) => {
      if (rec !== r || !active) return;
      const err = describeDictationError(ev.error, sessionCount > 1);
      if (err) fail(err);
    };
    r.onend = () => {
      if (rec !== r) return;
      dropCurrent(false);
      if (stopTimer !== null) clearTimeout(stopTimer);
      stopTimer = null;
      // Safari a veces termina sin marcar como final lo último que oyó.
      if (lastInterim) {
        const pending = lastInterim;
        emitInterim("");
        options.onFinal(pending);
      }
      if (!active) {
        finish();
        return;
      }
      const plan = planRestart(shortSessions, Date.now() - sessionStart, sessionHadResults);
      if (!plan) {
        fail({ code: "too-many-restarts", message: TOO_MANY_RESTARTS_MESSAGE });
        return;
      }
      shortSessions = plan.shortSessions;
      restartTimer = setTimeout(() => {
        restartTimer = null;
        if (active) launch();
        else finish();
      }, plan.delayMs);
    };

    rec = r;
    cursor = EMPTY_CURSOR;
    sessionStart = Date.now();
    sessionHadResults = false;
    sessionCount += 1;
    try {
      r.start();
      return true;
    } catch {
      fail({ code: "start-failed", message: START_FAILED_MESSAGE });
      return false;
    }
  };

  const controller: Dictation = {
    start() {
      if (active) return true;
      if (rec) {
        // Se estaba deteniendo: se reactiva y el 'end' pendiente reinicia solo.
        active = true;
        return true;
      }
      if (!getRecognitionCtor()) {
        options.onError?.({ code: "unsupported", message: DICTATION_UNSUPPORTED_MESSAGE });
        return false;
      }
      active = true;
      shortSessions = 0;
      sessionCount = 0;
      lastInterim = "";
      cumulative = isAndroid();
      // Un fallo dentro de este start() se informa con onError y false, sin onEnd.
      const ok = launch();
      if (ok) ended = false;
      return ok;
    },
    stop() {
      if (!active) return;
      active = false;
      if (!rec) {
        finish();
        return;
      }
      try {
        rec.stop();
      } catch {
        finish();
        return;
      }
      stopTimer = setTimeout(() => {
        stopTimer = null;
        if (!active) {
          finish();
          return;
        }
        // Se reactivó mientras se detenía y el 'end' nunca llegó: sesión nueva.
        dropCurrent(true);
        launch();
      }, STOP_GRACE_MS);
    },
    abort() {
      active = false;
      finish();
    },
    get active() {
      return active;
    },
    isActive() {
      return active;
    },
  };
  return controller;
}

/* ------------------------------------------------------------------ */
/* Lectura en voz alta: lógica pura                                    */
/* ------------------------------------------------------------------ */

export interface VoiceLike {
  lang: string;
  name: string;
  localService?: boolean;
}

function normalizeLang(lang: string): string {
  return lang.trim().replace(/_/g, "-").toLowerCase();
}

/** Menor = mejor. Infinity = no sirve (no es español ni el idioma pedido). */
function voiceTier(lang: string, preferred: string): number {
  const l = normalizeLang(lang);
  if (!l) return Infinity;
  if (l === preferred) return 0;
  if (l === "es-419") return 1;
  if (l === "es-us") return 2;
  if (l === "es-mx") return 3;
  if (l.startsWith("es-") && l !== "es-es") return 4;
  if (l === "es" || l === "es-es") return 5;
  return Infinity;
}

/**
 * Elige la voz: es-CL > es-419 > es-US > es-MX > otro español latinoamericano > es / es-ES.
 * Dentro del mismo nivel prefiere las locales (funcionan sin internet). null si no hay español.
 */
export function pickVoice<T extends VoiceLike>(voices: readonly T[], preferredLang = "es-CL"): T | null {
  const preferred = normalizeLang(preferredLang);
  let best: T | null = null;
  let bestScore = Infinity;
  for (const v of voices) {
    const tier = voiceTier(v.lang ?? "", preferred);
    if (tier === Infinity) continue;
    const score = tier * 2 + (v.localService ? 0 : 1);
    if (score < bestScore) {
      best = v;
      bestScore = score;
    }
  }
  return best;
}

const SENTENCE_END = new Set([".", "!", "?", "…", ";"]);
const CLOSERS = new Set(['"', "'", "”", "’", "»", ")", "]"]);
const SOFT_BREAK = /[,:;—–-]/;

function splitSentences(line: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < line.length; i++) {
    if (!SENTENCE_END.has(line[i])) continue;
    let j = i + 1;
    while (j < line.length && (SENTENCE_END.has(line[j]) || CLOSERS.has(line[j]))) j++;
    // Solo corta si viene un espacio: "3.5" o "km.h" no se parten.
    if (j < line.length && line[j] !== " ") {
      i = j - 1;
      continue;
    }
    const piece = line.slice(start, j).trim();
    if (piece) out.push(piece);
    start = j;
    i = j - 1;
  }
  const rest = line.slice(start).trim();
  if (rest) out.push(rest);
  return out;
}

function splitLong(sentence: string, limit: number): string[] {
  const out: string[] = [];
  let rest = sentence;
  while (rest.length > limit) {
    const head = rest.slice(0, limit + 1);
    let cut = -1;
    // Primero una pausa natural (coma, dos puntos, guion) en la segunda mitad.
    for (let k = head.length - 1; k >= Math.floor(limit * 0.4); k--) {
      if (head[k] === " " && k > 0 && SOFT_BREAK.test(head[k - 1])) {
        cut = k;
        break;
      }
    }
    if (cut < 0) cut = head.lastIndexOf(" ");
    if (cut <= 0) {
      out.push(rest.slice(0, limit));
      rest = rest.slice(limit).trim();
      continue;
    }
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * Corta el texto en trozos de a lo más `maxLen` caracteres, por oraciones
 * (y si una oración es muy larga, por comas o espacios), juntando oraciones
 * cortas en un mismo trozo. Chrome corta las locuciones largas a los ~15 s.
 * Los saltos de línea cuentan como fin de oración.
 */
export function splitForSpeech(text: string, maxLen = 180): string[] {
  const limit = Number.isFinite(maxLen) && maxLen >= 1 ? Math.floor(maxLen) : 180;
  const lines = text
    .split(/\r?\n/)
    .map(collapse)
    .filter(Boolean);
  const sentences: string[] = [];
  lines.forEach((line, idx) => {
    const isLast = idx === lines.length - 1;
    const ended = SENTENCE_END.has(line[line.length - 1]) || CLOSERS.has(line[line.length - 1]) || /[,:]$/.test(line);
    sentences.push(...splitSentences(isLast || ended ? line : `${line}.`));
  });
  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    const pieces = sentence.length > limit ? splitLong(sentence, limit) : [sentence];
    for (const piece of pieces) {
      if (!current) current = piece;
      else if (current.length + 1 + piece.length <= limit) current = `${current} ${piece}`;
      else {
        chunks.push(current);
        current = piece;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/* ------------------------------------------------------------------ */
/* Lectura en voz alta: navegador                                      */
/* ------------------------------------------------------------------ */

interface SynthEnv {
  synth: SpeechSynthesis;
  Utterance: new (text?: string) => SpeechSynthesisUtterance;
}

function getSynthEnv(): SynthEnv | null {
  const g = globalThis as unknown as {
    speechSynthesis?: SpeechSynthesis;
    SpeechSynthesisUtterance?: new (text?: string) => SpeechSynthesisUtterance;
  };
  if (!g.speechSynthesis || typeof g.SpeechSynthesisUtterance !== "function") return null;
  return { synth: g.speechSynthesis, Utterance: g.SpeechSynthesisUtterance };
}

/** true si el navegador puede leer en voz alta. */
export function isSpeechSynthesisSupported(): boolean {
  return getSynthEnv() !== null;
}

function safeVoices(synth: SpeechSynthesis): SpeechSynthesisVoice[] {
  try {
    return synth.getVoices() ?? [];
  } catch {
    return [];
  }
}

/**
 * Espera a que el navegador cargue las voces ('voiceschanged', o sondeo para Safari),
 * con tope de `timeoutMs`. Conviene llamarla al montar la vista que va a leer,
 * para que el primer speak() ya tenga la voz es-CL elegida.
 */
export function loadVoices(timeoutMs = 1500): Promise<SpeechSynthesisVoice[]> {
  const env = getSynthEnv();
  if (!env) return Promise.resolve([]);
  const { synth } = env;
  const now = safeVoices(synth);
  if (now.length > 0) return Promise.resolve(now);
  return new Promise((resolve) => {
    let done = false;
    const onChange = () => {
      if (safeVoices(synth).length > 0) settle();
    };
    const settle = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(poll);
      if (typeof synth.removeEventListener === "function") synth.removeEventListener("voiceschanged", onChange);
      resolve(safeVoices(synth));
    };
    const timer = setTimeout(settle, Math.max(0, timeoutMs));
    const poll = setInterval(onChange, 100);
    if (typeof synth.addEventListener === "function") synth.addEventListener("voiceschanged", onChange);
  });
}

export interface SpeakOptions {
  /** 0.5–2; por defecto 1. */
  rate?: number;
  /** BCP-47; por defecto "es-CL". */
  lang?: string;
  /**
   * Una vez, al terminar el último trozo, o si la lectura se cae (error del
   * sintetizador o la cancela otra app). NUNCA se llama cuando la cancela
   * stopSpeaking() ni cuando otro speak() la reemplaza.
   */
  onEnd?: () => void;
  /**
   * Error del sintetizador (p. ej. "not-allowed" si se llamó sin un toque previo); luego viene
   * onEnd, salvo que onError lance otro speak().
   */
  onError?: (code: string) => void;
}

interface SpeechJob {
  utterances: SpeechSynthesisUtterance[];
  onEnd?: () => void;
  watchdog: ReturnType<typeof setInterval> | null;
}

// Referencias vivas a las locuciones: si Chrome las recolecta, nunca dispara 'end'.
let currentJob: SpeechJob | null = null;

/** Si el sintetizador queda inactivo este número de sondeos seguidos sin 'end', se da por terminado. */
const WATCHDOG_INTERVAL_MS = 1000;
const WATCHDOG_IDLE_TICKS = 3;

function releaseJob(job: SpeechJob) {
  if (job.watchdog !== null) clearInterval(job.watchdog);
  job.watchdog = null;
  for (const u of job.utterances) {
    u.onend = null;
    u.onerror = null;
  }
  if (currentJob === job) currentJob = null;
}

function completeJob(job: SpeechJob) {
  if (currentJob !== job) return;
  releaseJob(job);
  job.onEnd?.();
}

/** Corta la lectura en curso sin llamar a su onEnd. */
function dropJob(synth: SpeechSynthesis) {
  const hadJob = currentJob !== null;
  if (currentJob) releaseJob(currentJob);
  // Safari a veces informa speaking=false con locuciones aún en cola: si había lectura, se cancela igual.
  if (hadJob || synth.speaking || synth.pending) synth.cancel();
}

/** Largo máximo de trozo a 180 caracteres por rate 1 (~12 s); más lento, trozos más cortos. */
export function speechChunkLength(rate: number): number {
  return Math.max(80, Math.round(180 * Math.min(1, rate)));
}

/**
 * Lee `text` en voz alta. Sincrónica: se puede (y en iOS se debe) llamar dentro
 * del manejador del toque. Cancela cualquier lectura anterior. Si las voces aún
 * no cargaron, lee igual con `lang` y la voz por defecto, y deja cargando las voces.
 * Devuelve true si quedó leyendo; false si no hay síntesis o el texto está vacío
 * (en ese caso no se llama a onEnd).
 */
export function speak(text: string, options: SpeakOptions = {}): boolean {
  const env = getSynthEnv();
  if (!env) return false;
  const { synth, Utterance } = env;
  dropJob(synth);

  const requested = options.rate ?? 1;
  const rate = Number.isFinite(requested) ? Math.min(2, Math.max(0.5, requested)) : 1;
  const chunks = splitForSpeech(text, speechChunkLength(rate));
  if (chunks.length === 0) return false;

  const lang = options.lang ?? "es-CL";
  const voices = safeVoices(synth);
  const voice = voices.length > 0 ? pickVoice(voices, lang) : null;
  if (voices.length === 0) void loadVoices();

  const job: SpeechJob = { utterances: [], onEnd: options.onEnd, watchdog: null };
  currentJob = job;

  chunks.forEach((chunk, idx) => {
    const u = new Utterance(chunk);
    u.lang = voice ? voice.lang.replace(/_/g, "-") : lang;
    if (voice) u.voice = voice;
    u.rate = rate;
    const isLast = idx === chunks.length - 1;
    u.onend = () => {
      if (isLast) completeJob(job);
    };
    u.onerror = (ev: SpeechSynthesisErrorEvent) => {
      if (currentJob !== job) return;
      const code = ev?.error ?? "unknown";
      // "interrupted"/"canceled" con la lectura vigente: la cortó otro (otra app, el sistema).
      if (code !== "interrupted" && code !== "canceled") {
        // Se suelta y cancela antes de avisar: si onError/onEnd llaman a speak(), no se corta la nueva.
        releaseJob(job);
        if (synth.speaking || synth.pending) synth.cancel();
        options.onError?.(code);
        // Si onError ya lanzó otra lectura, esta quedó reemplazada: sin onEnd.
        if (currentJob === null) job.onEnd?.();
        return;
      }
      completeJob(job);
    };
    job.utterances.push(u);
  });

  for (const u of job.utterances) synth.speak(u);
  // Chrome puede quedar en pausa tras un cancel(); sin esto no suena.
  if (synth.paused) synth.resume();

  let idleTicks = 0;
  job.watchdog = setInterval(() => {
    if (currentJob !== job) return;
    idleTicks = !synth.speaking && !synth.pending ? idleTicks + 1 : 0;
    if (idleTicks >= WATCHDOG_IDLE_TICKS) completeJob(job);
  }, WATCHDOG_INTERVAL_MS);

  return true;
}

/** Detiene la lectura en curso. El onEnd de esa lectura no se llama. */
export function stopSpeaking(): void {
  const env = getSynthEnv();
  if (!env) {
    if (currentJob) releaseJob(currentJob);
    return;
  }
  if (currentJob) releaseJob(currentJob);
  env.synth.cancel();
}

/** true mientras haya una lectura de speak() en curso (o el sintetizador esté hablando). */
export function isSpeaking(): boolean {
  if (currentJob) return true;
  const env = getSynthEnv();
  return env ? env.synth.speaking : false;
}
