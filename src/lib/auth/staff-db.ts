/**
 * Acceso a la tabla `staff` (Postgres). Solo servidor (Node). La interfaz Store no
 * maneja personal: estas funciones consultan directo con el pool compartido.
 */
import type { StaffPublic, StaffRole } from "@/lib/contract";
import { config } from "@/lib/config";
import { safeEqual, sha256Hex } from "@/lib/ids";
import { getPool } from "@/lib/store/pg-pool";
import { ensureMigrated } from "@/lib/store/pg-migrate";
import { dummyVerify, hashPassword, verifyPassword } from "./password";
import { normalizeEmail } from "./schemas";

export interface StaffRecord {
  id: string;
  email: string;
  name: string;
  role: StaffRole;
  active: boolean;
  created_at: string;
  last_login_at: string | null;
}

interface StaffRow extends StaffRecord {
  password_hash: string;
}

/** El correo ya está registrado (violación de la restricción única). */
export class StaffEmailTakenError extends Error {
  constructor(email: string) {
    super(`Ya existe una cuenta con el correo ${email}.`);
    this.name = "StaffEmailTakenError";
  }
}

export const BOOTSTRAP_ADMIN_NAME = "Administración";

const COLUMNS = "id, email, name, role, active, password_hash, created_at, last_login_at";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function iso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

function rowToStaff(r: Record<string, unknown>): StaffRow {
  return {
    id: String(r.id),
    email: String(r.email),
    name: String(r.name),
    role: r.role as StaffRole,
    active: Boolean(r.active),
    password_hash: String(r.password_hash),
    created_at: iso(r.created_at),
    last_login_at: r.last_login_at == null ? null : iso(r.last_login_at),
  };
}

function withoutHash(row: StaffRow): StaffRecord {
  const { password_hash: _omit, ...rest } = row;
  void _omit;
  return rest;
}

export function toStaffPublic(s: Pick<StaffRecord, "id" | "email" | "name" | "role">): StaffPublic {
  return { id: s.id, email: s.email, name: s.name, role: s.role, demo: false };
}

async function db() {
  await ensureMigrated();
  return getPool();
}

async function findRowByEmail(email: string): Promise<StaffRow | null> {
  const pool = await db();
  const res = await pool.query(`select ${COLUMNS} from staff where email = $1`, [normalizeEmail(email)]);
  return res.rows[0] ? rowToStaff(res.rows[0]) : null;
}

/** Busca por correo sin distinguir mayúsculas. Incluye cuentas inactivas. */
export async function findStaffByEmail(email: string): Promise<StaffRecord | null> {
  const row = await findRowByEmail(email);
  return row ? withoutHash(row) : null;
}

/** Cuenta activa por id; null si no existe, está inactiva o el id no es un uuid. */
export async function findActiveStaffById(id: string): Promise<StaffRecord | null> {
  if (!UUID_RE.test(id)) return null;
  const pool = await db();
  const res = await pool.query(`select ${COLUMNS} from staff where id = $1 and active`, [id]);
  return res.rows[0] ? withoutHash(rowToStaff(res.rows[0])) : null;
}

/** Todo el personal, por nombre. */
export async function listStaff(): Promise<StaffRecord[]> {
  const pool = await db();
  const res = await pool.query(`select ${COLUMNS} from staff order by lower(name), email`);
  return res.rows.map((r: Record<string, unknown>) => withoutHash(rowToStaff(r)));
}

export interface NewStaff {
  email: string;
  name: string;
  role: StaffRole;
  password: string;
}

/** Crea una cuenta activa. Lanza StaffEmailTakenError si el correo ya existe. */
export async function createStaff(input: NewStaff): Promise<StaffRecord> {
  const email = normalizeEmail(input.email);
  const passwordHash = await hashPassword(input.password);
  const pool = await db();
  try {
    const res = await pool.query(
      `insert into staff (email, name, role, password_hash) values ($1, $2, $3, $4) returning ${COLUMNS}`,
      [email, input.name.trim(), input.role, passwordHash],
    );
    return withoutHash(rowToStaff(res.rows[0]));
  } catch (err) {
    if ((err as { code?: string }).code === "23505") throw new StaffEmailTakenError(email);
    throw err;
  }
}

/**
 * Cuenta administradora inicial: si VIGIA_ADMIN_EMAIL/VIGIA_ADMIN_PASSWORD están definidos,
 * el login usa exactamente esas credenciales y el correo aún no existe, la crea como admin.
 * Seguro ante logins simultáneos (ON CONFLICT DO NOTHING). Devuelve true si la insertó.
 */
export async function ensureBootstrapAdmin(email: string, password: string): Promise<boolean> {
  const adminEmail = config.adminEmail;
  const adminPassword = config.adminPassword;
  if (!adminEmail || !adminPassword) return false;
  // Se comparan hashes para no filtrar el largo de la contraseña por tiempo.
  const matches =
    normalizeEmail(email) === adminEmail && safeEqual(sha256Hex(password), sha256Hex(adminPassword));
  if (!matches) return false;
  const pool = await db();
  const exists = await pool.query("select 1 from staff where email = $1", [adminEmail]);
  if (exists.rowCount) return false;
  const passwordHash = await hashPassword(adminPassword);
  const res = await pool.query(
    `insert into staff (email, name, role, password_hash) values ($1, $2, 'admin', $3)
     on conflict (email) do nothing`,
    [adminEmail, BOOTSTRAP_ADMIN_NAME, passwordHash],
  );
  if (res.rowCount) console.info(`[auth] cuenta administradora inicial creada: ${adminEmail}`);
  return Boolean(res.rowCount);
}

/**
 * Valida credenciales. Devuelve la cuenta (activa) o null, sin distinguir la causa.
 * Si el correo no existe hace una verificación de relleno para igualar el tiempo.
 * Registra last_login_at en un login correcto.
 */
export async function authenticate(email: string, password: string): Promise<StaffRecord | null> {
  await ensureBootstrapAdmin(email, password);
  const row = await findRowByEmail(email);
  if (!row) {
    await dummyVerify(password);
    return null;
  }
  const valid = await verifyPassword(password, row.password_hash);
  if (!valid || !row.active) return null;
  const pool = await db();
  const res = await pool.query("update staff set last_login_at = now() where id = $1 returning last_login_at", [
    row.id,
  ]);
  const lastLogin = res.rows[0]?.last_login_at;
  return { ...withoutHash(row), last_login_at: lastLogin == null ? null : iso(lastLogin) };
}
