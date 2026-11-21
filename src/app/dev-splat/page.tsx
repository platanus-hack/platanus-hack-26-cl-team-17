/** Página temporal de verificación del paquete splat-app (se borra al terminar). */
import { DevSplatClient } from "./client";

export default async function DevSplatPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await searchParams;
  return <DevSplatClient incidentId={typeof id === "string" ? id : null} />;
}
