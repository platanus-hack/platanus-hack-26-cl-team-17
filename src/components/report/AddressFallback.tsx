"use client";

/**
 * Plan B cuando el vecino no puede compartir su ubicación y no tiene el código de la
 * emergencia: escribe la dirección o una esquina y la elige de una lista (Nominatim, solo
 * en Chile). Así el video llega igual y Bomberos sabe dónde es, aunque sea aproximado.
 * Se busca al tocar «Buscar» (no mientras escribe), como pide la política de Nominatim.
 */
import { useState, type FormEvent } from "react";
import { MapPin, Search } from "lucide-react";
import { Button } from "@/components/ui";
import { MIN_QUERY_LENGTH, searchAddress, type GeocodeResult } from "@/lib/client/geocode";
import { cn } from "@/lib/cn";

/** Lugar elegido por el vecino. */
export interface TypedPlace {
  label: string;
  lat: number;
  lng: number;
}

/** Precisión que se informa para una dirección escrita (m): es aproximada. */
export const TYPED_PLACE_ACCURACY_M = 250;

export function AddressFallback({
  value,
  onChange,
  idPrefix,
}: {
  value: TypedPlace | null;
  onChange: (place: TypedPlace | null) => void;
  idPrefix: string;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GeocodeResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = async (e: FormEvent) => {
    e.preventDefault();
    if (query.trim().length < MIN_QUERY_LENGTH) {
      setError("Escribe al menos una calle y un número, o dos calles.");
      return;
    }
    setSearching(true);
    setError(null);
    try {
      const found = await searchAddress(query, { limit: 4 });
      setResults(found);
      if (found.length === 0) setError("No encontramos esa dirección. Prueba con la calle, el número y la comuna.");
    } catch {
      setError("No pudimos buscar la dirección. Revisa tu conexión e inténtalo de nuevo.");
    } finally {
      setSearching(false);
    }
  };

  if (value) {
    return (
      <div className="flex flex-col gap-2">
        <p role="status" className="flex items-start gap-2 text-base text-text">
          <MapPin aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-ok" />
          <span>
            <strong>Dirección lista:</strong> {value.label}
          </span>
        </p>
        <Button variant="ghost" size="xl" fullWidth onClick={() => onChange(null)}>
          Cambiar dirección
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-3">
      <label htmlFor={`${idPrefix}-address`} className="text-base font-semibold text-text">
        ¿No puedes compartirla? Escribe dónde es
      </label>
      <form onSubmit={(e) => void search(e)} className="flex gap-2">
        <input
          id={`${idPrefix}-address`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Ej.: Av. Grecia 1234, Ñuñoa"
          autoComplete="street-address"
          enterKeyHint="search"
          className="h-12 min-w-0 flex-1 rounded-lg border border-line-strong bg-bg px-3 text-lg text-text outline-none placeholder:text-faint focus:border-text"
        />
        <Button type="submit" variant="secondary" size="xl" icon={Search} loading={searching} className="px-4">
          Buscar
        </Button>
      </form>
      {error && (
        <p role="alert" className="text-base text-warning">
          {error}
        </p>
      )}
      {results && results.length > 0 && (
        <ul className="flex flex-col gap-1.5" aria-label="Direcciones encontradas">
          {results.map((r) => (
            <li key={`${r.lat},${r.lng}`}>
              <button
                type="button"
                onClick={() => onChange({ label: r.label, lat: r.lat, lng: r.lng })}
                className={cn(
                  "flex min-h-12 w-full items-start gap-2 rounded-lg border border-line bg-bg px-3 py-2.5 text-left text-base text-text",
                  "hover:border-line-strong",
                )}
              >
                <MapPin aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-muted" />
                <span>{r.label}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
