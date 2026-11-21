import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getStaff } from "@/lib/auth";
import { sanitizeNextPath } from "@/lib/auth/next-path";
import { SessionConfigError } from "@/lib/auth/session";
import { isPostgresConfigured } from "@/lib/config";
import { LoginScreen } from "./LoginScreen";

export const metadata: Metadata = {
  title: "Ingresar",
  robots: { index: false, follow: false },
};

interface LoginPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const sp = await searchParams;
  const rawNext = Array.isArray(sp.next) ? sp.next[0] : sp.next;
  const next = sanitizeNextPath(rawNext);

  // Modo open: no hay cuentas; se entra directo al puesto de mando.
  if (!isPostgresConfigured()) redirect(next);

  let configError: string | null = null;
  let alreadySignedIn = false;
  try {
    alreadySignedIn = Boolean(await getStaff());
  } catch (err) {
    if (!(err instanceof SessionConfigError)) throw err;
    configError =
      "El inicio de sesión no está disponible: falta configurar el secreto de sesión del servidor (VIGIA_SESSION_SECRET). Avisa a quien administra la plataforma.";
  }
  if (alreadySignedIn) redirect(next);

  return <LoginScreen next={next} configError={configError} />;
}
