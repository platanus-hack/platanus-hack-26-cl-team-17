"use client";

import { useEffect, useState } from "react";
import { Info, KeyRound, Smartphone, Terminal, TriangleAlert } from "lucide-react";
import { Button, CopyButton, Dialog, Spinner } from "@/components/ui";
import { qrSvgDataUrl } from "@/lib/client/qr";
import type { MissionMode } from "@/lib/domain";
import { bridgeCommand, isLoopbackOrigin } from "./model";

/** Credenciales de una misión recién creada. Solo viven en el estado del panel, nunca se guardan ni registran. */
export interface MissionCredentials {
  missionId: string;
  label: string;
  mode: Exclude<MissionMode, "simulated">;
  origin: string;
  sensorUrl: string;
  token: string;
  lat: number;
  lng: number;
}

export interface CredentialsDialogProps {
  credentials: MissionCredentials | null;
  onClose: () => void;
}

type QrState = { url: string; dataUrl: string | null; failed: boolean };

function SensorQr({ url }: { url: string }) {
  const [qr, setQr] = useState<QrState | null>(null);
  useEffect(() => {
    let alive = true;
    qrSvgDataUrl(url, { margin: 2 }).then(
      (dataUrl) => alive && setQr({ url, dataUrl, failed: false }),
      () => alive && setQr({ url, dataUrl: null, failed: true }),
    );
    return () => {
      alive = false;
    };
  }, [url]);

  const current = qr && qr.url === url ? qr : null;
  if (!current) {
    return (
      <div className="flex size-48 items-center justify-center rounded-md border border-line bg-surface-2">
        <Spinner size="md" label="Generando código QR" />
      </div>
    );
  }
  if (current.failed || !current.dataUrl) {
    return (
      <p className="flex max-w-48 items-start gap-2 rounded-md border border-warning/40 bg-warning-soft p-3 text-sm text-warning">
        <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        No pudimos generar el código QR. Copia el enlace y ábrelo en el teléfono.
      </p>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- data URL generada en el navegador
    <img
      src={current.dataUrl}
      alt="Código QR con el enlace del modo sensor"
      width={192}
      height={192}
      className="size-48 rounded-md bg-white p-1"
    />
  );
}

function CodeBlock({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-line bg-surface-2 p-2">
      <code className="min-w-0 flex-1 font-mono text-xs break-all text-text select-all">{value}</code>
      <CopyButton value={value} label={label} size="sm" />
    </div>
  );
}

/** Muestra UNA vez el enlace del modo sensor (con QR) y, para API, el comando del puente. */
export function CredentialsDialog({ credentials, onClose }: CredentialsDialogProps) {
  const c = credentials;
  return (
    <Dialog
      open={c !== null}
      onClose={onClose}
      dismissible={false}
      hideClose
      size="lg"
      title={c ? `Conecta el dron ${c.label}` : "Conecta el dron"}
      description={
        c?.mode === "api"
          ? "Conecta el dron real (o el puente de prueba) con el comando de abajo, o usa un teléfono como sensor."
          : "Abre este enlace en el teléfono que hará de dron o de sensor."
      }
      footer={
        <Button variant="primary" onClick={onClose} data-autofocus="">
          Listo, ya lo guardé
        </Button>
      }
    >
      {c && (
        <div className="flex flex-col gap-5">
          <div role="alert" className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-sm text-warning">
            <KeyRound aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <p>
              <strong className="font-semibold">El token de acceso no se volverá a mostrar.</strong> Copia el enlace
              {c.mode === "api" ? " o el comando" : ""} antes de cerrar. Si lo pierdes, aborta esta misión y despliega otro dron.
            </p>
          </div>

          {isLoopbackOrigin(c.origin) && (
            <div className="flex items-start gap-2 rounded-md border border-info/40 bg-info-soft px-3 py-2 text-sm text-info">
              <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              <p>
                Tienes el puesto de mando abierto en <span className="font-mono">{c.origin}</span>: otro equipo no podrá abrir
                este enlace. Abre Vigía con la dirección de este computador en la red (y con HTTPS, para que el teléfono
                pueda usar la cámara).
              </p>
            </div>
          )}

          <section aria-labelledby={`${c.missionId}-sensor`} className="flex flex-col gap-3">
            <h3 id={`${c.missionId}-sensor`} className="label-caps flex items-center gap-2 text-sm text-text">
              <Smartphone aria-hidden="true" className="size-4 text-drone" />
              {c.mode === "api" ? "Alternativa: teléfono como sensor" : "Enlace del modo sensor"}
            </h3>
            <div className="flex flex-col items-start gap-4 sm:flex-row">
              <SensorQr url={c.sensorUrl} />
              <div className="flex min-w-0 flex-1 flex-col gap-2 text-sm text-muted">
                <p>
                  Escanea el código con la cámara del teléfono o copia el enlace. El teléfono enviará su posición, brújula y
                  video en vivo (no queda guardado).
                </p>
                <CodeBlock value={c.sensorUrl} label="Copiar enlace" />
              </div>
            </div>
          </section>

          {c.mode === "api" && (
            <section aria-labelledby={`${c.missionId}-bridge`} className="flex flex-col gap-2">
              <h3 id={`${c.missionId}-bridge`} className="label-caps flex items-center gap-2 text-sm text-text">
                <Terminal aria-hidden="true" className="size-4 text-drone" />
                Comando del puente
              </h3>
              <p className="text-sm text-muted">
                Ejecútalo desde la carpeta del proyecto en el computador conectado al dron. Así como está hace un vuelo de
                prueba sin cámara (<span className="font-mono">--simulate</span>).
              </p>
              <CodeBlock
                value={bridgeCommand({ origin: c.origin, missionId: c.missionId, token: c.token, lat: c.lat, lng: c.lng })}
                label="Copiar comando"
              />
              <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
                <li>
                  Cambia <span className="font-mono">--simulate</span> por{" "}
                  <span className="font-mono">--video ARCHIVO.mp4</span> para reproducir un video aéreo como cámara del dron
                  (un cuadro cada <span className="font-mono">--every</span> s; requiere ffmpeg).
                </li>
                <li>
                  Con <span className="font-mono">--mavlink udp:127.0.0.1:14550</span> (en vez de{" "}
                  <span className="font-mono">--simulate --lat … --lng …</span>) lee un dron MAVLink real; requiere pymavlink y
                  es una referencia no probada con hardware.
                </li>
              </ul>
            </section>
          )}
        </div>
      )}
    </Dialog>
  );
}
