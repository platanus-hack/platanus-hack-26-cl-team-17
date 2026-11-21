import type { Metadata } from "next";
import { IncidentView } from "@/components/mando/incident";

/** Título base; la vista lo reemplaza en el navegador con el título y el estado del incidente. */
export const metadata: Metadata = { title: "Incidente · vista técnica" };

/**
 * Vista técnica completa de un incidente (/mando/[id]/tecnica): radio, dron, reconstrucción
 * 3DGS, compartir y agregar videos. La pantalla principal es la ficha (/mando/[id]).
 */
export default async function Page(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  return <IncidentView id={id} />;
}
