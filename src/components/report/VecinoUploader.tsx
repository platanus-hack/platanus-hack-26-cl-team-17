"use client";

import { useCallback, useEffect, useId, useRef, useState, type ChangeEvent } from "react";
import {
  CircleAlert,
  CircleCheck,
  Images,
  LocateFixed,
  MapPin,
  MapPinOff,
  RefreshCw,
  Send,
  TriangleAlert,
  Video,
  X,
} from "lucide-react";
import { Button, ProgressBar, Spinner, Textarea } from "@/components/ui";
import { cn } from "@/lib/cn";
import { formatBytes } from "@/lib/format";
import { LIMITS } from "@/lib/domain";
import {
  isSubmitReportError,
  submitReport,
  type FramesUploadedInfo,
  type UploadProgress,
} from "@/lib/client/upload";
import { getCompassHeading, useGeolocation } from "@/lib/client/geo";
import type { MediaUploaderProps } from "./types";
import { NoteChips } from "./NoteChips";
import {
  accuracyText,
  canSendWithoutLocation,
  classifyFile,
  composeNote,
  freeTextBudget,
  headingApplies,
  isPoorAccuracy,
  pickGallerySelection,
  RECORD_REQUEST_EVENT,
  toggleChip,
  vecinoStageView,
  videoOutcomeText,
  videoSizeNotice,
  type MediaKind,
} from "./report-core";

type Source = "capture" | "gallery";

interface Selection {
  kind: MediaKind;
  files: File[];
  urls: string[];
  source: Source;
  /** Momento en que se eligió (para `capturedAt` de un video recién grabado). */
  selectedAt: number;
  notice: string | null;
}

interface SentInfo {
  incidentCode: string;
  createdIncident: boolean;
  kind: MediaKind;
  outcome: { text: string; tone: "ok" | "warning" } | null;
}

type Phase =
  | { name: "compose" }
  | { name: "sending"; progress: UploadProgress | null; framesDelivered: boolean }
  | { name: "sent"; info: SentInfo }
  | { name: "error"; message: string; retryable: boolean; aborted: boolean };

function revokeAll(sel: Selection | null) {
  if (!sel) return;
  for (const url of sel.urls) URL.revokeObjectURL(url);
}

