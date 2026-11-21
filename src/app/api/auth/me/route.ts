/**
 * GET /api/auth/me   → { staff: StaffPublic | null, mode: RuntimeMode }
 * En modo open devuelve la sesión de demostración.
 */
import { getStaff } from "@/lib/auth";
import type { RuntimeMode, StaffPublic } from "@/lib/contract";
import { runtimeMode } from "@/lib/config";
import { ok, route } from "@/lib/http";

export const runtime = "nodejs";

export const GET = route(async () => {
  const staff = await getStaff();
  return ok<{ staff: StaffPublic | null; mode: RuntimeMode }>({ staff, mode: runtimeMode() });
});
