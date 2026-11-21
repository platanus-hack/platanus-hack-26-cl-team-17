import { redirect } from "next/navigation";
import { ReportByCode } from "../_components/ReportByCode";
import { parseIncidentCode, safeDecode } from "../_components/incident-code";

interface ReportarCodePageProps {
  params: Promise<{ code: string }>;
}

/** /reportar/VG-7K3Q — la validación contra el servidor ocurre en el navegador (carga, no existe, cerrada). */
export default async function ReportarCodePage({ params }: ReportarCodePageProps) {
  const { code: segment } = await params;
  const raw = safeDecode(segment).trim();
  const code = parseIncidentCode(raw);
  // "vg 7k3q" o "vg-7k3q" en la URL → forma canónica, para que el enlace compartido sea siempre el mismo.
  if (code && code !== raw) redirect(`/reportar/${code}`);
  return <ReportByCode code={code} rawCode={raw} />;
}
