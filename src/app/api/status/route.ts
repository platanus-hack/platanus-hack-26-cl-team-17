/**
 * GET /api/status → { mode: RuntimeMode }
 * Público: la UI (vecinos incluidos) lo usa para mostrar siempre el modo de la
 * instancia (local, IA simulada, acceso abierto). No revela secretos.
 */
import type { RuntimeMode } from "@/lib/contract";
import { runtimeMode } from "@/lib/config";
import { ok, route } from "@/lib/http";

export const runtime = "nodejs";

export const GET = route(async () => ok<{ mode: RuntimeMode }>({ mode: runtimeMode() }));
