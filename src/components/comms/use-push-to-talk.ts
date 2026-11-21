"use client";

/**
 * Radio de "apretar para hablar" con el micrófono del navegador.
 *
 * Mientras el botón está apretado graba el micrófono (MediaRecorder) y, si el
 * navegador lo permite, lo transcribe en vivo (SpeechRecognition). Al soltar
 * entrega la transmisión (audio + texto) para subirla a la bitácora.
 *
 *  - Mantener apretado = hablar; soltar = enviar (como una radio).
 *  - Un toque corto deja la transmisión abierta; el siguiente toque la envía.
 *  - Espacio o Enter sobre el botón funcionan igual que el puntero.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { createDictation, isDictationSupported, type Dictation } from "@/lib/client/speech";

export interface PttTransmission {
  /** Grabación; null si el navegador no puede grabar (sin MediaRecorder). */
  audio: Blob | null;
  /** Transcripción del navegador; "" si no hay reconocimiento de voz o no se entendió nada. */
  text: string;
  /** Hora en que se abrió la transmisión. */
  at: string;
  durationMs: number;
}

export type PttStatus = "idle" | "arming" | "recording" | "finishing";

export interface PttState {
  status: PttStatus;
  /** Transmisión abierta con un toque: el próximo toque la envía. */
  latched: boolean;
  /** Lo transcrito hasta ahora (frases finales + la provisional). */
  heard: string;
  level: number;
  elapsed: number;
  error: string | null;
  hint: string | null;
}

/** Bajo esto, soltar no envía: deja la transmisión abierta (toque). */
const TAP_MS = 350;
/** Una transmisión más corta y sin texto se descarta (se soltó sin hablar). */
const MIN_MS = 500;
/** Máximo que se espera al reconocimiento de voz para la última frase tras soltar. */
const DICTATION_TAIL_MS = 2500;
/** Corte de seguridad: ninguna transmisión de radio dura tanto (y el audio cabe en 4 MB). */
const MAX_MS = 90_000;

const RECORDER_TYPES = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4", "audio/webm"];

function recorderType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  return RECORDER_TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? null;
}

function micErrorMessage(err: unknown): string {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "El navegador no dio permiso para usar el micrófono. Permítelo en la barra de direcciones y vuelve a intentar.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No se encontró un micrófono en este equipo.";
  if (name === "NotReadableError") return "Otra aplicación está usando el micrófono.";
  if (typeof navigator !== "undefined" && !navigator.mediaDevices) {
    return "Este navegador no permite usar el micrófono aquí (requiere HTTPS).";
  }
  return "No se pudo abrir el micrófono.";
}

const IDLE: PttState = { status: "idle", latched: false, heard: "", level: 0, elapsed: 0, error: null, hint: null };

interface Session {
  startedAt: number;
  at: string;
  recorder: MediaRecorder | null;
  recorded: Promise<Blob | null>;
  dictation: Dictation | null;
  dictationEnded: Promise<void>;
  finals: string[];
  interim: string;
}

