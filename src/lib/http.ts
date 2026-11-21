/**
 * Utilidades compartidas para los route handlers de /api.
 *
 * Uso típico:
 *
 *   export const POST = route(async (req, ctx) => {
 *     const { id } = await ctx.params;          // en Next 16 `params` es una Promise
 *     await requireStaff();
 *     const body = await readJson(req, AddCommInputSchema);
 *     ...
 *     return ok({ entry });
 *   });
 */
import { NextResponse } from "next/server";
import type { z } from "zod";
import type { ApiError } from "./contract";
import { StoreNotFoundError } from "./store/types";

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: ApiError["code"],
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const errors = {
  unauthorized: (msg = "Debes iniciar sesión.") => new HttpError(401, "unauthorized", msg),
  forbidden: (msg = "No tienes permiso para esta acción.") => new HttpError(403, "forbidden", msg),
  notFound: (msg = "No encontrado.") => new HttpError(404, "not_found", msg),
  invalid: (msg = "Solicitud inválida.", details?: unknown) =>
    new HttpError(400, "invalid", msg, details),
  tooLarge: (msg = "El archivo supera el tamaño permitido.") => new HttpError(413, "too_large", msg),
  rateLimited: (msg = "Demasiadas solicitudes. Intenta en un momento.") =>
    new HttpError(429, "rate_limited", msg),
  conflict: (msg = "Conflicto con el estado actual.") => new HttpError(409, "conflict", msg),
};

/** Respuesta JSON sin caché (todos los datos de la plataforma son en vivo). */
export function ok<T>(data: T, init?: { status?: number; headers?: Record<string, string> }) {
  return NextResponse.json(data, {
    status: init?.status ?? 200,
    headers: { "Cache-Control": "no-store", ...(init?.headers ?? {}) },
  });
}

export function fail(err: unknown) {
  if (err instanceof HttpError) {
    const body: ApiError = { error: err.message, code: err.code, details: err.details };
    return NextResponse.json(body, { status: err.status, headers: { "Cache-Control": "no-store" } });
  }
  if (err instanceof StoreNotFoundError) {
    const body: ApiError = { error: err.message, code: "not_found" };
    return NextResponse.json(body, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  console.error("[api] error no controlado:", err);
  const body: ApiError = { error: "Error interno del servidor.", code: "internal" };
  return NextResponse.json(body, { status: 500, headers: { "Cache-Control": "no-store" } });
}

/** Contexto de ruta de Next 16: `params` es asíncrono. */
export interface RouteCtx<P extends Record<string, string | string[]> = Record<string, string>> {
  params: Promise<P>;
}

/** Envuelve un handler para convertir excepciones en respuestas `ApiError`. */
export function route<P extends Record<string, string | string[]> = Record<string, string>>(
  handler: (req: Request, ctx: RouteCtx<P>) => Promise<Response>,
) {
  return async (req: Request, ctx: RouteCtx<P>): Promise<Response> => {
    try {
      return await handler(req, ctx);
    } catch (err) {
      return fail(err);
    }
  };
}

/** Lee y valida el cuerpo JSON con un esquema Zod; lanza 400 con el detalle si no calza. */
export async function readJson<S extends z.ZodType>(req: Request, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw errors.invalid("El cuerpo debe ser JSON válido.");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw errors.invalid("Datos inválidos.", parsed.error.issues);
  }
  return parsed.data;
}

/** Extrae el token de `Authorization: Bearer <token>`; null si no viene. */
export function bearerToken(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

/** IP del cliente para límites simples por origen. */
export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  // Cloud Run agrega la IP real al final; las primeras entradas las puede inventar el cliente.
  if (fwd) return fwd.split(",").pop()!.trim();
  return req.headers.get("x-real-ip") ?? "local";
}

/**
 * Límite de tasa en memoria (por instancia). En serverless es una defensa
 * de mejor esfuerzo, no una garantía: suficiente para frenar abuso trivial.
 */
const buckets = new Map<string, { count: number; resetAt: number }>();
export function rateLimit(key: string, max: number, windowMs: number): void {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    if (buckets.size > 5000) {
      for (const [k, v] of buckets) if (v.resetAt < now) buckets.delete(k);
    }
    return;
  }
  b.count += 1;
  if (b.count > max) throw errors.rateLimited();
}
