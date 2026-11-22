/**
 * Sesión del personal (servidor). Firmas compartidas entre sesiones (ver .coord/CONTEXT.md):
 *   getStaff(): Promise<StaffPublic | null>
 *   requireStaff(): Promise<StaffPublic>   → lanza errors.unauthorized()
 *   requireAdmin(): Promise<StaffPublic>   → lanza errors.forbidden()
 *
 * Modo open (sin DATABASE_URL): siempre la sesión de demostración.
 * Modo staff: cookie `__session` firmada + cuenta activa en la tabla staff.
 */
import { cache } from "react";
import { cookies } from "next/headers";
import type { StaffPublic } from "@/lib/contract";
import { isPostgresConfigured } from "@/lib/config";
import { errors } from "@/lib/http";
import { SESSION_COOKIE, getSessionSecret, verifySessionToken } from "@/lib/auth/session";
import { findActiveStaffById, toStaffPublic } from "@/lib/auth/staff-db";

export const DEMO_STAFF: StaffPublic = {
  id: "demo",
  email: "demo@vigia.local",
  name: "Demo",
  role: "admin",
  demo: true,
};

/** Memoizado por request (React cache): varias llamadas en un render consultan una sola vez. */
export const getStaff = cache(async (): Promise<StaffPublic | null> => {
  if (!isPostgresConfigured()) return { ...DEMO_STAFF };
  const secret = getSessionSecret();
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const payload = await verifySessionToken(token, secret);
  if (!payload) return null;
  const staff = await findActiveStaffById(payload.sid);
  return staff ? toStaffPublic(staff) : null;
});

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
