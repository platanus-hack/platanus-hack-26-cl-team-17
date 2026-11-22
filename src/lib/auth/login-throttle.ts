/**
 * Límite de intentos FALLIDOS de inicio de sesión por correo (en memoria, por instancia).
 *
 * INACTIVO mientras el login sea una maqueta (src/lib/auth.ts): la ruta de login ya no lo
 * llama, porque nunca rechaza. Se conserva para cuando vuelva el login real.
 *
 * Solo cuentan las contraseñas incorrectas: entrar bien no suma (y además limpia
 * el contador), así que el admin que inicia sesión en varios equipos durante una
 * emergencia no queda bloqueado. Defensa de mejor esfuerzo, como `rateLimit()`.
 */
import { errors } from "@/lib/http";

export const LOGIN_MAX_FAILURES = 10;
export const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const MAX_TRACKED = 5000;

type Entry = { failures: number; resetAt: number };

type GlobalWithThrottle = typeof globalThis & { __vigiaLoginFailures?: Map<string, Entry> };

function table(): Map<string, Entry> {
  const g = globalThis as GlobalWithThrottle;
  g.__vigiaLoginFailures ??= new Map();
  return g.__vigiaLoginFailures;
}

function current(email: string, now: number): Entry | null {
  const e = table().get(email);
  if (!e) return null;
  if (e.resetAt <= now) {
    table().delete(email);
    return null;
  }
  return e;
}

/** Lanza 429 si ese correo ya acumuló el máximo de fallos en la ventana. No suma nada. */
export function assertLoginAllowed(email: string, now = Date.now()): void {
  const e = current(email, now);
  if (e && e.failures >= LOGIN_MAX_FAILURES) {
    throw errors.rateLimited("Demasiados intentos fallidos con este correo. Espera unos minutos.");
  }
}

/** Suma un intento fallido. La ventana parte con el primer fallo. */
export function recordLoginFailure(email: string, now = Date.now()): void {
  const e = current(email, now);
  if (e) {
    e.failures += 1;
    return;
  }
  const t = table();
  if (t.size >= MAX_TRACKED) {
    for (const [k, v] of t) if (v.resetAt <= now) t.delete(k);
  }
  t.set(email, { failures: 1, resetAt: now + LOGIN_FAILURE_WINDOW_MS });
}

/** Inicio de sesión correcto: se olvidan los fallos anteriores. */
export function clearLoginFailures(email: string): void {
  table().delete(email);
}
