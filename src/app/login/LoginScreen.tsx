import Link from "next/link";
import { Wordmark } from "@/components/brand";
import { Card } from "@/components/ui";
import { LoginForm } from "./LoginForm";

/** Pantalla de inicio de sesión del personal (tema mando). En la demo es una maqueta: no valida. */
export function LoginScreen({ next }: { next: string }) {
  return (
    <main className="flex min-h-dvh flex-1 items-center justify-center bg-bg px-4 py-10 font-sans text-text">
      <div className="w-full max-w-sm animate-enter">
        <header className="mb-8 flex justify-center">
          <Wordmark size="lg" tagline className="text-center" />
        </header>
        <Card padding="none" className="p-6">
          <h1 className="font-display text-2xl font-semibold">Ingresar</h1>
          <p className="mt-1 text-sm text-muted">
            Acceso de demostración: con los datos que ya están puestos, o con cualquier correo y contraseña, entras
            como administrador. Una cuenta creada en Personal entra con su propio rol.
          </p>
          <LoginForm next={next} />
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
