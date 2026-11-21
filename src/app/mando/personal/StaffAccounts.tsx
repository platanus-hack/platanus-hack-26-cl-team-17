import { Users } from "lucide-react";
import { Badge, EmptyState, Panel } from "@/components/ui";
import type { StaffRecord } from "@/lib/auth/staff-db";
import type { StaffPublic } from "@/lib/contract";
import { formatDateTime } from "@/lib/format";
import { staffRoleLabel } from "@/lib/labels";
import { CreateStaffForm } from "./CreateStaffForm";

const ROLE_TONE = { admin: "accent", officer: "info", operator: "neutral" } as const;

/** Vista de administración: cuentas existentes y formulario de alta. */
export function StaffAccounts({ me, accounts }: { me: StaffPublic; accounts: StaffRecord[] }) {
  const active = accounts.filter((a) => a.active).length;
  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <Panel
        title="Cuentas"
        icon={Users}
        badge={
          <Badge tone="neutral" className="tabular">
            {active} {active === 1 ? "activa" : "activas"}
          </Badge>
        }
        flush
      >
        {accounts.length === 0 ? (
          <EmptyState compact icon={Users} title="Aún no hay cuentas" description="Crea la primera con el formulario." />
        ) : (
          <ul className="divide-y divide-line">
            {accounts.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-text">
                    {a.name}
                    {a.id === me.id ? <span className="ml-1.5 text-sm font-normal text-muted">(tú)</span> : null}
                  </p>
                  <p className="truncate font-mono text-xs text-muted">{a.email}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge tone={ROLE_TONE[a.role]}>{staffRoleLabel[a.role]}</Badge>
                  {a.active ? null : (
                    <Badge tone="warning" variant="outline">
                      Desactivada
                    </Badge>
                  )}
                </div>
                <p className="w-full text-xs text-faint sm:w-auto sm:text-right">
                  {a.last_login_at ? `Último ingreso ${formatDateTime(a.last_login_at)}` : "Nunca ha ingresado"}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <CreateStaffForm />
    </div>
  );
}
