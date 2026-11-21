"use client";
/**
 * Diálogo "Nuevo incidente" del puesto de mando: tipo, dirección con búsqueda (Nominatim),
 * pin en el mapa, ubicación del dispositivo o coordenadas a mano, y descripción.
 */
import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { useRouter } from "next/navigation";
import { CircleAlert, Crosshair, LocateFixed, MapPin, PencilLine, Plus, Search, X } from "lucide-react";
import { Button, Dialog, Field, Input, Spinner, Textarea, useToast } from "@/components/ui";
import { LocationPicker } from "@/components/map";
import { api, errorMessage } from "@/lib/client/api";
import {
  GeocodeError,
  MIN_QUERY_LENGTH,
  parseCoordinates,
  reverseGeocode,
  searchAddress,
  type GeocodeResult,
} from "@/lib/client/geocode";
import { useGeolocation } from "@/lib/client/geo";
import { IncidentTypeSchema, type IncidentType } from "@/lib/domain";
import type { LatLng } from "@/lib/geo";
import { incidentTypeIcon, incidentTypeLabel } from "@/lib/labels";
import { formatCoord, formatDistance } from "@/lib/format";
import { cn } from "@/lib/cn";

/** Props del diálogo de nuevo incidente. */
export interface NewIncidentDialogProps {
  open: boolean;
  onClose: () => void;
}

/** Centro por defecto del mapa: Santiago. */
const DEFAULT_CENTER: LatLng = { lat: -33.4489, lng: -70.6693 };
const INCIDENT_TYPES: readonly IncidentType[] = IncidentTypeSchema.options;
/** Nominatim pide como máximo una consulta por segundo. */
const MIN_REQUEST_INTERVAL_MS = 1000;
const SEARCH_FALLBACK_ERROR = "No se pudo buscar la dirección. Fíjala a mano en el mapa.";

type PinSource = "search" | "gps" | "map" | "manual";
type SearchStatus = "idle" | "searching" | "done" | "error";

interface AddressSearch {
  results: GeocodeResult[];
  status: SearchStatus;
  error: string | null;
}

interface SettledSearch {
  query: string;
  results: GeocodeResult[];
  status: "done" | "error";
  error: string | null;
}

function isAbortError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { name?: unknown }).name === "AbortError";
}

/**
 * Búsqueda de direcciones con debounce (≥ 600 ms, ≥ 3 caracteres), cancelando la anterior y
 * respetando 1 consulta/s. El estado "searching" se deriva (sin setState síncrono en efectos).
 */
function useAddressSearch(
  query: string,
  opts: { debounceMs?: number; enabled?: boolean } = {},
): AddressSearch {
  const debounceMs = Math.max(600, opts.debounceMs ?? 600);
  const enabled = opts.enabled ?? true;
  const q = query.trim();
  const active = enabled && q.length >= MIN_QUERY_LENGTH;
  const [settled, setSettled] = useState<SettledSearch | null>(null);
  const lastRequestAt = useRef(0);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const sinceLast = Date.now() - lastRequestAt.current;
    const wait = Math.max(debounceMs, MIN_REQUEST_INTERVAL_MS - sinceLast);
    const timer = setTimeout(() => {
      lastRequestAt.current = Date.now();
      searchAddress(q, { signal: controller.signal }).then(
        (results) => {
          if (!controller.signal.aborted) setSettled({ query: q, results, status: "done", error: null });
        },
        (err: unknown) => {
          if (controller.signal.aborted || isAbortError(err)) return;
          const message = err instanceof GeocodeError ? err.message : SEARCH_FALLBACK_ERROR;
          setSettled({ query: q, results: [], status: "error", error: message });
        },
      );
    }, wait);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [active, q, debounceMs]);

  if (!active) return { results: [], status: "idle", error: null };
  if (!settled || settled.query !== q) {
    // Mientras llega la nueva respuesta se conservan los resultados previos (sin parpadeo).
    return { results: settled?.status === "done" ? settled.results : [], status: "searching", error: null };
  }
  return { results: settled.results, status: settled.status, error: settled.error };
}

