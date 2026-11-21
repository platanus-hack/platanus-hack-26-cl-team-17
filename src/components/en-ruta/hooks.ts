"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { BriefingSnapshot } from "@/lib/contract";
import { isSpeechSynthesisSupported, speak, stopSpeaking } from "@/lib/client/speech";
import {
  autoReadText,
  diffBriefing,
  mergeChanges,
  speechSignature,
  spokenText,
  type BriefingChange,
} from "./briefing-diff";

const noopSubscribe = () => () => {};

/** true solo en el navegador si hay síntesis de voz (false en el servidor y al hidratar). */
export function useSpeechSupported(): boolean {
  return useSyncExternalStore(noopSubscribe, isSpeechSynthesisSupported, () => false);
}

export type WakeLockState = "unsupported" | "on" | "off";

/**
 * Mantiene la pantalla encendida (Screen Wake Lock). El navegador lo suelta al ocultar la
 * pestaña: se vuelve a pedir cuando vuelve a ser visible.
 */
export function useWakeLock(): WakeLockState {
  const [state, setState] = useState<WakeLockState>("off");

  useEffect(() => {
    if (typeof navigator === "undefined" || !("wakeLock" in navigator) || !navigator.wakeLock) {
      // Se informa en el siguiente ciclo para no actualizar estado dentro del efecto.
      const t = setTimeout(() => setState("unsupported"), 0);
      return () => clearTimeout(t);
    }
    let sentinel: WakeLockSentinel | null = null;
    let disposed = false;

    const onRelease = () => {
      if (!disposed) setState("off");
    };

    const request = async () => {
      if (disposed || document.visibilityState !== "visible") return;
      if (sentinel && !sentinel.released) return;
      try {
        const s = await navigator.wakeLock.request("screen");
        if (disposed) {
          void s.release();
          return;
        }
        sentinel = s;
        s.addEventListener("release", onRelease);
        setState("on");
      } catch {
        // Sin permiso (batería baja, política del navegador): la página sigue funcionando.
        if (!disposed) setState("off");
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") void request();
    };

    void request();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisibility);
      if (sentinel) {
        sentinel.removeEventListener("release", onRelease);
        void sentinel.release().catch(() => {});
      }
    };
  }, []);

  return state;
}

function vibrateShort(): void {
  try {
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      navigator.vibrate([180, 90, 180]);
    }
  } catch {
    // Algunos navegadores lanzan sin gesto previo del usuario: no es crítico.
  }
}

interface UpdatesState {
  snapshot: BriefingSnapshot | null;
  pending: BriefingChange[];
  seq: number;
}

/**
 * Compara cada snapshot nuevo con el anterior: los cambios importantes se acumulan en el aviso
 * "ACTUALIZACIÓN" hasta que se toca, y cada aviso nuevo vibra brevemente.
 */
export function useBriefingUpdates(briefing: BriefingSnapshot | null): {
  pending: BriefingChange[];
  seq: number;
  dismiss: () => void;
} {
  const [state, setState] = useState<UpdatesState>({ snapshot: null, pending: [], seq: 0 });

  // Patrón "derivar del render anterior": el diff se calcula al renderizar un snapshot nuevo.
  if (briefing && briefing !== state.snapshot) {
    const diff = diffBriefing(state.snapshot, briefing);
    setState({
      snapshot: briefing,
      pending: diff.important ? mergeChanges(state.pending, diff.changes) : state.pending,
      seq: diff.important ? state.seq + 1 : state.seq,
    });
  }

  useEffect(() => {
    if (state.seq > 0) vibrateShort();
  }, [state.seq]);

  const dismiss = useCallback(() => setState((s) => ({ ...s, pending: [] })), []);
  return { pending: state.pending, seq: state.seq, dismiss };
}

/**
 * Lectura automática: con `enabled`, cuando cambia el texto hablado o el estado de atrapados,
 * corta lo que se esté leyendo y lee "Actualización. …". La primera respuesta solo se registra.
 */
export function useAutoRead(
  briefing: BriefingSnapshot | null,
  enabled: boolean,
  onSpeaking: (speaking: boolean) => void,
): void {
  const lastSig = useRef<string | null | undefined>(undefined);
  const sig = briefing ? speechSignature(briefing) : undefined;

  useEffect(() => {
    if (sig === undefined) return;
    const prev = lastSig.current;
    lastSig.current = sig;
    if (!enabled || prev === undefined) return;
    const text = autoReadText(prev, briefing);
    if (!text) return;
    stopSpeaking();
    const started = speak(text, { onEnd: () => onSpeaking(false) });
    onSpeaking(started);
    // Solo la firma dispara la relectura; el snapshot completo cambia con cada rev.
    // La firma se registra aunque esté apagada: al activar solo se releen los cambios posteriores.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
}

export interface BriefingVoice {
  /** false en el servidor, al hidratar y en navegadores sin síntesis de voz. */
  supported: boolean;
  speaking: boolean;
  autoRead: boolean;
  /** Activar la lectura automática cuenta como toque: se confirma en voz alta (desbloquea iOS). */
  setAutoRead: (on: boolean) => void;
  /** true si hay un briefing que leer. */
  canRead: boolean;
  read: () => void;
  stop: () => void;
}

/** Estado de la voz del briefing: lectura a pedido y relectura automática cuando cambia. */
export function useBriefingVoice(briefing: BriefingSnapshot | null): BriefingVoice {
  const supported = useSpeechSupported();
  const [speaking, setSpeaking] = useState(false);
  const [autoRead, setAutoReadState] = useState(false);

  useAutoRead(briefing, supported && autoRead, setSpeaking);

  useEffect(() => () => stopSpeaking(), []);

  const text = spokenText(briefing);

  const read = useCallback(() => {
    if (!text) return;
    setSpeaking(speak(text, { onEnd: () => setSpeaking(false) }));
  }, [text]);

  const stop = useCallback(() => {
    stopSpeaking();
    setSpeaking(false);
  }, []);

  const setAutoRead = useCallback((on: boolean) => {
    setAutoReadState(on);
    if (on) {
      setSpeaking(speak("Lectura automática activada.", { onEnd: () => setSpeaking(false) }));
    } else {
      stopSpeaking();
      setSpeaking(false);
    }
  }, []);

  return { supported, speaking, autoRead, setAutoRead, canRead: text.length > 0, read, stop };
}