/** Cargador para vecinos: pasos grandes y guiados, pensado para un teléfono y una persona nerviosa. */
export function VecinoUploader({ incidentCode, typeHint, asResponder, onSubmitted, onDone, className }: MediaUploaderProps) {
  const uid = useId();
  const ids = {
    media: `${uid}-media`,
    note: `${uid}-note`,
    noteHint: `${uid}-note-hint`,
    chipsHint: `${uid}-chips-hint`,
    location: `${uid}-location`,
  };

  const [selection, setSelection] = useState<Selection | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const [chips, setChips] = useState<Set<string>>(() => new Set());
  const [freeText, setFreeText] = useState("");
  const [phase, setPhase] = useState<Phase>({ name: "compose" });
  const [needLocation, setNeedLocation] = useState(false);

  const geo = useGeolocation({ watch: true });
  const codeAllowsNoLocation = canSendWithoutLocation(incidentCode);

  const captureRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  const resultHeadingRef = useRef<HTMLHeadingElement>(null);
  const errorHeadingRef = useRef<HTMLHeadingElement>(null);
  const locationRef = useRef<HTMLElement>(null);
  const mediaRef = useRef<HTMLElement>(null);
  // Tras volver de la cámara o la galería se muestra "Video listo" (y el envío fijo abajo).
  const revealMediaRef = useRef(false);

  const controllerRef = useRef<AbortController | null>(null);
  const selectionRef = useRef<Selection | null>(null);
  const mountedRef = useRef(false);
  const callbacksRef = useRef({ onSubmitted, onDone });

  useEffect(() => {
    callbacksRef.current = { onSubmitted, onDone };
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      controllerRef.current?.abort();
      controllerRef.current = null;
      revokeAll(selectionRef.current);
      selectionRef.current = null;
    };
  }, []);

  // Si el permiso ya estaba dado (p. ej. en la página anterior), se busca la ubicación sin preguntar.
  const { permission, status: geoStatus, request: requestLocation } = geo;
  useEffect(() => {
    if (permission === "granted" && geoStatus === "idle") void requestLocation();
  }, [permission, geoStatus, requestLocation]);

  // Aviso del navegador si se intenta cerrar la pestaña mientras sube.
  const sending = phase.name === "sending";
  useEffect(() => {
    if (!sending) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Requerido por navegadores antiguos para mostrar el aviso.
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [sending]);

  // "Grabar ahora" del pedido de video de Bomberos: abre esta misma cámara (salvo mientras sube).
  useEffect(() => {
    const onRecordRequest = () => {
      if (!controllerRef.current) captureRef.current?.click();
    };
    window.addEventListener(RECORD_REQUEST_EVENT, onRecordRequest);
    return () => window.removeEventListener(RECORD_REQUEST_EVENT, onRecordRequest);
  }, []);

  // Pantalla encendida mientras sube: si el teléfono se bloquea, iOS y Android congelan la subida.
  useEffect(() => {
    if (!sending) return;
    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;
    const acquire = async () => {
      try {
        if (document.visibilityState !== "visible" || !("wakeLock" in navigator)) return;
        const s = await navigator.wakeLock.request("screen");
        if (cancelled) void s.release().catch(() => {});
        else sentinel = s;
      } catch {
        // Sin soporte o sin permiso: queda el aviso en pantalla de no bloquearla.
      }
    };
    // El navegador suelta el bloqueo al ocultar la pestaña; al volver se pide de nuevo.
    const onVisibility = () => {
      if (document.visibilityState === "visible" && (!sentinel || sentinel.released)) void acquire();
    };
    void acquire();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      void sentinel?.release().catch(() => {});
    };
  }, [sending]);

  // Lleva el foco al resultado o al error para que el lector de pantalla lo anuncie.
  useEffect(() => {
    if (phase.name === "sent") resultHeadingRef.current?.focus();
    else if (phase.name === "error") errorHeadingRef.current?.focus();
  }, [phase.name]);

  const replaceSelection = useCallback((next: Selection | null) => {
    revokeAll(selectionRef.current);
    selectionRef.current = next;
    revealMediaRef.current = next !== null;
    setSelection(next);
  }, []);

  useEffect(() => {
    if (!selection || !revealMediaRef.current) return;
    revealMediaRef.current = false;
    mediaRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [selection]);

  const onCaptureChange = (e: ChangeEvent<HTMLInputElement>) => {
    const list = Array.from(e.target.files ?? []);
    e.target.value = "";
    const file = list[0];
    if (!file) return;
    if (classifyFile(file) !== "video") {
      setPickError("Eso no es un video. Intenta grabar de nuevo.");
      return;
    }
    setPickError(null);
    // Grabó otro desde el pedido de video tras un envío: empieza un reporte nuevo.
    if (phase.name === "sent") {
      setChips(new Set());
      setFreeText("");
      setPhase({ name: "compose" });
    }
    replaceSelection({
      kind: "video",
      files: [file],
      urls: [URL.createObjectURL(file)],
      source: "capture",
      selectedAt: Date.now(),
      notice: null,
    });
  };

  const onGalleryChange = (e: ChangeEvent<HTMLInputElement>) => {
    const list = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (list.length === 0) return;
    const picked = pickGallerySelection(list);
    if (!picked.ok) {
      setPickError(picked.error);
      return;
    }
    setPickError(null);
    replaceSelection({
      kind: picked.kind,
      files: picked.files,
      urls: picked.files.map((f) => URL.createObjectURL(f)),
      source: "gallery",
      selectedAt: Date.now(),
      notice: picked.notice,
    });
  };

  const budget = freeTextBudget(chips);
  const note = composeNote(chips, freeText);

  const send = async () => {
    const sel = selectionRef.current;
    if (!sel || controllerRef.current) return;
    // Primera instrucción del gesto: iOS solo concede la brújula dentro del toque.
    const main = sel.files[0];
    const headingPromise = headingApplies(sel.source, main.lastModified, Date.now())
      ? getCompassHeading()
      : Promise.resolve(null);

    let position = geo.position;
    if (!position && !codeAllowsNoLocation) {
      position = await requestLocation();
      if (!position) {
        void headingPromise;
        setNeedLocation(true);
        locationRef.current?.focus();
        return;
      }
    }
    setNeedLocation(false);
    const heading = await headingPromise;
    if (!mountedRef.current || controllerRef.current) return;

    const controller = new AbortController();
    controllerRef.current = controller;
    setPhase({ name: "sending", progress: null, framesDelivered: false });

    let delivered: FramesUploadedInfo | null = null;
    let notified = false;
    const notify = (r: { mediaId: string; incidentCode: string; createdIncident: boolean }) => {
      if (notified || !mountedRef.current) return;
      notified = true;
      callbacksRef.current.onSubmitted?.({
        mediaId: r.mediaId,
        incidentCode: r.incidentCode,
        createdIncident: r.createdIncident,
      });
    };

    try {
      const result = await submitReport({
        ...(sel.kind === "video" ? { file: main } : { files: sel.files }),
        kind: sel.kind,
        incidentCode,
        typeHint,
        note,
        position: position ? { lat: position.lat, lng: position.lng, accuracy_m: position.accuracy_m } : null,
        heading,
        capturedAt: sel.source === "capture" ? new Date(sel.selectedAt) : null,
        asResponder,
        signal: controller.signal,
        onProgress: (p) => {
          if (!mountedRef.current) return;
          setPhase((prev) => (prev.name === "sending" ? { ...prev, progress: p } : prev));
        },
        onFramesUploaded: (info) => {
          delivered = info;
          if (!mountedRef.current) return;
          setPhase((prev) => (prev.name === "sending" ? { ...prev, framesDelivered: true } : prev));
          notify(info);
        },
      });
      if (!mountedRef.current) return;
      // Sin fotogramas (video ilegible en el navegador) el aviso llega cuando subió el video.
      notify(result);
      setPhase({
        name: "sent",
        info: {
          incidentCode: result.incidentCode,
          createdIncident: result.createdIncident,
          kind: sel.kind,
          outcome: videoOutcomeText({
            kind: sel.kind,
            video: result.video,
            framesUnsupported: result.framesUnsupported,
            videoError: result.videoError,
          }),
        },
      });
      callbacksRef.current.onDone?.();
    } catch (err) {
      if (!mountedRef.current) return;
      const e = isSubmitReportError(err) ? err : null;
      // `delivered` se asigna dentro de un callback; TS no lo ve y lo deja como null.
      const got = delivered as FramesUploadedInfo | null;
      if (got) {
        // Bomberos ya tiene las imágenes; solo faltó el video completo.
        setPhase({
          name: "sent",
          info: {
            incidentCode: got.incidentCode,
            createdIncident: got.createdIncident,
            kind: sel.kind,
            outcome:
              sel.kind === "video"
                ? {
                    text:
                      e?.code === "aborted"
                        ? "Detuviste la subida del video completo. Bomberos ya tiene las imágenes."
                        : "El video completo no se pudo subir, pero Bomberos ya tiene las imágenes.",
                    tone: "warning",
                  }
                : null,
          },
        });
        callbacksRef.current.onDone?.();
      } else {
        const aborted = e?.code === "aborted";
        setPhase({
          name: "error",
          aborted,
          retryable: e ? e.retryable : true,
          message: aborted
            ? "Cancelaste el envío. Tu archivo sigue elegido: puedes reintentar cuando quieras."
            : (e?.message ?? "No pudimos enviar tu reporte. Revisa tu conexión e intenta de nuevo."),
        });
      }
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  };

  const cancel = () => controllerRef.current?.abort();

  const startOver = () => {
    replaceSelection(null);
    setChips(new Set());
    setFreeText("");
    setPickError(null);
    setPhase({ name: "compose" });
  };

  const dismissError = () => setPhase({ name: "compose" });

  // Montado también tras un envío, para que el pedido de video pueda abrir la cámara de un toque.
  const captureInput = (
    <input
      ref={captureRef}
      type="file"
      accept="video/*"
      capture="environment"
      className="sr-only"
      tabIndex={-1}
      aria-hidden="true"
      onChange={onCaptureChange}
    />
  );

  /* ───────────── Enviando ───────────── */
  if (phase.name === "sending") {
    const kind = selection?.kind ?? "video";
    const view = phase.progress
      ? vecinoStageView({
          stage: phase.progress.stage,
          kind,
          fraction: phase.progress.fraction,
          stageFraction: phase.progress.stageFraction,
          framesDelivered: phase.framesDelivered,
        })
      : vecinoStageView({ stage: "extracting", kind, fraction: 0, framesDelivered: false });
    return (
      <section aria-labelledby={`${uid}-sending`} className={cn("flex flex-col gap-4", className)}>
        <div
          className={cn(
            "flex flex-col gap-4 rounded-lg border p-5",
            view.delivered ? "border-ok/40 bg-ok-soft" : "border-line bg-surface",
          )}
        >
          <div role="status" aria-live="polite" className="flex items-start gap-3">
            {view.delivered ? (
              <CircleCheck aria-hidden="true" className="mt-0.5 size-8 shrink-0 text-ok" />
            ) : (
              <Spinner size="lg" label="Enviando" />
            )}
            <div className="min-w-0">
              <h2 id={`${uid}-sending`} className="font-display text-2xl font-bold leading-tight text-text">
                {view.title}
              </h2>
              {view.detail && <p className="mt-1 text-base text-muted">{view.detail}</p>}
            </div>
          </div>
          <ProgressBar value={view.value} label={view.barLabel} tone={view.delivered ? "ok" : "accent"} showValue />
        </div>
        {!view.delivered && (
          <p className="flex items-start gap-2 text-base text-muted">
            <TriangleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-warning" />
            <span>No cierres esta página ni apagues la pantalla hasta que termine.</span>
          </p>
        )}
        <Button variant="ghost" size="xl" icon={X} onClick={cancel} fullWidth className="whitespace-normal!">
          {view.delivered ? "Detener la subida del video" : "Cancelar envío"}
        </Button>
      </section>
    );
  }

  /* ───────────── Enviado ───────────── */
  if (phase.name === "sent") {
    const { info } = phase;
    return (
      <section className={cn("flex flex-col gap-4", className)}>
        {captureInput}
        <div className="flex flex-col gap-3 rounded-lg border border-ok/40 bg-ok-soft p-5">
          <div className="flex items-start gap-3">
            <CircleCheck aria-hidden="true" className="mt-0.5 size-9 shrink-0 text-ok" />
            <h2
              ref={resultHeadingRef}
              tabIndex={-1}
              className="font-display text-2xl font-bold leading-tight text-text outline-none"
            >
              Listo, tu reporte llegó a Bomberos
            </h2>
          </div>
          <p className="text-base text-text">
            Código de la emergencia: <strong className="font-mono tabular">{info.incidentCode}</strong>
            <span className="block text-muted">Guárdalo si quieres enviar más videos de esta emergencia.</span>
          </p>
          {info.createdIncident && (
            <p className="text-base text-muted">
              Es un aviso nuevo. Bomberos lo revisará y lo confirmará.
            </p>
          )}
          {info.outcome && (
            <p className="flex items-start gap-2 text-base text-text">
              {info.outcome.tone === "ok" ? (
                <CircleCheck aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-ok" />
              ) : (
                <TriangleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-warning" />
              )}
              <span>{info.outcome.text}</span>
            </p>
          )}
        </div>
        <p className="text-base text-muted">
          Si la situación cambia, puedes enviar otro video. Mantén la distancia y no te expongas.
        </p>
        <Button variant="primary" size="xl" icon={Video} onClick={startOver} fullWidth>
          Enviar otro video
        </Button>
      </section>
    );
  }

  /* ───────────── Formulario (y error) ───────────── */
  const kindLabel = selection?.kind === "photo" ? (selection.files.length === 1 ? "Foto lista" : `${selection.files.length} fotos listas`) : "Video listo";
  const sizeNotice = selection?.kind === "video" ? videoSizeNotice(selection.files[0].size) : null;
  const accuracy = accuracyText(geo.position?.accuracy_m);
  const poor = isPoorAccuracy(geo.position?.accuracy_m);
  const locating = geo.status === "locating";
  const geoError = geo.status === "error" ? geo.error : null;

  return (
    <div className={cn("flex flex-col gap-6", className)}>
      {phase.name === "error" && (
        <div
          role="alert"
          className={cn(
            "flex flex-col gap-3 rounded-lg border p-4",
            phase.aborted ? "border-line bg-surface" : "border-critical/40 bg-critical-soft",
          )}
        >
          <div className="flex items-start gap-3">
            <CircleAlert
              aria-hidden="true"
              className={cn("mt-0.5 size-6 shrink-0", phase.aborted ? "text-muted" : "text-critical")}
            />
            <div className="min-w-0">
              <h2
                ref={errorHeadingRef}
                tabIndex={-1}
                className="font-display text-xl font-bold leading-tight text-text outline-none"
              >
                {phase.aborted ? "Envío cancelado" : "No se pudo enviar"}
              </h2>
              <p className="mt-1 text-base text-text">{phase.message}</p>
            </div>
          </div>
          {phase.retryable && selection ? (
            <Button variant="primary" size="xl" icon={RefreshCw} onClick={() => void send()} fullWidth>
              Reintentar
            </Button>
          ) : (
            <Button variant="secondary" size="xl" onClick={dismissError} fullWidth>
              Entendido
            </Button>
          )}
        </div>
      )}

      {/* 1. Video o fotos */}
      <section ref={mediaRef} aria-labelledby={ids.media} className="flex scroll-mt-4 flex-col gap-3">
        <h2 id={ids.media} className="font-display text-xl font-bold text-text">
          1. Tu video o fotos
        </h2>
        {captureInput}
        <input
          ref={galleryRef}
          type="file"
          accept="video/*,image/*"
          multiple
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={onGalleryChange}
        />
        {!selection ? (
          <div className="flex flex-col gap-3">
            <Button
              variant="primary"
              size="xl"
              icon={Video}
              fullWidth
              className="min-h-20 text-xl"
              onClick={() => captureRef.current?.click()}
            >
              Grabar video ahora
            </Button>
            <Button
              variant="secondary"
              size="xl"
              icon={Images}
              fullWidth
              className="min-h-20 text-xl"
              onClick={() => galleryRef.current?.click()}
            >
              Elegir de mi galería
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-3">
            {selection.kind === "video" ? (
              <video
                src={selection.urls[0]}
                controls
                playsInline
                muted
                preload="metadata"
                className="max-h-80 w-full rounded-md bg-black object-contain"
              >
                Tu navegador no puede mostrar este video, pero igual lo podemos enviar.
              </video>
            ) : (
              <ul role="list" className="grid grid-cols-3 gap-2">
                {selection.urls.map((url, i) => (
                  <li key={url} className="aspect-square overflow-hidden rounded-md bg-surface-2">
                    {/* eslint-disable-next-line @next/next/no-img-element -- vista previa local (blob:), next/image no aplica */}
                    <img src={url} alt={`Foto ${i + 1} de ${selection.urls.length}`} className="size-full object-cover" />
                  </li>
                ))}
              </ul>
            )}
            <p className="flex items-center gap-2 text-base font-semibold text-text">
              <CircleCheck aria-hidden="true" className="size-5 shrink-0 text-ok" />
              <span>
                {kindLabel}
                <span className="font-normal text-muted">
                  {" · "}
                  {formatBytes(selection.files.reduce((acc, f) => acc + f.size, 0))}
                </span>
              </span>
            </p>
            {selection.notice && (
              <p className="flex items-start gap-2 text-base text-muted">
                <TriangleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-warning" />
                <span>{selection.notice}</span>
              </p>
            )}
            {sizeNotice && (
              <p className="flex items-start gap-2 text-base text-muted">
                <TriangleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-warning" />
                <span>{sizeNotice}</span>
              </p>
            )}
            <Button variant="secondary" size="xl" onClick={() => replaceSelection(null)} fullWidth>
              Cambiar video o fotos
            </Button>
          </div>
        )}
        {pickError && (
          <p role="alert" className="flex items-start gap-2 text-base text-critical">
            <CircleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
            <span>{pickError}</span>
          </p>
        )}
      </section>

      {/* 2. Nota */}
      <section aria-labelledby={`${ids.note}-title`} className="flex flex-col gap-3">
        <h2 id={`${ids.note}-title`} className="font-display text-xl font-bold text-text">
          2. ¿Qué está pasando? <span className="font-sans text-base font-normal text-muted">(opcional)</span>
        </h2>
        <p id={ids.chipsHint} className="text-base text-muted">
          Toca lo que veas:
        </p>
        <NoteChips selected={chips} onToggle={(id) => setChips((s) => toggleChip(s, id))} describedBy={ids.chipsHint} />
        <label htmlFor={ids.note} className="mt-1 text-base font-semibold text-text">
          Algo más que Bomberos deba saber
        </label>
        <Textarea
          id={ids.note}
          value={freeText}
          onChange={(e) => setFreeText(e.target.value.slice(0, budget))}
          maxLength={budget}
          autoGrow
          rows={3}
          maxRows={8}
          aria-describedby={ids.noteHint}
          placeholder="Por ejemplo: hay un adulto mayor en el segundo piso"
          className="text-base! leading-6!"
        />
        <p id={ids.noteHint} className="text-right text-sm text-muted tabular">
          {note.length} / {LIMITS.MAX_NOTE_CHARS} caracteres
        </p>
      </section>

      {/* 3. Ubicación */}
      <section
        ref={locationRef}
        tabIndex={-1}
        aria-labelledby={ids.location}
        className={cn(
          "flex flex-col gap-3 rounded-lg outline-none",
          needLocation && !geo.position && "border border-critical/40 bg-critical-soft p-3",
        )}
      >
        <h2 id={ids.location} className="font-display text-xl font-bold text-text">
          3. Tu ubicación
          {codeAllowsNoLocation && <span className="font-sans text-base font-normal text-muted"> (opcional)</span>}
        </h2>
        <p className="text-base text-muted">
          {codeAllowsNoLocation
            ? "Nos ayuda a saber desde dónde grabaste."
            : "La necesitamos para saber dónde es la emergencia."}
        </p>

        {geo.position ? (
          <div className="flex flex-col gap-2">
            <p role="status" className="flex items-start gap-2 text-base text-text">
              <MapPin aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-ok" />
              <span>
                <strong>Ubicación lista.</strong> {accuracy}
              </span>
            </p>
            {poor && (
              <p className="flex items-start gap-2 text-base text-muted">
                <TriangleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-warning" />
                <span>La ubicación es aproximada. Si puedes, sal a un lugar abierto y actualízala.</span>
              </p>
            )}
            {poor && (
              <Button
                variant="secondary"
                size="xl"
                icon={RefreshCw}
                loading={locating}
                onClick={() => void requestLocation()}
                fullWidth
              >
                Actualizar ubicación
              </Button>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {geoError && (
              <div className="flex flex-col gap-1">
                <p role="alert" className="flex items-start gap-2 text-base text-text">
                  <MapPinOff aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-warning" />
                  <span>{geoError.message}</span>
                </p>
                <p className="text-base text-muted">
                  {codeAllowsNoLocation
                    ? "Puedes enviar igual: ya sabemos a qué emergencia corresponde."
                    : "Sin tu ubicación no sabemos dónde es la emergencia. Actívala en los ajustes del navegador, o pide a Bomberos el código de la emergencia (VG-XXXX)."}
                </p>
              </div>
            )}
            {needLocation && !geoError && (
              <p role="alert" className="flex items-start gap-2 text-base text-critical">
                <CircleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
                <span>Necesitamos tu ubicación para enviar el reporte.</span>
              </p>
            )}
            <Button
              variant="secondary"
              size="xl"
              icon={geoError ? RefreshCw : LocateFixed}
              loading={locating}
              onClick={() => void requestLocation()}
              fullWidth
            >
              {geoError ? "Intentar de nuevo" : "Compartir mi ubicación"}
            </Button>
            {locating && (
              <p role="status" className="text-base text-muted">
                Buscando tu ubicación…
              </p>
            )}
          </div>
        )}
      </section>

      {/* Enviar. Con algo elegido queda fijo abajo: tras grabar no hay que buscarlo bajo la nota y la ubicación. */}
      <div
        className={cn(
          "flex flex-col gap-2",
          selection &&
            "sticky bottom-0 z-10 -mx-4 border-t border-line bg-bg/95 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur-sm",
        )}
      >
        <Button
          variant="primary"
          size="xl"
          icon={Send}
          fullWidth
          className="min-h-16 text-xl"
          disabled={!selection}
          aria-describedby={!selection ? `${uid}-send-hint` : undefined}
          onClick={() => void send()}
        >
          Enviar a Bomberos
        </Button>
        {!selection && (
          <p id={`${uid}-send-hint`} className="text-center text-base text-muted">
            Primero graba o elige un video o fotos.
          </p>
        )}
        {selection && !geo.position && !codeAllowsNoLocation && (
          <p className="text-center text-base text-muted">Al enviar te pediremos tu ubicación.</p>
        )}
      </div>
    </div>
  );
}
