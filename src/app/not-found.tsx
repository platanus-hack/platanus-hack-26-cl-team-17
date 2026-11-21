import type { Metadata } from "next";
import { House, MapPinOff, MonitorDot } from "lucide-react";
import { Wordmark } from "@/components/brand/Wordmark";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";

/** Título de la pestaña para rutas inexistentes. */
export const metadata: Metadata = {
  title: "Página no encontrada",
};

/** Página 404: mensaje claro y accesos a Inicio y al puesto de mando. */
export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-line">
        <div className="mx-auto flex h-12 w-full max-w-6xl items-center px-4 sm:px-6">
          <Wordmark size="sm" href="/" />
        </div>
      </header>
      <main className="flex flex-1 items-center justify-center px-4 py-12">
        <div className="w-full max-w-md">
          <p className="label-caps mb-3 text-center text-xs text-faint">Error 404</p>
          <EmptyState
            icon={MapPinOff}
            title="No encontramos esta página"
            description="Puede que el enlace esté incompleto o que la página ya no exista."
            action={
              <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
                <Button href="/" icon={House}>
                  Inicio
                </Button>
                <Button href="/mando" variant="primary" icon={MonitorDot}>
                  Puesto de mando
                </Button>
              </div>
            }
            className="rounded-lg border border-line bg-surface"
          />
        </div>
      </main>
    </div>
  );
}
