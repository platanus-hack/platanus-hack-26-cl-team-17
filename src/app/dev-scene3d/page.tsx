// Página temporal del paquete scene3d para verificar el visor en el navegador (se borra al terminar).
import { DevScene } from "./dev-client";

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const one = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : "");
  return <DevScene which={one("s") || "a"} compact={one("compact") === "1"} simulated={one("engine") === "simulated"} />;
}
