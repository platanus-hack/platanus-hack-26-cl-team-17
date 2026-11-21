import type { Metadata } from "next";
import { DashboardView } from "@/components/mando/dashboard";

export const metadata: Metadata = { title: "Incidentes" };

/** Tablero del puesto de mando: lista de incidentes por urgencia y mapa general. */
export default function Page() {
  return <DashboardView />;
}
