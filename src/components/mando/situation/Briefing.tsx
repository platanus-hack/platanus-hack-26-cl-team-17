"use client";
/** Briefing para unidades en ruta: texto hablado, puntos, lectura en voz alta y copia. */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { CircleAlert, Square, Volume2 } from "lucide-react";
import { Button, CopyButton } from "@/components/ui";
import type { SituationReport } from "@/lib/domain";
import { isSpeaking, isSpeechSynthesisSupported, speak, stopSpeaking } from "@/lib/client/speech";
import { briefingCopyText, briefingSpeechText } from "./model";

const noopSubscribe = () => () => {};
const serverFalse = () => false;

/** Soporte de síntesis de voz; false en el servidor y al hidratar para no desajustar el HTML. */
function useSpeechSupported(): boolean {
  return useSyncExternalStore(noopSubscribe, isSpeechSynthesisSupported, serverFalse);
}

function speechErrorMessage(code: string): string {
  if (code === "not-allowed") return "El navegador bloqueó la lectura. Vuelve a tocar «Leer en voz alta».";
  if (code === "synthesis-unavailable" || code === "language-unavailable" || code === "voice-unavailable") {
    return "No hay una voz en español disponible en este equipo.";
  }
  return `No se pudo leer en voz alta (${code}).`;
}

export interface BriefingBlockProps {
  briefing: SituationReport["briefing"];
}

export function BriefingBlock({ briefing }: BriefingBlockProps) {
  const supported = useSpeechSupported();
  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const speakingRef = useRef(false);

  const spoken = briefing.spoken.trim();
  const bullets = briefing.bullets.map((b) => b.trim()).filter(Boolean);
  const speechText = briefingSpeechText(briefing);
  const copyText = briefingCopyText(briefing);

  // Al desmontar se corta la lectura propia (no la de otros paneles).
  useEffect(
    () => () => {
      if (speakingRef.current) stopSpeaking();
    },
    [],
  );

  // Otro speak() de la página reemplaza esta lectura sin llamar a onEnd: se detecta por sondeo.
  useEffect(() => {
    if (!speaking) return;
    const timer = setInterval(() => {
      if (!isSpeaking()) {
        speakingRef.current = false;
        setSpeaking(false);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [speaking]);

  const finish = () => {
    speakingRef.current = false;
    setSpeaking(false);
  };

  const start = () => {
    setError(null);
    const ok = speak(speechText, {
      lang: "es-CL",
      onEnd: finish,
      onError: (code) => setError(speechErrorMessage(code)),
    });
    if (ok) {
      speakingRef.current = true;
      setSpeaking(true);
    } else {
      setError("No se pudo iniciar la lectura en voz alta.");
    }
  };

  const stop = () => {
    stopSpeaking();
    finish();
  };

  if (!spoken && bullets.length === 0) {
    return <p className="text-sm text-muted">La IA no generó un briefing con la información disponible.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {spoken ? (
        <blockquote className="border-l-2 border-line-strong pl-3 text-base leading-relaxed text-text">
          {spoken}
        </blockquote>
      ) : null}
      {bullets.length > 0 ? (
        <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-text marker:text-muted">
          {bullets.map((b, i) => (
            <li key={`${i}-${b}`}>{b}</li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {speaking ? (
          <Button size="sm" variant="primary" icon={Square} onClick={stop}>
            Detener lectura
          </Button>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            icon={Volume2}
            onClick={start}
            disabled={!supported || !speechText}
            title={supported ? "Leer el briefing en voz alta" : "Este navegador no puede leer en voz alta"}
          >
            Leer en voz alta
          </Button>
        )}
        <CopyButton value={copyText} size="sm" label="Copiar" />
        {!supported ? <span className="text-xs text-muted">Lectura en voz alta no disponible en este navegador.</span> : null}
      </div>
      {error ? (
        <p role="alert" className="inline-flex items-start gap-1.5 text-sm text-critical">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          {error}
        </p>
      ) : null}
    </div>
  );
}
