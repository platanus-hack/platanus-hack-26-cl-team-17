import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { KeyRound, ShieldAlert, Users } from "lucide-react";
import { MandoShell } from "@/components/shell";
import { Button, EmptyState, Panel } from "@/components/ui";
import { getStaff } from "@/lib/auth";
import { SessionConfigError } from "@/lib/auth/session";
import { listStaff } from "@/lib/auth/staff-db";
import { runtimeMode } from "@/lib/config";
import type { StaffPublic } from "@/lib/contract";
import { StaffAccounts } from "./StaffAccounts";

export const metadata: Metadata = { title: "Personal" };

/** Administración del personal: lista de cuentas y alta de cuentas nuevas (solo admin). */
export default async function PersonalPage() {
  // El modo (local o con base de datos) se decide por petición, nunca al compilar.
  await connection();
  const mode = runtimeMode();

  let staff: StaffPublic | null = null;
  let configError = false;
  try {
    staff = await getStaff();
  } catch (err) {
    if (!(err instanceof SessionConfigError)) throw err;
    configError = true;
  }
  if (mode.auth === "staff" && !staff && !configError) redirect("/login?next=/mando/personal");

  return (
    <MandoShell title="Personal" subtitle="Cuentas del puesto de mando" mode={mode} staff={staff}>
      <div className="h-full overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6">
          {configError ? (
            <ConfigErrorNotice />
          ) : mode.auth === "open" ? (
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

function ConfigErrorNotice() {
  return (
    <Panel title="Personal" icon={Users} tone="critical">
      <EmptyState
        icon={ShieldAlert}
        title="El acceso del personal no está configurado"
        description="Falta el secreto de sesión del servidor (VIGIA_SESSION_SECRET). Avisa a quien administra la plataforma."
      />
    </Panel>
  );
}
