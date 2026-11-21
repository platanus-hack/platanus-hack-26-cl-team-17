import type { Metadata } from "next";
import { IncidentView } from "@/components/mando/incident";

/** Título base; la vista lo reemplaza en el navegador con el título y el estado del incidente. */
export const metadata: Metadata = { title: "Incidente" };

/** Vista de mando de un incidente (/mando/[id]). */
export default async function Page(props: PageProps<"/mando/[id]">) {
  const { id } = await props.params;
  return <IncidentView id={id} />;
}
