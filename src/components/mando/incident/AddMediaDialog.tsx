"use client";

import { useState } from "react";
import { Upload } from "lucide-react";
import { MediaUploader } from "@/components/report";
import { Button, Dialog, Spinner, useToast } from "@/components/ui";

/** Props de `AddMediaDialog`: incidente destino y aviso al terminar la subida. */
export interface AddMediaDialogProps {
  open: boolean;
  onClose: () => void;
  incidentCode: string;
  onDone: () => void;
}

/** Diálogo del puesto de mando para adjuntar videos recibidos por otra vía; no se deja cerrar mientras sube el original. */
export function AddMediaDialog({ open, onClose, incidentCode, onDone }: AddMediaDialogProps) {
  const { toast } = useToast();
  // Entre onSubmitted y onDone el video original sigue subiendo: cerrar desmontaría el cargador y lo cortaría.
  const [busy, setBusy] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (!open && busy) setBusy(false);
  }

  const handleSubmitted = () => {
    setBusy(true);
    toast({ title: "Video recibido; el análisis comenzó", tone: "ok", icon: Upload });
  };

  const handleDone = () => {
    setBusy(false);
    onDone();
  };

  const requestClose = () => {
    if (!busy) onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={requestClose}
      size="lg"
      title="Agregar video"
      description="Para videos recibidos por otra vía (WhatsApp, correo, cámara de una unidad)"
      dismissible={!busy}
      hideClose={busy}
      footer={
        <>
          {busy && (
            <span role="status" className="mr-auto flex items-center gap-2 text-sm text-muted">
              <Spinner size="xs" label="Subiendo" />
              Subiendo el video original · no cierres esta ventana
            </span>
          )}
          <Button onClick={requestClose} disabled={busy}>
            Cerrar
          </Button>
        </>
      }
    >
      <MediaUploader
        variant="mando"
        asResponder
        incidentCode={incidentCode}
        onSubmitted={handleSubmitted}
        onDone={handleDone}
      />
    </Dialog>
  );
}