export function usePushToTalk(onTransmission: (t: PttTransmission) => void, opts: { disabled?: boolean } = {}) {
  const [state, setState] = useState<PttState>(IDLE);
  const disabled = opts.disabled ?? false;

  const onTransmissionRef = useRef(onTransmission);
  useEffect(() => {
    onTransmissionRef.current = onTransmission;
  }, [onTransmission]);

  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const statusRef = useRef<PttStatus>("idle");
  const latchedRef = useRef(false);
  const pressRef = useRef({ down: false, at: 0 });
  const rafRef = useRef(0);
  const maxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setStatus = useCallback((status: PttStatus, patch: Partial<PttState> = {}) => {
    statusRef.current = status;
    setState((s) => ({ ...s, ...patch, status }));
  }, []);

  /** Abre el micrófono una vez y lo mantiene mientras la página esté abierta (partir es instantáneo). */
  const ensureStream = useCallback(async (): Promise<MediaStream> => {
    const live = streamRef.current;
    if (live && live.getAudioTracks().some((t) => t.readyState === "live")) return live;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("no-media-devices");
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    streamRef.current = stream;
    try {
      const AudioCtx =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        const ctx = ctxRef.current ?? new AudioCtx();
        ctxRef.current = ctx;
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        ctx.createMediaStreamSource(stream).connect(analyser);
        analyserRef.current = analyser;
      }
    } catch {
      analyserRef.current = null; // sin vúmetro, la grabación sigue
    }
    return stream;
  }, []);

  /** Pitido corto de fin de transmisión (después de cerrar la grabación, así no queda grabado). */
  const rogerBeep = useCallback(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 1250;
      gain.gain.value = 0.06;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.09);
    } catch {
      /* sin sonido */
    }
  }, []);

  const finish = useCallback(async () => {
    const session = sessionRef.current;
    if (!session || statusRef.current !== "recording") return;
    sessionRef.current = null;
    latchedRef.current = false;
    cancelAnimationFrame(rafRef.current);
    if (maxTimerRef.current) clearTimeout(maxTimerRef.current);
    maxTimerRef.current = null;
    setStatus("finishing", { latched: false, level: 0 });

    if (session.recorder && session.recorder.state !== "inactive") session.recorder.stop();
    session.dictation?.stop();
    const tail = new Promise<void>((resolve) => setTimeout(resolve, DICTATION_TAIL_MS));
    const [audio] = await Promise.all([session.recorded, Promise.race([session.dictationEnded, tail])]);
    session.dictation?.abort();
    rogerBeep();

    const text = [...session.finals, session.interim].join(" ").replace(/\s+/g, " ").trim();
    const durationMs = Date.now() - session.startedAt;
    if (durationMs < MIN_MS && !text) {
      setStatus("idle", { heard: "", elapsed: 0, hint: "Mantén apretado el botón mientras hablas." });
      return;
    }
    setStatus("idle", { heard: "", elapsed: 0, hint: null });
    onTransmissionRef.current({ audio, text, at: session.at, durationMs });
  }, [rogerBeep, setStatus]);

  const begin = useCallback(
    (stream: MediaStream) => {
      const type = recorderType();
      const recorder = type ? new MediaRecorder(stream, { mimeType: type }) : null;
      const chunks: Blob[] = [];
      recorder?.addEventListener("dataavailable", (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      });
      const recorded = new Promise<Blob | null>((resolve) => {
        if (!recorder) return resolve(null);
        recorder.addEventListener("stop", () =>
          resolve(chunks.length > 0 ? new Blob(chunks, { type: (recorder.mimeType || type || "audio/webm").split(";")[0] }) : null),
        );
      });

      const session: Session = {
        startedAt: Date.now(),
        at: new Date().toISOString(),
        recorder,
        recorded,
        dictation: null,
        dictationEnded: Promise.resolve(),
        finals: [],
        interim: "",
      };
      const showHeard = () => setState((s) => ({ ...s, heard: [...session.finals, session.interim].join(" ").trim() }));
      if (isDictationSupported()) {
        let ended!: () => void;
        session.dictationEnded = new Promise<void>((resolve) => {
          ended = resolve;
        });
        const dictation = createDictation({
          lang: "es-CL",
          onFinal: (phrase) => {
            const clean = phrase.trim();
            if (clean) session.finals.push(clean);
            session.interim = "";
            showHeard();
          },
          onInterim: (text) => {
            session.interim = text;
            showHeard();
          },
          // Si el reconocimiento falla, la grabación sigue y la transmisión llega sin texto.
          onError: () => ended(),
          onEnd: () => ended(),
        });
        session.dictation = dictation;
        if (!dictation.start()) ended();
      }
      sessionRef.current = session;
      recorder?.start(250);
      setStatus("recording", { heard: "", elapsed: 0, error: null, hint: null, latched: latchedRef.current });

      const samples = new Uint8Array(512);
      let lastPaint = 0;
      const paint = (now: number) => {
        rafRef.current = requestAnimationFrame(paint);
        if (now - lastPaint < 66) return;
        lastPaint = now;
        let level = 0;
        const analyser = analyserRef.current;
        if (analyser) {
          analyser.getByteTimeDomainData(samples);
          let sum = 0;
          for (const v of samples) sum += ((v - 128) / 128) ** 2;
          level = Math.min(1, Math.sqrt(sum / samples.length) * 4);
        }
        setState((s) => ({ ...s, level, elapsed: (Date.now() - session.startedAt) / 1000 }));
      };
      rafRef.current = requestAnimationFrame(paint);
      maxTimerRef.current = setTimeout(() => void finish(), MAX_MS);
    },
    [finish, setStatus],
  );

  const press = useCallback(async () => {
    if (disabled) return;
    const status = statusRef.current;
    if (status === "finishing" || status === "arming") return;
    if (status === "recording") {
      // Transmisión abierta con un toque: este toque la cierra.
      void finish();
      return;
    }
    pressRef.current = { down: true, at: Date.now() };
    latchedRef.current = false;
    setStatus("arming", { error: null, hint: null });
    void ctxRef.current?.resume();
    let stream: MediaStream;
    try {
      stream = await ensureStream();
    } catch (err) {
      setStatus("idle", { error: micErrorMessage(err) });
      return;
    }
    void ctxRef.current?.resume();
    const press = pressRef.current;
    if (!press.down) {
      if (Date.now() - press.at < TAP_MS) {
        latchedRef.current = true; // toque corto: transmisión abierta
      } else {
        // Se soltó mientras el navegador pedía permiso del micrófono.
        setStatus("idle", { hint: "Micrófono listo. Mantén apretado para hablar." });
        return;
      }
    }
    begin(stream);
  }, [begin, disabled, ensureStream, finish, setStatus]);

  const release = useCallback(() => {
    const press = pressRef.current;
    if (!press.down) return;
    press.down = false;
    if (statusRef.current !== "recording") return; // "arming": lo resuelve press()
    if (Date.now() - press.at < TAP_MS) {
      latchedRef.current = true;
      setState((s) => ({ ...s, latched: true }));
      return;
    }
    void finish();
  }, [finish]);

  /** Corta sin enviar (p. ej. al deshabilitar el botón o desmontar). */
  const cancel = useCallback(() => {
    const session = sessionRef.current;
    sessionRef.current = null;
    cancelAnimationFrame(rafRef.current);
    if (maxTimerRef.current) clearTimeout(maxTimerRef.current);
    session?.dictation?.abort();
    if (session?.recorder && session.recorder.state !== "inactive") session.recorder.stop();
    pressRef.current.down = false;
    latchedRef.current = false;
    statusRef.current = "idle";
  }, []);

  useEffect(
    () => () => {
      cancel();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      void ctxRef.current?.close().catch(() => undefined);
      ctxRef.current = null;
    },
    [cancel],
  );

  const buttonProps = {
    onPointerDown: (e: PointerEvent<HTMLButtonElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture?.(e.pointerId);
      void press();
    },
    onPointerUp: () => release(),
    onPointerCancel: () => release(),
    onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => {
      if ((e.key !== " " && e.key !== "Enter") || e.repeat) return;
      e.preventDefault();
      void press();
    },
    onKeyUp: (e: KeyboardEvent<HTMLButtonElement>) => {
      if (e.key !== " " && e.key !== "Enter") return;
      e.preventDefault();
      release();
    },
    // Mantener apretado en el teléfono no debe abrir el menú contextual.
    onContextMenu: (e: { preventDefault: () => void }) => e.preventDefault(),
  };

  return { state, buttonProps, cancel, dictationSupported: isDictationSupported };
}
