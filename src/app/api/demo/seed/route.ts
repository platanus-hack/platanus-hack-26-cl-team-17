/**
 * POST /api/demo/seed → { incident_id }
 * Siembra las vitrinas de demostración (idempotente) y devuelve la principal.
 */
import { requireStaff } from "@/lib/auth";
import { seedDemo } from "@/lib/demo";
import { ok, route } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 900;

export const POST = route(async () => {
  await requireStaff();
  return ok(await seedDemo());
});
