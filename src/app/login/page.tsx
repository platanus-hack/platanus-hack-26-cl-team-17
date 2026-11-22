import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { hasSessionCookie } from "@/lib/auth";
import { sanitizeNextPath } from "@/lib/auth/next-path";
import { isPostgresConfigured } from "@/lib/config";
import { LoginScreen } from "./LoginScreen";

export const metadata: Metadata = {
  title: "Ingresar",
  robots: { index: false, follow: false },
};

interface LoginPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** Login de maqueta para la demo: cualquier dato entra como administrador (ver src/lib/auth.ts). */
export default async function LoginPage({ searchParams }: LoginPageProps) {
  const sp = await searchParams;
  const rawNext = Array.isArray(sp.next) ? sp.next[0] : sp.next;
  const next = sanitizeNextPath(rawNext);

  // Modo open: no hay cuentas; se entra directo al puesto de mando.
  if (!isPostgresConfigured()) redirect(next);
  // Se mira la cookie y no getStaff(): getStaff() siempre devuelve a alguien, y redirigir
  // sin cookie rebotaría contra el proxy de /mando sin fin.
  if (await hasSessionCookie()) redirect(next);

  return <LoginScreen next={next} />;
}
