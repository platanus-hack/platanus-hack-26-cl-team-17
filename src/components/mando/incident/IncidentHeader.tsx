"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import { BadgeCheck, Check, FlaskConical, Pencil, RefreshCw, Share2, Upload, X } from "lucide-react";
import {
  Badge,
  Button,
  ConfirmDialog,
  CopyButton,
  Elapsed,
  IconButton,
  Input,
  SegmentedControl,
  Spinner,
  useToast,
} from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import type { RuntimeMode } from "@/lib/contract";
import type { Incident, IncidentStatus } from "@/lib/domain";
import { incidentStatusLabel, incidentTypeIcon, incidentTypeLabel, labelOr } from "@/lib/labels";
import { cn } from "@/lib/cn";

/** Props de la cabecera del incidente. */
export interface IncidentHeaderProps {
  incident: Incident;
  mode: RuntimeMode;
  onShare: () => void;
  onAddMedia: () => void;
  /** Pide refrescar el snapshot tras un cambio. */
  onChanged: () => void;
  className?: string;
}

const STATUS_OPTIONS: { value: IncidentStatus; label: string }[] = [
  { value: "active", label: incidentStatusLabel.active },
  { value: "controlled", label: incidentStatusLabel.controlled },
  { value: "closed", label: incidentStatusLabel.closed },
];

const TITLE_MAX = 140;

