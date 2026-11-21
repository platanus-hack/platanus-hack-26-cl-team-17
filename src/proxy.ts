/**
 * Proxy (ex middleware) de Next 16.
 *
 * Modo staff (DATABASE_URL definido): quien entra a /mando/** sin una cookie de sesión
 * válida (firma HMAC + vencimiento, sin consultar la base) va a /login?next=<ruta>.
 * Modo open: deja pasar todo.
 *
 * No es la barrera de seguridad: las rutas /api y las páginas llaman requireStaff().
 */
import { NextResponse, type NextRequest } from "next/server";
import { config as appConfig } from "@/lib/config";
import { sanitizeNextPath } from "@/lib/auth/next-path";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth/session";

export async function proxy(request: NextRequest) {
  if (!appConfig.databaseUrl) return NextResponse.next();

  const secret = appConfig.sessionSecret;
  if (!secret) {
    // Sin secreto no puede existir una sesión válida; el login muestra el error de configuración.
    console.error("[proxy] Falta VIGIA_SESSION_SECRET con DATABASE_URL definido.");
  } else {
    const token = request.cookies.get(SESSION_COOKIE)?.value;
    if (await verifySessionToken(token, secret)) return NextResponse.next();
  }

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
