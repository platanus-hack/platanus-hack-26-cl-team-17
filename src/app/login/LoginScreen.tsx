import Link from "next/link";
import { Wordmark } from "@/components/brand";
import { Card } from "@/components/ui";
import { LoginForm } from "./LoginForm";

/** Pantalla de inicio de sesión del personal (tema mando). */
export function LoginScreen({ next, configError }: { next: string; configError: string | null }) {
  return (
    <main className="flex min-h-dvh flex-1 items-center justify-center bg-bg px-4 py-10 font-sans text-text">
      <div className="w-full max-w-sm animate-enter">
        <header className="mb-8 flex justify-center">
          <Wordmark size="lg" tagline className="text-center" />
        </header>
        <Card padding="none" className="p-6">
          <h1 className="font-display text-2xl font-semibold tracking-wide uppercase">Ingresar</h1>
          <p className="mt-1 text-sm text-muted">Usa el correo y la contraseña de tu cuenta del puesto de mando.</p>
          <LoginForm next={next} configError={configError} />
        </Card>
        <p className="mt-6 text-center text-sm text-muted">
          ¿Eres vecino y quieres enviar un video? No necesitas cuenta:{" "}
          <Link href="/reportar" className="text-text underline underline-offset-2 hover:text-accent">
            reporta aquí
          </Link>
          .
        </p>
      </div>
    </main>
  );
}