/** Cabecera del incidente: tipo, título editable, dirección, código, cronómetro, estado y acciones. */
export function IncidentHeader({ incident, mode, onShare, onAddMedia, onChanged, className }: IncidentHeaderProps) {
  const { toast } = useToast();
  const TypeIcon = incidentTypeIcon[incident.type] ?? incidentTypeIcon.unknown;

  // Título en línea
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(incident.title);
  const [savingTitle, setSavingTitle] = useState(false);
  const [titleError, setTitleError] = useState<string | null>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);

  // Estado
  const [pendingStatus, setPendingStatus] = useState<IncidentStatus | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);

  const [verifying, setVerifying] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);

  const fusionRunning = incident.pipeline.fusion_status === "running";
  const simulated = mode.ai === "simulated";

  const startEdit = () => {
    setDraft(incident.title);
    setTitleError(null);
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setTitleError(null);
    // Devolver el foco al lápiz cuando reaparezca.
    requestAnimationFrame(() => editButtonRef.current?.focus());
  };

  const saveTitle = async () => {
    const title = draft.trim();
    if (!title) {
      setTitleError("El título no puede quedar vacío.");
      return;
    }
    if (title === incident.title) {
      cancelEdit();
      return;
    }
    setSavingTitle(true);
    setTitleError(null);
    try {
      await api.incidents.patch(incident.id, { title });
      onChanged();
      setEditing(false);
      requestAnimationFrame(() => editButtonRef.current?.focus());
    } catch (err) {
      setTitleError(errorMessage(err));
    } finally {
      setSavingTitle(false);
    }
  };

  const onTitleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void saveTitle();
    } else if (event.key === "Escape") {
      // Que el Esc no cierre un diálogo contenedor ni dispare otros atajos.
      event.preventDefault();
      event.stopPropagation();
      cancelEdit();
    }
  };

  const applyStatus = async (status: IncidentStatus) => {
    setPendingStatus(status);
    try {
      await api.incidents.patch(incident.id, { status });
      onChanged();
      toast({ title: `Incidente ${incidentStatusLabel[status].toLowerCase()}`, tone: "ok" });
    } catch (err) {
      toast({ title: "No se pudo cambiar el estado", description: errorMessage(err), tone: "critical", duration: 8000 });
      throw err;
    } finally {
      setPendingStatus(null);
    }
  };

  const onStatusChange = (status: IncidentStatus) => {
    if (status === incident.status || pendingStatus) return;
    if (status === "closed") {
      setConfirmClose(true);
      return;
    }
    applyStatus(status).catch(() => {
      /* el aviso ya informó el error */
    });
  };

  const verify = async () => {
    setVerifying(true);
    try {
      await api.incidents.patch(incident.id, { verified: true });
      onChanged();
      toast({ title: "Incidente verificado", tone: "ok" });
    } catch (err) {
      toast({ title: "No se pudo verificar", description: errorMessage(err), tone: "critical", duration: 8000 });
    } finally {
      setVerifying(false);
    }
  };

  const reanalyze = async () => {
    setAnalyzing(true);
    try {
      await api.incidents.analyze(incident.id, {});
      onChanged();
      toast({
        title: "Análisis solicitado",
        description: simulated ? "IA simulada: el resultado es de demostración." : undefined,
        tone: "info",
      });
    } catch (err) {
      toast({ title: "No se pudo pedir el análisis", description: errorMessage(err), tone: "critical", duration: 8000 });
    } finally {
      setAnalyzing(false);
    }
  };

  const shownStatus = pendingStatus ?? incident.status;

  return (
    <header
      className={cn(
        "flex flex-wrap items-start gap-x-4 gap-y-2 border-b border-line bg-surface px-3 py-2 md:px-4",
        className,
      )}
    >
      {/* Identidad: tipo, título, dirección, código y cronómetro */}
      <div className="flex min-w-0 flex-[1_1_22rem] items-start gap-3">
        <span
          className="mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-md border border-line bg-surface-2 text-accent"
          title={labelOr(incidentTypeLabel, incident.type)}
        >
          <TypeIcon aria-hidden="true" size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="label-caps text-xs text-muted">{labelOr(incidentTypeLabel, incident.type)}</span>
            {incident.origin === "demo" && (
              <Badge
                tone="info"
                variant="solid"
                icon={FlaskConical}
                title="Incidente de demostración: videos, radio y dron ficticios"
              >
                DEMO · datos ficticios
              </Badge>
            )}
            {!incident.verified && (
              <Badge tone="warning" variant="solid" title="Nació de un reporte de vecino y aún no lo confirma el mando">
                SIN VERIFICAR
              </Badge>
            )}
          </div>

          {editing ? (
            <div className="mt-1">
              <div className="flex items-center gap-1.5">
                <Input
                  aria-label="Título del incidente"
                  value={draft}
                  maxLength={TITLE_MAX}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={onTitleKeyDown}
                  invalid={titleError !== null}
                  disabled={savingTitle}
                  autoFocus
                  className="min-w-0 flex-1"
                />
                <IconButton
                  icon={Check}
                  label="Guardar título"
                  variant="primary"
                  size="md"
                  loading={savingTitle}
                  onClick={() => void saveTitle()}
                />
                <IconButton icon={X} label="Cancelar edición" size="md" disabled={savingTitle} onClick={cancelEdit} />
              </div>
              {titleError && (
                <p role="alert" className="mt-1 text-xs text-critical">
                  {titleError}
                </p>
              )}
            </div>
          ) : (
            <div className="flex min-w-0 items-center gap-1">
              <p className="min-w-0 truncate font-display text-xl font-semibold leading-tight text-text" title={incident.title}>
                {incident.title}
              </p>
              <IconButton ref={editButtonRef} icon={Pencil} label="Editar título" size="sm" onClick={startEdit} />
            </div>
          )}

          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
            <span className="min-w-0 truncate">{incident.address || "Sin dirección"}</span>
            <span className="inline-flex items-center gap-1">
              <span className="font-mono text-xs text-text">{incident.code}</span>
              <CopyButton value={incident.code} label="Copiar código" copiedLabel="Código copiado" iconOnly size="sm" variant="ghost" />
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="label-caps text-[11px]">{incident.status === "closed" ? "Duró" : "Transcurrido"}</span>
              <Elapsed
                since={incident.created_at}
                until={incident.status === "closed" ? incident.updated_at : null}
                className="text-sm text-text"
              />
            </span>
          </div>
        </div>
      </div>

      {/* Estado y acciones */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5">
          <SegmentedControl
            ariaLabel="Estado del incidente"
            options={STATUS_OPTIONS.map((o) => ({ ...o, disabled: pendingStatus !== null && o.value !== shownStatus }))}
            value={shownStatus}
            onChange={onStatusChange}
            size="md"
          />
          {pendingStatus && <Spinner size="xs" label="Guardando estado" />}
        </div>

        {!incident.verified && (
          <Button variant="primary" size="md" icon={BadgeCheck} loading={verifying} onClick={() => void verify()}>
            Verificar
          </Button>
        )}
        <Button size="md" icon={Share2} onClick={onShare}>
          Compartir
        </Button>
        <Button size="md" icon={Upload} onClick={onAddMedia}>
          Agregar video
        </Button>
        <Button
          size="md"
          icon={RefreshCw}
          loading={analyzing}
          disabled={fusionRunning || analyzing}
          onClick={() => void reanalyze()}
          title={
            fusionRunning
              ? "El análisis ya está en curso"
              : simulated
                ? "IA simulada: el análisis es de demostración"
                : "Volver a fusionar todas las fuentes"
          }
        >
          {fusionRunning ? "Analizando…" : "Reanalizar"}
        </Button>
      </div>

      <ConfirmDialog
        open={confirmClose}
        onClose={() => setConfirmClose(false)}
        onConfirm={async () => {
          await applyStatus("closed");
          setConfirmClose(false);
        }}
        title="¿Cerrar el incidente?"
        description="El cronómetro se detiene y el incidente pasa a la lista de cerrados. Podrás reabrirlo cambiando su estado."
        confirmLabel="Cerrar incidente"
        danger
        loading={pendingStatus === "closed"}
      />
    </header>
  );
}
