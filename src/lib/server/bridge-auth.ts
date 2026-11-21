/**
 * Acceso del puente Zello (tools/zello-bridge) a las rutas del mando. Solo servidor.
 *
 * El puente no tiene sesión de personal: se identifica con `Authorization: Bearer
 * <VIGIA_BRIDGE_TOKEN>`. Sin token configurado, solo funciona en modo local abierto
 * (sin DATABASE_URL), donde las rutas del mando ya están abiertas.
 */
import { timingSafeEqual } from "node:crypto";
import type { StaffPublic } from "@/lib/contract";
import { requireStaff } from "@/lib/auth";
import { config, isPostgresConfigured } from "@/lib/config";
import { bearerToken, errors } from "@/lib/http";

/** Identidad con la que el puente aparece donde se espera una cuenta del personal. */
export const BRIDGE_STAFF: StaffPublic = {
  id: "zello-bridge",
  email: "zello-bridge@vigia.local",
  name: "Puente Zello",
  role: "operator",
  demo: false,
};

/** Compara el token sin filtrar su largo ni su contenido por el tiempo de respuesta. */
export function tokenMatches(given: string | null, expected: string): boolean {
  if (!given || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** true si la petición trae el token interno del puente. */
export function isBridgeRequest(req: Request): boolean {
  return tokenMatches(bearerToken(req), config.bridgeToken);
}

/**
 * true si la petición puede actuar como el puente: con su token, o en modo local
 * abierto sin token configurado (ahí cualquiera puede, como en el resto del mando).
 */
export function mayActAsBridge(req: Request): boolean {
  if (isBridgeRequest(req)) return true;
  return !config.bridgeToken && !isPostgresConfigured();
}

/** El puente con su token, o una sesión del personal. */
export async function requireStaffOrBridge(req: Request): Promise<StaffPublic> {
  if (isBridgeRequest(req)) return BRIDGE_STAFF;
  return requireStaff();
}

/** Solo el puente (ver mayActAsBridge). */
export function requireBridge(req: Request): void {
  if (!mayActAsBridge(req)) {
    throw bearerToken(req) ? errors.forbidden("Token del puente inválido.") : errors.unauthorized("Falta el token del puente.");
  }
}
