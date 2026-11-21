import type { Metadata } from "next";
import { TechnicalView } from "@/components/mando/diagnostics";

/** Título base; la vista lo reemplaza en el navegador con el título y el estado del incidente. */
export const metadata: Metadata = { title: "Incidente · vista técnica" };

/**
 * Vista técnica completa de un incidente (/mando/[id]/tecnica): radio, dron, reconstrucción
 * 3DGS, compartir y agregar videos, con la banda de estado de los sistemas arriba (Zello,
 * Claude, detector, salida de Vigía, errores y motor) y su detalle. ?diagnostico=1 abre el
 * detalle de entrada. La pantalla principal es la ficha (/mando/[id]).
 */
export default async function Page(props: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await props.params;
  const sp = await props.searchParams;
  const open = sp.diagnostico === "1";
  return <TechnicalView id={id} initialOpen={open} />;
}
