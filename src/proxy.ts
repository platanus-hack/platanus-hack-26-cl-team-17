/**
 * Proxy (ex middleware) de Next 16.
 *
 * MAQUETA PARA LA DEMO: solo decide si se muestra la pantalla de login, no protege nada
 * (ver src/lib/auth.ts). En modo staff (DATABASE_URL definido), quien entra a /mando/** sin
 * una cookie de sesión vigente (firma HMAC + vencimiento, sin consultar la base) pasa por
 * /login?next=<ruta>, donde cualquier dato lo deja entrar como administrador.
 * Modo open: deja pasar todo.
 */
import { NextResponse, type NextRequest } from "next/server";
import { config as appConfig } from "@/lib/config";
import { sanitizeNextPath } from "@/lib/auth/next-path";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth/session";

export async function proxy(request: NextRequest) {
  if (!appConfig.databaseUrl) return NextResponse.next();

  const secret = appConfig.sessionSecret;
  if (!secret) {
    // Sin secreto el login no puede emitir la cookie: redirigir dejaría a todos dando vueltas
    // entre /mando y /login. Se deja pasar; getStaff() entrega la sesión de demostración.
    console.error("[proxy] Falta VIGIA_SESSION_SECRET con DATABASE_URL definido: /mando queda sin pantalla de login.");
    return NextResponse.next();
  }
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (await verifySessionToken(token, secret)) return NextResponse.next();

  const { pathname, search } = request.nextUrl;
  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  url.searchParams.set("next", sanitizeNextPath(pathname + search));
  return NextResponse.redirect(url);
}

export const config = {
  // Solo el puesto de mando: quedan fuera /api/**, /_next/**, estáticos y las vistas públicas.
  matcher: ["/mando", "/mando/:path*"],
};
