"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import { Eye, EyeOff, LockKeyhole, LogIn, Mail, TriangleAlert } from "lucide-react";
import { Button, Field, IconButton, Input } from "@/components/ui";
import { api, isApiClientError } from "@/lib/client/api";

interface LoginFormProps {
  /** Ruta interna ya saneada en el servidor (nunca /login). */
  next: string;
  /** Error de configuración del servidor: deshabilita el formulario. */
  configError: string | null;
}

function messageFor(err: unknown): string {
  if (!isApiClientError(err)) return "No pudimos iniciar sesión. Intenta de nuevo.";
  switch (err.code) {
    case "unauthorized":
      return "Correo o contraseña incorrectos.";
    case "rate_limited":
      return "Demasiados intentos fallidos. Espera unos minutos antes de volver a intentar.";
    case "invalid":
      return "Revisa el correo y la contraseña.";
    case "network":
      return "Sin conexión. Revisa tu red e intenta de nuevo.";
    case "aborted":
      return "Se canceló el intento. Vuelve a intentarlo.";
    default:
      return "El servidor no pudo iniciar tu sesión. Intenta de nuevo en un momento.";
  }
}

export function LoginForm({ next, configError }: LoginFormProps) {
  const ids = useId();
  const emailId = `${ids}-email`;
  const passwordId = `${ids}-password`;
  const errorId = `${ids}-error`;
  const passwordRef = useRef<HTMLInputElement>(null);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const locked = Boolean(configError);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending || locked) return;
    if (!email.trim() || !password) {
      setError("Ingresa tu correo y tu contraseña.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      await api.auth.login({ email: email.trim(), password });
      // Navegación completa: el proxy y las páginas del servidor ven la cookie nueva.
      window.location.assign(next);
    } catch (err) {
      setError(messageFor(err));
      setPassword("");
      setPending(false);
      passwordRef.current?.focus();
    }
  }

  const shownError = configError ?? error;

  return (
    <form onSubmit={onSubmit} noValidate className="mt-6 space-y-5" aria-describedby={shownError ? errorId : undefined}>
      {shownError ? (
        <div
          id={errorId}
          role="alert"
          className="flex gap-2 rounded-md border border-critical/50 bg-critical-soft px-3 py-2.5 text-sm text-text"
        >
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-critical" />
          <p>
            <span className="sr-only">Error: </span>
            {shownError}
          </p>
        </div>
      ) : null}

      <Field label="Correo" htmlFor={emailId}>
        <Input
          id={emailId}
          name="email"
          type="email"
          inputMode="email"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          required
          autoFocus
          size="lg"
          icon={Mail}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={locked}
          invalid={Boolean(error)}
          placeholder="nombre@bomberos.cl"
        />
      </Field>

      <Field label="Contraseña" htmlFor={passwordId}>
        <div className="flex gap-2">
          <Input
            ref={passwordRef}
            id={passwordId}
            name="password"
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            required
            size="lg"
            icon={LockKeyhole}
            className="flex-1"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={locked}
            invalid={Boolean(error)}
          />
          <IconButton
            icon={showPassword ? EyeOff : Eye}
            label={showPassword ? "Ocultar contraseña" : "Mostrar contraseña"}
            variant="secondary"
            size="lg"
            active={showPassword}
            aria-controls={passwordId}
            disabled={locked}
            onClick={() => setShowPassword((v) => !v)}
          />
        </div>
      </Field>

      <Button type="submit" variant="primary" size="lg" icon={LogIn} loading={pending} disabled={locked} fullWidth>
        {pending ? "Ingresando…" : "Ingresar"}
      </Button>
      <p className="sr-only" aria-live="polite">
        {pending ? "Verificando tus datos…" : ""}
      </p>
    </form>
  );
}
