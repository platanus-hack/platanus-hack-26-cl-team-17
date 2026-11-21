import { redirect } from "next/navigation";
import { ReportStart } from "./_components/ReportStart";
import { firstParam, parseIncidentCode } from "./_components/incident-code";

interface ReportarPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** /reportar — también acepta ?code=VG-7K3Q (desde un QR) y lleva directo a esa emergencia. */
export default async function ReportarPage({ searchParams }: ReportarPageProps) {
  const sp = await searchParams;
  const rawCode = firstParam(sp.code)?.trim();
  if (rawCode) {
    const code = parseIncidentCode(rawCode);
    if (code) redirect(`/reportar/${code}`);
  }
  return <ReportStart invalidCode={rawCode || undefined} />;
}
