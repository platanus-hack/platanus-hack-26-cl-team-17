/**
 * Sesión del personal (servidor). Firmas compartidas entre sesiones (ver .coord/CONTEXT.md):
 *   getStaff(): Promise<StaffPublic | null>
 *   requireStaff(): Promise<StaffPublic>
 *   requireAdmin(): Promise<StaffPublic>   → lanza errors.forbidden()
 *
 * MAQUETA PARA LA DEMO: el inicio de sesión no protege nada. Quien llega sin sesión entra
 * como la cuenta administradora de demostración, así el jurado abre el puesto de mando sin
 * pedir una cuenta. Todo lo que está detrás de requireStaff() queda abierto a internet.
 *
 * Modo open (sin DATABASE_URL): siempre la sesión de demostración.
 * Modo staff: una cookie `__session` vigente de una cuenta real y activa conserva su nombre
 * y su rol; en cualquier otro caso, la sesión de demostración.
 */
import { cache } from "react";
import { cookies } from "next/headers";
import type { StaffPublic } from "@/lib/contract";
import { config, isPostgresConfigured } from "@/lib/config";
import { errors } from "@/lib/http";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth/session";
import { findActiveStaffById, toStaffPublic } from "@/lib/auth/staff-db";

export const DEMO_STAFF: StaffPublic = {
  id: "demo",
  email: "demo@vigia.local",
  name: "Demo",
  role: "admin",
  demo: true,
};

/**
 * Memoizado por request (React cache): varias llamadas en un render consultan una sola vez.
 * Nunca devuelve null (la firma lo conserva por los llamadores que aún lo revisan).
 */
export const getStaff = cache(async (): Promise<StaffPublic | null> => {
  if (!isPostgresConfigured()) return { ...DEMO_STAFF };
  const secret = config.sessionSecret;
  // cookies() va fuera del try: Next la usa para marcar la ruta como dinámica.
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const payload = secret ? await verifySessionToken(token, secret) : null;
  if (payload && payload.sid !== DEMO_STAFF.id) {
    try {
      const staff = await findActiveStaffById(payload.sid);
      if (staff) return toStaffPublic(staff);
    } catch (err) {
      console.warn("[auth] no se pudo leer la cuenta de la sesión; sigue como demostración:", err);
    }
  }
  return { ...DEMO_STAFF };
});

/**
 * true si la petición trae una cookie de sesión vigente (mismo criterio que src/proxy.ts).
 * La pantalla de login la usa para no mostrarse dos veces; getStaff() no sirve para eso
 * porque siempre devuelve a alguien.
 */
export async function hasSessionCookie(): Promise<boolean> {
  const secret = config.sessionSecret;
  if (!secret) return false;
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return Boolean(await verifySessionToken(token, secret));
}

export async function requireStaff(): Promise<StaffPublic> {
  const staff = await getStaff();
  if (!staff) throw errors.unauthorized();
  return staff;
}

export async function requireAdmin(): Promise<StaffPublic> {
  const staff = await requireStaff();
  if (staff.role !== "admin") throw errors.forbidden("Solo una cuenta administradora puede hacer esto.");
  return staff;
}
