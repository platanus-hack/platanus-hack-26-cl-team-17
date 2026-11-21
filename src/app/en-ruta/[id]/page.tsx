import type { Metadata, Viewport } from "next";
import { EnRutaView } from "@/components/en-ruta/EnRutaView";

/** El enlace lleva una clave de solo lectura: ni indexar ni filtrarla como Referer al abrir Maps o Waze. */
export const metadata: Metadata = {
  title: "Briefing en ruta",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export const viewport: Viewport = {
  themeColor: "#0a0e13",
  colorScheme: "dark",
};

interface EnRutaPageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** /en-ruta/[id]?k=<share_key> — tablet del carro bomba; los datos se sondean en el navegador. */
export default async function EnRutaPage({ params, searchParams }: EnRutaPageProps) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const raw = Array.isArray(sp.k) ? sp.k[0] : sp.k;
  const shareKey = raw?.trim() ? raw.trim() : null;
  return <EnRutaView id={id} shareKey={shareKey} />;
}
