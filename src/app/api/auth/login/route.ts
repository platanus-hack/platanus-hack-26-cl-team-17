/**
 * POST /api/auth/login   LoginRequest → { staff: StaffPublic }
 *
 * Modo staff: valida credenciales contra la tabla staff y deja la cookie de sesión.
 * Modo open (sin base de datos): no hay cuentas; responde la sesión de demostración
 * para que el cliente siga a su destino.
 */
import { DEMO_STAFF } from "@/lib/auth";
import { assertLoginAllowed, clearLoginFailures, recordLoginFailure } from "@/lib/auth/login-throttle";
import { LoginSchema } from "@/lib/auth/schemas";
import { SESSION_COOKIE, createSessionToken, getSessionSecret, sessionCookieOptions } from "@/lib/auth/session";
import { authenticate, toStaffPublic } from "@/lib/auth/staff-db";
import type { StaffPublic } from "@/lib/contract";
import { isPostgresConfigured } from "@/lib/config";
import { clientIp, errors, ok, rateLimit, readJson, route } from "@/lib/http";

export const runtime = "nodejs";

const WINDOW_MS = 15 * 60 * 1000;

export const POST = route(async (req) => {
  if (!isPostgresConfigured()) {
    await readJson(req, LoginSchema);
    return ok<{ staff: StaffPublic }>({ staff: { ...DEMO_STAFF } });
  }
  // Falla con un error claro si falta VIGIA_SESSION_SECRET, antes de tocar la base.
  const secret = getSessionSecret();
  rateLimit(`login:ip:${clientIp(req)}`, 30, WINDOW_MS);
  const body = await readJson(req, LoginSchema);
  // Por correo solo cuentan los fallos: entrar bien no acerca a nadie al bloqueo.
  assertLoginAllowed(body.email);

  const account = await authenticate(body.email, body.password);
  if (!account) {
    recordLoginFailure(body.email);
    throw errors.unauthorized("Correo o contraseña incorrectos.");
  }
  clearLoginFailures(body.email);

  const token = await createSessionToken(account.id, secret);
  const res = ok<{ staff: StaffPublic }>({ staff: toStaffPublic(account) });
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(req));
  return res;
});
