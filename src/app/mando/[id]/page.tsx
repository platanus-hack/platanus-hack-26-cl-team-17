import type { Metadata } from "next";
import { FichaView, type FichaDemoState } from "@/components/ficha/FichaView";

export const metadata: Metadata = { title: "Ficha del incidente" };

/**
 * Pantalla principal de un incidente (/mando/[id]): la ficha para el OBAC con mapa 3D,
 * esquema técnico, lo crítico y Vigía. La vista técnica completa está en /mando/[id]/tecnica.
 * ?estado=llegando | hablando fuerza esos estados para la demostración.
 */
export default async function Page(props: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await props.params;
  const sp = await props.searchParams;
  const estado = typeof sp.estado === "string" ? sp.estado : null;
  const demoState: FichaDemoState = estado === "llegando" || estado === "hablando" ? estado : null;
  return <FichaView id={id} demoState={demoState} />;
}
