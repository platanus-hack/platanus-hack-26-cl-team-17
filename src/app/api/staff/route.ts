/**
 * GET  /api/staff   (admin) → { staff: StaffPublic[] }
 * POST /api/staff   (admin) CreateStaffRequest → { staff: StaffPublic }
 *
 * En modo open no hay base de datos de personal: la lista es solo la cuenta de
 * demostración y crear cuentas responde conflicto con una explicación.
 */
import { DEMO_STAFF, requireAdmin } from "@/lib/auth";
import { CreateStaffSchema } from "@/lib/auth/schemas";
import { StaffEmailTakenError, createStaff, listStaff, toStaffPublic } from "@/lib/auth/staff-db";
import type { StaffPublic } from "@/lib/contract";
import { isPostgresConfigured } from "@/lib/config";
import { errors, ok, readJson, route } from "@/lib/http";

export const runtime = "nodejs";

export const GET = route(async () => {
  await requireAdmin();
  if (!isPostgresConfigured()) return ok<{ staff: StaffPublic[] }>({ staff: [{ ...DEMO_STAFF }] });
  const rows = await listStaff();
  return ok<{ staff: StaffPublic[] }>({ staff: rows.map(toStaffPublic) });
});

export const POST = route(async (req) => {
  await requireAdmin();
  const body = await readJson(req, CreateStaffSchema);
  if (!isPostgresConfigured()) {
    throw errors.conflict(
      "En modo local no hay base de datos de personal: configura DATABASE_URL para crear cuentas.",
    );
  }
  try {
    const created = await createStaff(body);
    return ok<{ staff: StaffPublic }>({ staff: toStaffPublic(created) }, { status: 201 });
  } catch (err) {
    if (err instanceof StaffEmailTakenError) throw errors.conflict("Ya existe una cuenta con ese correo.");
    throw err;
  }
});