/** Diálogo para crear un incidente desde el puesto de mando; al crear navega a `/mando/<id>`. */
export function NewIncidentDialog({ open, onClose }: NewIncidentDialogProps) {
  const formId = useId();
  const [busy, setBusy] = useState(false);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Nuevo incidente"
      description="Indica el tipo de emergencia y dónde es. Lo demás puedes completarlo después."
      size="lg"
      dismissible={!busy}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button variant="primary" type="submit" form={formId} icon={Plus} loading={busy}>
            Crear incidente
          </Button>
        </>
      }
    >
      {/* El Dialog solo monta el contenido abierto: al cerrar, el formulario se reinicia. */}
      <NewIncidentForm formId={formId} busy={busy} onBusyChange={setBusy} onDone={onClose} />
    </Dialog>
  );
}

interface NewIncidentFormProps {
  formId: string;
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
  onDone: () => void;
}

const PIN_SOURCE_TEXT: Record<PinSource, string> = {
  search: "desde la búsqueda",
  gps: "ubicación de este dispositivo",
  map: "fijada en el mapa",
  manual: "fijada a mano",
};

function NewIncidentForm({ formId, busy, onBusyChange, onDone }: NewIncidentFormProps) {
  const router = useRouter();
  const { toast } = useToast();
  const geo = useGeolocation();
  const uid = useId();
  const ids = {
    typeLabel: `${uid}-type`,
    typeError: `${uid}-type-error`,
    title: `${uid}-title`,
    address: `${uid}-address`,
    list: `${uid}-address-list`,
    option: (i: number) => `${uid}-address-opt-${i}`,
    locationError: `${uid}-location-error`,
    manual: `${uid}-manual`,
    description: `${uid}-description`,
  };

  const [type, setType] = useState<IncidentType | null>(null);
  const [title, setTitle] = useState("");
  const [address, setAddress] = useState("");
  const [description, setDescription] = useState("");
  const [pin, setPin] = useState<LatLng | null>(null);
  const [pinSource, setPinSource] = useState<PinSource | null>(null);
  const [accuracyM, setAccuracyM] = useState<number | null>(null);
  // Texto puesto por nosotros (resultado elegido o dirección inversa): no se vuelve a buscar.
  const [programmaticAddress, setProgrammaticAddress] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualText, setManualText] = useState("");
  const [manualError, setManualError] = useState<string | null>(null);
  const [reverseBusy, setReverseBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const typeGroupRef = useRef<HTMLDivElement | null>(null);
  const addressRef = useRef<HTMLInputElement | null>(null);
  const reverseAbort = useRef<AbortController | null>(null);

  useEffect(() => () => reverseAbort.current?.abort(), []);

  const search = useAddressSearch(address, { enabled: address !== programmaticAddress });
  const showList = listOpen && search.status !== "idle";
  const showManual = manualOpen || search.status === "error";
  const activeOption = showList && activeIndex >= 0 && activeIndex < search.results.length ? activeIndex : -1;

  const typeError = submitted && !type ? "Elige el tipo de emergencia." : null;
  const locationError =
    submitted && !pin
      ? address.trim()
        ? "La dirección sola no basta: elige un resultado de la búsqueda, usa tu ubicación o fija el punto en el mapa."
        : "Indica dónde es: busca la dirección, usa tu ubicación o fija el punto en el mapa."
      : null;

  function placePin(value: LatLng, source: PinSource, accuracy: number | null = null) {
    setPin(value);
    setPinSource(source);
    setAccuracyM(accuracy);
  }

  function clearPin() {
    setPin(null);
    setPinSource(null);
    setAccuracyM(null);
  }

  function selectResult(r: GeocodeResult) {
    setAddress(r.label);
    setProgrammaticAddress(r.label);
    placePin({ lat: r.lat, lng: r.lng }, "search");
    setListOpen(false);
    setActiveIndex(-1);
  }

  function onAddressKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    const n = search.results.length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setListOpen(true);
      if (n > 0) setActiveIndex((i) => (i < 0 || i >= n - 1 ? 0 : i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setListOpen(true);
      if (n > 0) setActiveIndex((i) => (i <= 0 || i >= n ? n - 1 : i - 1));
    } else if (e.key === "Enter") {
      if (activeOption >= 0) {
        e.preventDefault();
        selectResult(search.results[activeOption]);
      } else if (showList) {
        // Con la lista abierta, Enter no envía el formulario a medias.
        e.preventDefault();
      }
    } else if (e.key === "Escape" && showList) {
      // Cierra solo la lista, no el diálogo.
      e.preventDefault();
      e.stopPropagation();
      setListOpen(false);
      setActiveIndex(-1);
    }
  }

  async function locateMe() {
    const pos = await geo.request();
    if (!pos) return;
    placePin({ lat: pos.lat, lng: pos.lng }, "gps", pos.accuracy_m);
    if (address.trim() !== "") return;
    reverseAbort.current?.abort();
    const controller = new AbortController();
    reverseAbort.current = controller;
    setReverseBusy(true);
    try {
      const label = await reverseGeocode(pos.lat, pos.lng, { signal: controller.signal });
      if (controller.signal.aborted || !label) return;
      // Solo si la persona no escribió nada mientras tanto.
      setAddress((prev) => (prev.trim() === "" ? label : prev));
      setProgrammaticAddress(label);
    } catch {
      // Sin dirección inversa la ubicación igual sirve; la dirección se puede escribir.
    } finally {
      if (reverseAbort.current === controller) {
        reverseAbort.current = null;
        setReverseBusy(false);
      }
    }
  }

  function applyManual() {
    const parsed = parseCoordinates(manualText);
    if (!parsed) {
      setManualError("No reconocemos esas coordenadas. Escríbelas como «-33.4489, -70.6693» (latitud, longitud).");
      return;
    }
    setManualError(null);
    placePin(parsed, "manual");
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setSubmitted(true);
    setSubmitError(null);
    if (!type) {
      const group = typeGroupRef.current;
      group?.querySelector<HTMLElement>("[role=radio]")?.focus();
      return;
    }
    if (!pin) {
      addressRef.current?.focus();
      return;
    }
    onBusyChange(true);
    try {
      const trimmedTitle = title.trim();
      const { incident } = await api.incidents.create({
        type,
        ...(trimmedTitle ? { title: trimmedTitle.slice(0, 140) } : {}),
        address: address.trim().slice(0, 240),
        lat: pin.lat,
        lng: pin.lng,
        description: description.trim().slice(0, 2000),
      });
      toast({ title: "Incidente creado", description: `${incident.title} · ${incident.code}`, tone: "ok" });
      router.push(`/mando/${encodeURIComponent(incident.id)}`);
      onDone();
    } catch (err) {
      setSubmitError(errorMessage(err));
    } finally {
      onBusyChange(false);
    }
  }

  function onTypeKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const keys = ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    const current = type ? INCIDENT_TYPES.indexOf(type) : -1;
    const last = INCIDENT_TYPES.length - 1;
    let next: number;
    if (e.key === "Home") next = 0;
    else if (e.key === "End") next = last;
    else if (e.key === "ArrowRight" || e.key === "ArrowDown") next = current < 0 || current >= last ? 0 : current + 1;
    else next = current <= 0 ? last : current - 1;
    setType(INCIDENT_TYPES[next]);
    typeGroupRef.current?.querySelectorAll<HTMLElement>("[role=radio]")[next]?.focus();
  }

  const geoLocating = geo.status === "locating";

  return (
    <form id={formId} onSubmit={handleSubmit} noValidate className="flex flex-col gap-5">
      {/* Tipo */}
      <div className="flex flex-col gap-1.5">
        <span id={ids.typeLabel} className="label-caps block text-xs text-muted">
          Tipo de emergencia
          <span aria-hidden="true" className="text-critical">
            {" *"}
          </span>
          <span className="sr-only"> (obligatorio)</span>
        </span>
        <div
          ref={typeGroupRef}
          role="radiogroup"
          aria-labelledby={ids.typeLabel}
          aria-required="true"
          aria-invalid={typeError ? true : undefined}
          aria-describedby={typeError ? ids.typeError : undefined}
          onKeyDown={onTypeKeyDown}
          className="grid grid-cols-2 gap-2 sm:grid-cols-4"
        >
          {INCIDENT_TYPES.map((t, i) => {
            const Icon = incidentTypeIcon[t];
            const checked = type === t;
            const focusable = checked || (type === null && i === 0);
            return (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={checked}
                tabIndex={focusable ? 0 : -1}
                data-autofocus={i === 0 ? true : undefined}
                onClick={() => setType(t)}
                className={cn(
                  "flex min-h-20 flex-col items-center justify-center gap-1.5 rounded-md border px-2 py-2.5 text-center text-sm leading-tight transition-colors",
                  "outline-hidden focus-visible:ring-2 focus-visible:ring-info",
                  checked
                    ? "border-accent bg-accent/15 text-text"
                    : "border-line bg-surface-2 text-muted hover:border-line-strong hover:text-text",
                  typeError && !checked && "border-critical/60",
                )}
              >
                <Icon aria-hidden="true" className={cn("size-6 shrink-0", checked ? "text-accent" : "")} />
                <span className="font-medium">{incidentTypeLabel[t]}</span>
              </button>
            );
          })}
        </div>
        {typeError && (
          <p id={ids.typeError} className="flex items-start gap-1.5 text-sm text-critical">
            <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span>{typeError}</span>
          </p>
        )}
      </div>

      {/* Dirección con búsqueda */}
      <div className="flex flex-col gap-1.5">
        <label htmlFor={ids.address} className="label-caps block text-xs text-muted">
          Dirección
        </label>
        <Input
          ref={addressRef}
          id={ids.address}
          icon={Search}
          value={address}
          maxLength={240}
          autoComplete="off"
          spellCheck={false}
          placeholder="Calle, número y comuna (p. ej. Av. Matta 500, Santiago)"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={showList}
          aria-controls={ids.list}
          aria-activedescendant={activeOption >= 0 ? ids.option(activeOption) : undefined}
          aria-invalid={locationError ? true : undefined}
          aria-describedby={locationError ? ids.locationError : undefined}
          onChange={(e) => {
            setAddress(e.target.value);
            setListOpen(true);
            setActiveIndex(-1);
          }}
          onFocus={() => setListOpen(true)}
          onBlur={() => setListOpen(false)}
          onKeyDown={onAddressKeyDown}
        />
        <div
          id={ids.list}
          role="listbox"
          aria-label="Resultados de la búsqueda"
          hidden={!showList}
          className="overflow-hidden rounded-md border border-line bg-surface-2"
        >
          {search.results.map((r, i) => (
            <div
              key={`${r.lat},${r.lng},${r.label}`}
              id={ids.option(i)}
              role="option"
              aria-selected={i === activeOption}
              // mousedown en vez de click: así el blur del campo no cierra la lista antes de elegir.
              onMouseDown={(e) => {
                e.preventDefault();
                selectResult(r);
              }}
              onMouseEnter={() => setActiveIndex(i)}
              className={cn(
                "flex cursor-pointer items-start gap-2 border-b border-line px-3 py-2 text-sm last:border-b-0",
                i === activeOption ? "bg-info-soft text-text" : "text-muted hover:text-text",
              )}
            >
              <MapPin aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-faint" />
              <span className="min-w-0">{r.label}</span>
            </div>
          ))}
          {search.status === "searching" && search.results.length === 0 && (
            <div className="flex items-center gap-2 px-3 py-2 text-sm text-muted">
              <Spinner size="xs" label="Buscando" />
              Buscando…
            </div>
          )}
          {search.status === "done" && search.results.length === 0 && (
            <p className="px-3 py-2 text-sm text-muted">
              Sin resultados. Prueba con calle y comuna, o fija el punto en el mapa.
            </p>
          )}
          {search.status === "error" && (
            <p className="flex items-start gap-2 px-3 py-2 text-sm text-warning">
              <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              <span>{search.error}</span>
            </p>
          )}
        </div>
        <p className="text-xs text-faint" aria-live="polite">
          {search.status === "searching" && search.results.length > 0
            ? "Actualizando resultados…"
            : search.status === "done" && search.results.length > 0 && showList
              ? `${search.results.length} resultados · usa ↑ ↓ y Enter para elegir`
              : reverseBusy
                ? "Buscando la dirección de tu ubicación…"
                : "Busca la dirección y elige un resultado, o marca el punto en el mapa."}
        </p>
      </div>

      {/* Ubicación */}
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="label-caps block text-xs text-muted">
            Ubicación
            <span aria-hidden="true" className="text-critical">
              {" *"}
            </span>
            <span className="sr-only"> (obligatoria)</span>
          </span>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" icon={LocateFixed} loading={geoLocating} onClick={() => void locateMe()}>
              Usar mi ubicación
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={PencilLine}
              aria-expanded={showManual}
              aria-controls={ids.manual}
              onClick={() => setManualOpen((v) => !v)}
            >
              Fijar a mano
            </Button>
          </div>
        </div>

        <LocationPicker
          value={pin}
          onChange={(v) => placePin(v, "map")}
          initialCenter={DEFAULT_CENTER}
          theme="dark"
          className="h-56"
        />

        <div
          className={cn(
            "flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-3 py-2 text-sm",
            pin ? "border-line bg-surface-2" : locationError ? "border-critical/60 bg-critical-soft" : "border-line",
          )}
          aria-live="polite"
        >
          {pin ? (
            <>
              <Crosshair aria-hidden="true" className="size-4 shrink-0 text-accent" />
              <span className="font-mono tabular text-text">{formatCoord(pin.lat, pin.lng)}</span>
              <span className="text-muted">
                {pinSource ? PIN_SOURCE_TEXT[pinSource] : ""}
                {pinSource === "gps" && accuracyM !== null ? ` · ±${formatDistance(accuracyM)}` : ""}
              </span>
              <Button size="sm" variant="ghost" icon={X} className="ml-auto" onClick={clearPin}>
                Quitar
              </Button>
            </>
          ) : (
            <span className="text-muted">Sin ubicación todavía.</span>
          )}
        </div>

        {geo.status === "error" && geo.error && (
          <p role="alert" className="flex items-start gap-1.5 text-sm text-warning">
            <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span>{geo.error.message}</span>
          </p>
        )}

        {locationError && (
          <p id={ids.locationError} className="flex items-start gap-1.5 text-sm text-critical">
            <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span>{locationError}</span>
          </p>
        )}

        <div id={ids.manual} hidden={!showManual} className="rounded-md border border-line p-3">
          <Field
            label="Coordenadas (latitud, longitud)"
            htmlFor={`${ids.manual}-input`}
            hint="Puedes pegarlas desde Google Maps, p. ej. -33.4489, -70.6693."
            error={manualError}
          >
            <div className="flex gap-2">
              <Input
                id={`${ids.manual}-input`}
                value={manualText}
                inputMode="decimal"
                autoComplete="off"
                spellCheck={false}
                placeholder="-33.4489, -70.6693"
                className="font-mono"
                invalid={manualError !== null}
                aria-describedby={manualError ? `${ids.manual}-input-error` : `${ids.manual}-input-hint`}
                onChange={(e) => {
                  setManualText(e.target.value);
                  setManualError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    applyManual();
                  }
                }}
              />
              <Button onClick={applyManual} icon={MapPin} className="shrink-0">
                Fijar
              </Button>
            </div>
          </Field>
        </div>
      </div>

      {/* Título y descripción */}
      <Field label="Título" htmlFor={ids.title} optional hint="Un nombre corto para reconocerlo en la lista.">
        <Input
          id={ids.title}
          value={title}
          maxLength={140}
          autoComplete="off"
          placeholder="p. ej. Incendio en bodega con personas en el segundo piso"
          aria-describedby={`${ids.title}-hint`}
          onChange={(e) => setTitle(e.target.value)}
        />
      </Field>

      <Field label="Descripción" htmlFor={ids.description} optional>
        <Textarea
          id={ids.description}
          value={description}
          maxLength={2000}
          autoGrow
          rows={3}
          placeholder="Lo que se sabe: quién llamó, qué vio, si hay personas adentro…"
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>

      {submitError && (
        <p role="alert" className="flex items-start gap-2 rounded-md border border-critical/50 bg-critical-soft px-3 py-2 text-sm text-critical">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>{submitError}</span>
        </p>
      )}
    </form>
  );
}
