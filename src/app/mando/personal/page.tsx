import type { Metadata } from "next";
import { connection } from "next/server";
import { KeyRound, ShieldAlert, Users } from "lucide-react";
import { MandoShell } from "@/components/shell";
import { Button, EmptyState, Panel } from "@/components/ui";
import { getStaff } from "@/lib/auth";
import { listStaff } from "@/lib/auth/staff-db";
import { runtimeMode } from "@/lib/config";
import { StaffAccounts } from "./StaffAccounts";

export const metadata: Metadata = { title: "Personal" };

/** Administración del personal: lista de cuentas y alta de cuentas nuevas (solo admin). */
export default async function PersonalPage() {
  // El modo (local o con base de datos) se decide por petición, nunca al compilar.
  await connection();
  const mode = runtimeMode();

  // Login de maqueta (demo): getStaff() siempre entrega a alguien; sin cuenta real, el admin «Demo».
  const staff = await getStaff();

  return (
    <MandoShell title="Personal" subtitle="Cuentas del puesto de mando" mode={mode} staff={staff}>
      <div className="h-full overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6">
          {mode.auth === "open" ? (
            <OpenModeNotice />
          ) : staff?.role !== "admin" ? (
            <NotAdminNotice />
          ) : (
            <StaffAccounts me={staff} accounts={await listStaff()} />
          )}
        </div>
      </div>
    </MandoShell>
  );
}

function OpenModeNotice() {
  return (
    <Panel title="Personal" icon={Users}>
      <EmptyState
        icon={KeyRound}
        title="En modo local no hay cuentas de personal"
        description={
          <>
            Esta instancia corre sin base de datos: el acceso al puesto de mando está abierto y todos entran con la
            sesión de demostración «Demo». Para crear cuentas con correo y contraseña, configura{" "}
            <code className="font-mono text-text">DATABASE_URL</code> (Cloud SQL) y{" "}
            <code className="font-mono text-text">VIGIA_SESSION_SECRET</code> en el servidor.
          </>
        }
        action={
          <Button href="/mando" variant="secondary">
            Volver a incidentes
          </Button>
        }
      />
    </Panel>
  );
}

function NotAdminNotice() {
  return (
    <Panel title="Personal" icon={Users}>
      <EmptyState
        icon={ShieldAlert}
        title="Solo una cuenta administradora puede gestionar el personal"
        description="Si necesitas una cuenta nueva para alguien de tu guardia, pídesela a quien administra Vigía."
        action={
          <Button href="/mando" variant="secondary">
            Volver a incidentes
          </Button>
        }
      />
    </Panel>
  );
}
