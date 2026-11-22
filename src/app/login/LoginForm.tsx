"use client";

import { useId, useState, type FormEvent } from "react";
import { Eye, EyeOff, LockKeyhole, LogIn, Mail, TriangleAlert } from "lucide-react";
import { Button, Field, IconButton, Input } from "@/components/ui";
import { api, isApiClientError } from "@/lib/client/api";

interface LoginFormProps {
  /** Ruta interna ya saneada en el servidor (nunca /login). */
  next: string;
}

/** Datos que el formulario trae puestos: los de la cuenta de demostración (DEMO_STAFF). */
const DEMO_EMAIL = "demo@vigia.local";
const DEMO_PASSWORD = "demo";

function messageFor(err: unknown): string {
  if (!isApiClientError(err)) return "No pudimos iniciar sesión. Intenta de nuevo.";
  switch (err.code) {
    case "network":
      return "Sin conexión. Revisa tu red e intenta de nuevo.";
    case "aborted":
      return "Se canceló el intento. Vuelve a intentarlo.";
    default:
      return "El servidor no pudo iniciar tu sesión. Intenta de nuevo en un momento.";
  }
}

/**
 * Maqueta para la demo: el servidor deja entrar con cualquier dato, incluso con los campos
 * vacíos, así que aquí no se valida nada.
 */
export function LoginForm({ next }: LoginFormProps) {
  const ids = useId();
  const emailId = `${ids}-email`;
  const passwordId = `${ids}-password`;
  const errorId = `${ids}-error`;

  const [email, setEmail] = useState(DEMO_EMAIL);
  const [password, setPassword] = useState(DEMO_PASSWORD);
  const [showPassword, setShowPassword] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await api.auth.login({ email: email.trim(), password });
      // Navegación completa: el proxy y las páginas del servidor ven la cookie nueva.
      window.location.assign(next);
    } catch (err) {
      setError(messageFor(err));
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="mt-6 space-y-5" aria-describedby={error ? errorId : undefined}>
      {error ? (
        <div
          id={errorId}
          role="alert"
          className="flex gap-2 rounded-md border border-critical/50 bg-critical-soft px-3 py-2.5 text-sm text-text"
        >
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-critical" />
          <p>
            <span className="sr-only">Error: </span>
            {error}
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
          size="lg"
          icon={Mail}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="nombre@bomberos.cl"
        />
      </Field>

      <Field label="Contraseña" htmlFor={passwordId}>
        <div className="flex gap-2">
          <Input
            id={passwordId}
            name="password"
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            size="lg"
            icon={LockKeyhole}
            className="flex-1"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <IconButton
            icon={showPassword ? EyeOff : Eye}
            label={showPassword ? "Ocultar contraseña" : "Mostrar contraseña"}
            variant="secondary"
            size="lg"
            active={showPassword}
            aria-controls={passwordId}
            onClick={() => setShowPassword((v) => !v)}
          />
        </div>
      </Field>

      <Button type="submit" variant="primary" size="lg" icon={LogIn} loading={pending} autoFocus fullWidth>
        {pending ? "Ingresando…" : "Ingresar como administrador"}
      </Button>
      <p className="sr-only" aria-live="polite">
        {pending ? "Ingresando…" : ""}
      </p>
    </form>
  );
}
