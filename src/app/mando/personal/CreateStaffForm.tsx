"use client";

import { useId, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { CircleCheck, Eye, EyeOff, RefreshCw, TriangleAlert, UserPlus } from "lucide-react";
import { Button, CopyButton, Field, IconButton, Input, Panel, Select, fieldMessageIds, useToast } from "@/components/ui";
import { api, isApiClientError } from "@/lib/client/api";
import type { CreateStaffRequest, StaffRole } from "@/lib/contract";
import { staffRoleLabel } from "@/lib/labels";

const ROLES: StaffRole[] = ["officer", "operator", "admin"];
const ROLE_OPTIONS = ROLES.map((r) => ({ value: r, label: staffRoleLabel[r] }));

type FieldName = keyof CreateStaffRequest;
type FieldErrors = Partial<Record<FieldName, string>>;

/** Sin caracteres ambiguos (0/O, 1/l/I) para dictarla por teléfono o radio. */
const PASSWORD_ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generatePassword(length = 14): string {
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => PASSWORD_ALPHABET[b % PASSWORD_ALPHABET.length]).join("");
}

function validate(v: CreateStaffRequest): FieldErrors {
  const e: FieldErrors = {};
  if (!v.name.trim()) e.name = "Ingresa el nombre.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email.trim())) e.email = "Ingresa un correo válido.";
  if (!v.password) e.password = "Ingresa una contraseña inicial.";
  return e;
}

/** Traduce los `details` de Zod que devuelve la API a errores por campo. */
function serverFieldErrors(details: unknown): FieldErrors {
  const out: FieldErrors = {};
  if (!Array.isArray(details)) return out;
  for (const issue of details) {
    if (!issue || typeof issue !== "object") continue;
    const { path, message } = issue as { path?: unknown; message?: unknown };
    const key: unknown = Array.isArray(path) ? path[0] : undefined;
    if ((key === "email" || key === "name" || key === "role" || key === "password") && typeof message === "string") {
      out[key] ??= message;
    }
  }
  return out;
}

const EMPTY: CreateStaffRequest = { name: "", email: "", role: "officer", password: "" };

