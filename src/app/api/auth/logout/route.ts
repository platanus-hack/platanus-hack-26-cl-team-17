/**
 * POST /api/auth/logout   → { ok: true }
 * Borra la cookie de sesión. En modo open no hay sesión que cerrar, pero responde igual.
 */
import { SESSION_COOKIE, clearedSessionCookieOptions } from "@/lib/auth/session";
import { ok, route } from "@/lib/http";

export const runtime = "nodejs";

export const POST = route(async (req) => {
  const res = ok<{ ok: true }>({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", clearedSessionCookieOptions(req));
  return res;
});
