import { redirect } from "next/navigation";

/** Dirección anterior de la ficha: ahora es la pantalla principal del incidente. */
export default async function Page(props: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await props.params;
  const sp = await props.searchParams;
  const estado = typeof sp.estado === "string" ? `?estado=${encodeURIComponent(sp.estado)}` : "";
  redirect(`/mando/${encodeURIComponent(id)}${estado}`);
}