/** Alta de una cuenta del personal. Al crearla muestra una vez la contraseña inicial para entregarla. */
export function CreateStaffForm() {
  const router = useRouter();
  const { toast } = useToast();
  const uid = useId();
  const id = (f: FieldName) => `${uid}-${f}`;

  const [values, setValues] = useState<CreateStaffRequest>(EMPTY);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [pending, setPending] = useState(false);
  const [created, setCreated] = useState<{ name: string; email: string; password: string } | null>(null);

  const set = <K extends FieldName>(key: K, value: CreateStaffRequest[K]) => {
    setValues((v) => ({ ...v, [key]: value }));
    if (errors[key]) setErrors((e) => ({ ...e, [key]: undefined }));
  };

  async function onSubmit(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    if (pending) return;
    const body: CreateStaffRequest = { ...values, name: values.name.trim(), email: values.email.trim() };
    const local = validate(body);
    setErrors(local);
    setFormError(null);
    if (Object.keys(local).length > 0) return;
    setPending(true);
    try {
      const { staff } = await api.staff.create(body);
      setCreated({ name: staff.name, email: staff.email, password: body.password });
      setValues(EMPTY);
      setShowPassword(false);
      toast({ title: "Cuenta creada", description: `${staff.name} ya puede ingresar.`, tone: "ok", icon: CircleCheck });
      router.refresh();
    } catch (err) {
      if (isApiClientError(err) && err.code === "invalid") {
        const fields = serverFieldErrors(err.details);
        setErrors(fields);
        setFormError(Object.keys(fields).length ? null : err.message);
      } else if (isApiClientError(err) && err.code === "conflict") {
        // 409 es correo repetido; en modo local también llega como 409 (sin base de datos de personal).
        if (/correo/i.test(err.message)) setErrors({ email: err.message });
        else setFormError(err.message);
      } else if (isApiClientError(err) && err.code === "forbidden") {
        setFormError("Tu cuenta ya no es administradora. Recarga la página.");
      } else if (isApiClientError(err) && err.code === "network") {
        setFormError("Sin conexión. Revisa tu red e intenta de nuevo.");
      } else {
        setFormError("No pudimos crear la cuenta. Intenta de nuevo en un momento.");
      }
    } finally {
      setPending(false);
    }
  }

  if (created) {
    return (
      <Panel title="Cuenta creada" icon={CircleCheck} tone="ok">
        <div className="space-y-4">
          <p className="text-sm text-text">
            Entrégale a <strong>{created.name}</strong> estos datos por un canal seguro. La contraseña no se vuelve a
            mostrar.
          </p>
          <dl className="space-y-3 rounded-md border border-line bg-surface-2 p-3">
            <div>
              <dt className="label-caps text-xs text-muted">Correo</dt>
              <dd className="flex items-center justify-between gap-2 font-mono text-sm break-all text-text">
                {created.email}
                <CopyButton value={created.email} iconOnly size="sm" label="Copiar correo" />
              </dd>
            </div>
            <div>
              <dt className="label-caps text-xs text-muted">Contraseña inicial</dt>
              <dd className="flex items-center justify-between gap-2 font-mono text-sm break-all text-text">
                {created.password}
                <CopyButton value={created.password} iconOnly size="sm" label="Copiar contraseña" />
              </dd>
            </div>
          </dl>
          <Button variant="secondary" icon={UserPlus} fullWidth onClick={() => setCreated(null)}>
            Crear otra cuenta
          </Button>
        </div>
      </Panel>
    );
  }

  const describedBy = (f: FieldName, hint = false) =>
    [errors[f] ? fieldMessageIds(id(f)).error : "", hint ? fieldMessageIds(id(f)).hint : ""].filter(Boolean).join(" ") ||
    undefined;

  return (
    <Panel title="Nueva cuenta" icon={UserPlus}>
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        {formError ? (
          <div role="alert" className="flex gap-2 rounded-md border border-critical/50 bg-critical-soft px-3 py-2.5 text-sm text-text">
            <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-critical" />
            <p>{formError}</p>
          </div>
        ) : null}

        <Field label="Nombre" htmlFor={id("name")} error={errors.name} required>
          <Input
            id={id("name")}
            value={values.name}
            onChange={(e) => set("name", e.target.value)}
            autoComplete="off"
            maxLength={120}
            invalid={Boolean(errors.name)}
            aria-describedby={describedBy("name")}
            placeholder="Teniente Rocío Soto"
          />
        </Field>

        <Field label="Correo" htmlFor={id("email")} error={errors.email} required>
          <Input
            id={id("email")}
            type="email"
            inputMode="email"
            autoCapitalize="none"
            spellCheck={false}
            autoComplete="off"
            value={values.email}
            onChange={(e) => set("email", e.target.value)}
            maxLength={254}
            invalid={Boolean(errors.email)}
            aria-describedby={describedBy("email")}
            placeholder="nombre@bomberos.cl"
          />
        </Field>

        <Field label="Rol" htmlFor={id("role")} error={errors.role} hint="Solo «Administrador» puede gestionar cuentas.">
          <Select
            id={id("role")}
            options={ROLE_OPTIONS}
            value={values.role}
            onChange={(e) => set("role", e.target.value as StaffRole)}
            invalid={Boolean(errors.role)}
            aria-describedby={describedBy("role", true)}
          />
        </Field>

        <Field
          label="Contraseña inicial"
          htmlFor={id("password")}
          error={errors.password}
          hint="Se muestra una vez al crear la cuenta."
          required
        >
          <div className="flex gap-2">
            <Input
              id={id("password")}
              type={showPassword ? "text" : "password"}
              autoComplete="new-password"
              value={values.password}
              onChange={(e) => set("password", e.target.value)}
              maxLength={256}
              invalid={Boolean(errors.password)}
              aria-describedby={describedBy("password", true)}
              className="flex-1 font-mono"
            />
            <IconButton
              icon={showPassword ? EyeOff : Eye}
              label={showPassword ? "Ocultar contraseña" : "Mostrar contraseña"}
              variant="secondary"
              active={showPassword}
              onClick={() => setShowPassword((v) => !v)}
            />
            <IconButton
              icon={RefreshCw}
              label="Generar una contraseña segura"
              variant="secondary"
              onClick={() => {
                set("password", generatePassword());
                setShowPassword(true);
              }}
            />
          </div>
        </Field>

        <Button type="submit" variant="primary" icon={UserPlus} loading={pending} fullWidth>
          {pending ? "Creando cuenta…" : "Crear cuenta"}
        </Button>
      </form>
    </Panel>
  );
}
