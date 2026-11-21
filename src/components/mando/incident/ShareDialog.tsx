"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { ExternalLink, MessageCircle, QrCode, RefreshCw, ShieldAlert, Truck, Users } from "lucide-react";
import type { IncidentSnapshot } from "@/lib/contract";
import type { Incident } from "@/lib/domain";
import { qrSvgDataUrl } from "@/lib/client/qr";
import { Button, CopyButton, Dialog, Skeleton, TabPanel, Tabs, type TabItem } from "@/components/ui";

/** Props de `ShareDialog`: datos mínimos del incidente y rutas relativas para compartir. */
export interface ShareDialogProps {
  open: boolean;
  onClose: () => void;
  incident: Pick<Incident, "id" | "title" | "address" | "code">;
  share: IncidentSnapshot["share"];
}

type ShareTab = "vecinos" | "unidades";

const TABS: TabItem<ShareTab>[] = [
  { id: "vecinos", label: "Vecinos", icon: Users },
  { id: "unidades", label: "Unidades en ruta", icon: Truck },
];

const ID_PREFIX = "share";

// El origen solo existe en el navegador: en SSR e hidratación es null, luego se lee sin efecto ni parpadeo.
const noopSubscribe = () => () => {};
const getOrigin = () => window.location.origin;
const getServerOrigin = () => null;

/** Convierte una ruta relativa en URL absoluta con el origen actual (null sin origen o ruta inválida). */
function absoluteUrl(path: string, origin: string | null): string | null {
  if (!origin || !path) return null;
  try {
    return new URL(path, origin).toString();
  } catch {
    return null;
  }
}

/** Texto exacto para WhatsApp; usa la dirección o, si falta, el título. */
function whatsappMessage(place: string, url: string): string {
  return `Bomberos necesita ver la emergencia de ${place}. Si estás cerca y a salvo, graba 20 segundos y súbelo aquí: ${url}`;
}

/** Diálogo para compartir el incidente: enlace y QR para vecinos (subir video) y para unidades en ruta (briefing). */
export function ShareDialog({ open, onClose, incident, share }: ShareDialogProps) {
  const [tab, setTab] = useState<ShareTab>("vecinos");
  const origin = useSyncExternalStore(noopSubscribe, getOrigin, getServerOrigin);

  const reportUrl = absoluteUrl(share.report_path, origin);
  const briefingUrl = absoluteUrl(share.briefing_path, origin);
  const place = incident.address.trim() || incident.title.trim() || "esta emergencia";

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title="Compartir incidente"
      description={
        <>
          {incident.title} · código <span className="font-mono text-text">{incident.code}</span>
        </>
      }
      footer={<Button onClick={onClose}>Cerrar</Button>}
    >
      <Tabs
        tabs={TABS}
        value={tab}
        onChange={setTab}
        fullWidth
        ariaLabel="Con quién compartir"
        idPrefix={ID_PREFIX}
      />

      <TabPanel id="vecinos" idPrefix={ID_PREFIX} active={tab === "vecinos"} className="pt-4">
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted">
            Muéstrale este código a quien esté cerca o mándale el enlace. Puede subir videos y fotos desde su teléfono,
            sin crear cuenta.
          </p>
          <ShareQr url={reportUrl} alt="Código QR para enviar video" />
          <UrlRow url={reportUrl} label="Enlace para vecinos" />
          <section aria-labelledby="share-whatsapp-title" className="flex flex-col gap-2">
            <h3 id="share-whatsapp-title" className="label-caps text-xs text-muted">
              Mensaje para WhatsApp
            </h3>
            {reportUrl ? (
              <>
                <p className="whitespace-pre-wrap break-words rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-text">
                  {whatsappMessage(place, reportUrl)}
                </p>
                <div className="flex flex-wrap gap-2">
                  <CopyButton value={whatsappMessage(place, reportUrl)} label="Copiar mensaje" size="sm" />
                  <Button
                    size="sm"
                    icon={MessageCircle}
                    iconRight={ExternalLink}
                    href={`https://wa.me/?text=${encodeURIComponent(whatsappMessage(place, reportUrl))}`}
                    external
                  >
                    Abrir WhatsApp
                  </Button>
                </div>
              </>
            ) : (
              <Skeleton lines={2} />
            )}
          </section>
        </div>
      </TabPanel>

      <TabPanel id="unidades" idPrefix={ID_PREFIX} active={tab === "unidades"} className="pt-4">
        <div className="flex flex-col gap-4">
          <div
            role="note"
            className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-sm text-text"
          >
            <ShieldAlert aria-hidden="true" size={18} className="mt-0.5 shrink-0 text-warning" />
            <p>
              <span className="sr-only">Advertencia: </span>
              Quien tenga este enlace puede ver el briefing de este incidente. Compártelo solo con las unidades.
            </p>
          </div>
          <ShareQr url={briefingUrl} alt="Código QR del briefing para unidades en ruta" />
          <UrlRow url={briefingUrl} label="Enlace del briefing" />
          {briefingUrl && (
            <div>
              <Button size="sm" icon={ExternalLink} href={briefingUrl} external>
                Abrir briefing
              </Button>
            </div>
          )}
        </div>
      </TabPanel>
    </Dialog>
  );
}

/** Enlace en monoespaciado con botón de copiar. */
function UrlRow({ url, label }: { url: string | null; label: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="label-caps text-xs text-muted">{label}</span>
      {url ? (
        <div className="flex flex-wrap items-center gap-2">
          <code className="min-w-0 flex-1 break-all rounded-md border border-line bg-surface-2 px-3 py-2 font-mono text-sm text-text">
            {url}
          </code>
          <CopyButton value={url} label="Copiar enlace" size="sm" />
        </div>
      ) : (
        <Skeleton className="h-9 w-full" />
      )}
    </div>
  );
}

interface QrResult {
  url: string;
  attempt: number;
  src: string | null;
  error: string | null;
}

/** QR grande sobre fondo blanco (escaneable con tema oscuro); maneja la carga y los errores de generación. */
function ShareQr({ url, alt }: { url: string | null; alt: string }) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<QrResult | null>(null);

  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    qrSvgDataUrl(url, { margin: 2, errorCorrectionLevel: "M" }).then(
      (src) => {
        if (!cancelled) setResult({ url, attempt, src, error: null });
      },
      (err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error && err.message ? err.message : "No pudimos generar el código QR.";
        setResult({ url, attempt, src: null, error: message });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [url, attempt]);

  const current = result && result.url === url && result.attempt === attempt ? result : null;

  return (
    <div className="flex justify-center">
      {current?.src ? (
        // QR como data URL SVG: next/image no aporta nada aquí.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={current.src}
          alt={alt}
          width={256}
          height={256}
          className="size-60 rounded-md bg-white p-2 sm:size-64"
        />
      ) : current?.error ? (
        <div
          role="alert"
          className="flex size-60 flex-col items-center justify-center gap-3 rounded-md border border-critical/40 bg-critical-soft p-4 text-center text-sm text-text sm:size-64"
        >
          <QrCode aria-hidden="true" size={28} className="text-critical" />
          <p>
            {current.error} Usa el enlace de abajo para compartir.
          </p>
          <Button size="sm" icon={RefreshCw} onClick={() => setAttempt((n) => n + 1)}>
            Reintentar
          </Button>
        </div>
      ) : (
        <Skeleton className="size-60 sm:size-64" />
      )}
    </div>
  );
}
