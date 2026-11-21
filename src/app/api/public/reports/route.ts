import { getStaff } from "@/lib/auth";
import type { CreateReportResponse } from "@/lib/contract";
import { CreateReportInputSchema } from "@/lib/domain";
import { clientIp, ok, rateLimit, readJson, route } from "@/lib/http";
import { createReport } from "@/lib/server/reports";
import { getFiles, getStore } from "@/lib/store";

export const runtime = "nodejs";

/** POST /api/public/reports — registra el envío de un vecino y devuelve los destinos de subida. */
export const POST = route(async (req) => {
  rateLimit(`public-report:${clientIp(req)}`, 12, 10 * 60 * 1000);
  const input = await readJson(req, CreateReportInputSchema);
  // La sesión solo importa para registrar el medio como "responder" (video recibido por el mando).
  const staff = input.as_responder ? await getStaff() : null;
  const res = await createReport(input, { staff, store: getStore(), files: getFiles() });
  return ok<CreateReportResponse>(res, { status: 201 });
});
