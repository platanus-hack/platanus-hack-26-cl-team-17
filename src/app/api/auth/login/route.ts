/**
 * POST /api/auth/login   LoginRequest → { staff: StaffPublic }
 *
 * MAQUETA PARA LA DEMO: nunca rechaza. Si el correo y la contraseña son los de una cuenta
 * real, la sesión queda a su nombre; con cualquier otro dato (o sin datos) entra la cuenta
 * administradora de demostración. No hay límite de intentos: el jurado puede compartir una
 * misma IP y nadie debe quedar bloqueado.
 *
 * Modo open (sin base de datos): no hay cuentas ni cookie; responde la sesión de demostración.
 */
import { DEMO_STAFF } from "@/lib/auth";
import { LoginSchema } from "@/lib/auth/schemas";
import { SESSION_COOKIE, createSessionToken, sessionCookieOptions } from "@/lib/auth/session";
import { authenticate, toStaffPublic, type StaffRecord } from "@/lib/auth/staff-db";
import type { StaffPublic } from "@/lib/contract";
import { config, isPostgresConfigured } from "@/lib/config";
import { ok, readJson, route } from "@/lib/http";

export const runtime = "nodejs";

export const POST = route(async (req) => {
  const body = await readJson(req, LoginSchema);
  if (!isPostgresConfigured()) return ok<{ staff: StaffPublic }>({ staff: { ...DEMO_STAFF } });

  let account: StaffRecord | null = null;
  if (body.email && body.password) {
    try {
      account = await authenticate(body.email, body.password);
    } catch (err) {
      console.warn("[auth] no se pudo consultar la cuenta; entra como demostración:", err);
    }
  }

  const staff: StaffPublic = account ? toStaffPublic(account) : { ...DEMO_STAFF };
  const res = ok<{ staff: StaffPublic }>({ staff });
  // La cookie solo evita volver a mostrar el login (src/proxy.ts). Sin secreto no se emite
  // y el proxy deja pasar igual.
  const secret = config.sessionSecret;
  if (secret) res.cookies.set(SESSION_COOKIE, await createSessionToken(staff.id, secret), sessionCookieOptions(req));
  return res;
});
