/**
 * Esquemas de entrada de las rutas de personal (contrato: LoginRequest, CreateStaffRequest).
 */
import { z } from "zod";
import type { CreateStaffRequest, LoginRequest, StaffRole } from "@/lib/contract";

export const STAFF_ROLES = ["admin", "officer", "operator"] as const satisfies readonly StaffRole[];
export const MIN_PASSWORD_LENGTH = 10;
/** Tope de largo: evita gastar CPU de scrypt en cuerpos enormes. */
export const MAX_PASSWORD_LENGTH = 256;

/** trim + minúsculas: los correos se guardan siempre en minúsculas. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

const emailField = z
  .string({ error: "Ingresa tu correo." })
  .trim()
  .toLowerCase()
  .min(1, "Ingresa tu correo.")
  .max(254, "El correo es demasiado largo.");

export const LoginSchema = z.object({
  email: emailField,
  password: z
    .string({ error: "Ingresa tu contraseña." })
    .min(1, "Ingresa tu contraseña.")
    .max(MAX_PASSWORD_LENGTH, "La contraseña es demasiado larga."),
});

export const CreateStaffSchema = z.object({
  email: emailField.pipe(z.email("El correo no es válido.")),
  name: z
    .string({ error: "Ingresa el nombre." })
    .trim()
    .min(1, "Ingresa el nombre.")
    .max(120, "El nombre es demasiado largo."),
  role: z.enum(STAFF_ROLES, { error: "Elige un rol: admin, officer u operator." }),
  password: z
    .string({ error: "Ingresa una contraseña inicial." })
    .min(MIN_PASSWORD_LENGTH, `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`)
    .max(MAX_PASSWORD_LENGTH, "La contraseña es demasiado larga."),
});

// Chequeo en compilación: lo validado calza con los DTO del contrato.
type Assignable<T, U> = T extends U ? true : never;
const _loginMatches: Assignable<z.infer<typeof LoginSchema>, LoginRequest> = true;
const _createMatches: Assignable<z.infer<typeof CreateStaffSchema>, CreateStaffRequest> = true;
void _loginMatches;
void _createMatches;
