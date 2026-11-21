"use client";

import { useId, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, CircleAlert, KeyRound } from "lucide-react";
import { Button, Input } from "@/components/ui";
import { cn } from "@/lib/cn";
import { INCIDENT_CODE_EXAMPLE, parseIncidentCode } from "./incident-code";

export interface CodeEntryProps {
  /** Valor inicial (p. ej. un ?code= que no tenía forma de código). */
  initialValue?: string;
  /** Muestra de entrada el error de formato (cuando initialValue no sirvió). */
  initialInvalid?: boolean;
  /** Título del bloque; por defecto "Tengo un código". */
  label?: string;
  className?: string;
}

/** Campo "Tengo un código": acepta "vg 7k3q", "7K3Q" o "VG-7K3Q" y lleva a /reportar/VG-7K3Q. */
export function CodeEntry({
  initialValue = "",
  initialInvalid = false,
  label = "Tengo un código",
  className,
}: CodeEntryProps) {
  const router = useRouter();
  const baseId = useId();
  const inputId = `${baseId}-code`;
  const hintId = `${baseId}-hint`;
  const errorId = `${baseId}-error`;
  const [value, setValue] = useState(initialValue.toUpperCase());
  const [invalid, setInvalid] = useState(initialInvalid);
  const [pending, startTransition] = useTransition();

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const code = parseIncidentCode(value);
    if (!code) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setValue(code);
    startTransition(() => router.push(`/reportar/${code}`));
  };

  return (
    <form onSubmit={onSubmit} noValidate className={cn("rounded-lg border border-line bg-surface p-4", className)}>
      <label htmlFor={inputId} className="block text-lg font-semibold text-text">
        {label}
      </label>
      <p id={hintId} className="mt-1 text-base leading-snug text-muted">
        Si Bomberos o un letrero con QR te dio un código, escríbelo aquí. Se ve así: {INCIDENT_CODE_EXAMPLE}.
      </p>
      <div className="mt-3 flex gap-2">
        <Input
          id={inputId}
          name="code"
          size="xl"
          icon={KeyRound}
          className="flex-1 font-mono tracking-wider"
          value={value}
          onChange={(e) => {
            setValue(e.target.value.toUpperCase());
            if (invalid) setInvalid(false);
          }}
          invalid={invalid}
          placeholder={INCIDENT_CODE_EXAMPLE}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="characters"
          spellCheck={false}
          enterKeyHint="go"
          maxLength={16}
          aria-describedby={invalid ? `${hintId} ${errorId}` : hintId}
        />
        <Button type="submit" variant="primary" size="xl" iconRight={ArrowRight} loading={pending} className="px-5">
          Ir
        </Button>
      </div>
      {invalid && (
        <p id={errorId} role="alert" className="mt-2 flex items-start gap-2 text-base leading-snug text-critical">
          <CircleAlert aria-hidden className="mt-0.5 size-5 shrink-0" />
          <span>Revisa el código: son las letras VG y 4 letras o números, como {INCIDENT_CODE_EXAMPLE}.</span>
        </p>
      )}
    </form>
  );
}
