/**
 * GET /api/public/incidents/[code]/pedidos?v=<pestaña>   → { requests: PublicVideoRequest[] }
 *
 * Pedidos de video de Vigía para quienes tienen abierta la página de grabación
 * ("Bomberos necesita un video del lado C, desde la vereda. Sin acercarse."). Sin sesión.
 * `v` identifica la pestaña (aleatorio, sin datos personales) para contar a cuántas
 * personas les llegó el pedido.
 */
import { clientIp, ok, rateLimit, route } from "@/lib/http";
import { findOpenIncidentByCode } from "@/lib/server/reports";
import { getFiles, getStore } from "@/lib/store";
import { notePublicViewer } from "@/lib/vigia/audience";
import { getVigiaState } from "@/lib/vigia/state-store";
import type { PublicVideoRequest } from "@/lib/vigia/types";
import { publicVideoRequests } from "@/lib/vigia/view";

export const runtime = "nodejs";

export const GET = route<{ code: string }>(async (req, ctx) => {
  const { code } = await ctx.params;
  rateLimit(`vigia-pedidos:${clientIp(req)}`, 60, 60_000);
  const incident = await findOpenIncidentByCode(decodeURIComponent(code), { store: getStore(), files: getFiles() });
  const viewer = new URL(req.url).searchParams.get("v");
  if (viewer && /^[a-zA-Z0-9-]{6,64}$/.test(viewer)) notePublicViewer(incident.id, viewer);
  const requests = publicVideoRequests(await getVigiaState(incident.id), Date.now());
  return ok<{ requests: PublicVideoRequest[] }>({ requests });
});
