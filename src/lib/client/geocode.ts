/**
 * Geocodificación con Nominatim (OpenStreetMap) desde el navegador. Sin React.
 * Política de uso de Nominatim: máximo 1 consulta por segundo y solo por acción de la persona
 * (quien llama debe aplicar debounce; ver el diálogo de nuevo incidente).
 */
import type { LatLng } from "@/lib/geo";

/** Resultado de búsqueda de una dirección. */
export interface GeocodeResult {
  label: string;
  lat: number;
  lng: number;
  /** Tipo de lugar según OSM ("house", "road", "city"…). */
  kind: string;
}

/** Base de la API pública de Nominatim. */
export const NOMINATIM_BASE = "https://nominatim.openstreetmap.org";

/** Mínimo de caracteres para buscar. */
export const MIN_QUERY_LENGTH = 3;

const MAX_LABEL_LENGTH = 240;
const SEARCH_ERROR_MESSAGE = "No se pudo buscar la dirección. Fíjala a mano en el mapa.";
const REVERSE_ERROR_MESSAGE = "No se pudo obtener la dirección de este punto.";

/** Falla de red o HTTP al consultar el geocodificador (mensaje apto para mostrar). */
export class GeocodeError extends Error {
  constructor(message: string = SEARCH_ERROR_MESSAGE, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GeocodeError";
  }
}

function isAbortError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { name?: unknown }).name === "AbortError";
}

function toNumber(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : null;
}

function isValidLatLng(lat: number, lng: number): boolean {
  return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

// Partes que son solo un código postal chileno ("8320000", "832-0000"); no confundir con números de calle.
const POSTCODE_ONLY = /^\d{3}[\s-]?\d{4}$/;
// Número de casa que Nominatim pone como primera parte ("1234", "56B").
const HOUSE_NUMBER = /^\d{1,5}[a-zA-Z]?$/;

/**
 * Acorta un `display_name`: sin ", Chile" final, sin partes que son solo código postal ni repetidas,
 * y con el número al estilo chileno ("1234, Avenida Matta" → "Avenida Matta 1234").
 */
export function shortenDisplayName(displayName: string): string {
  const parts = displayName
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "");
  while (parts.length > 1 && parts[parts.length - 1].toLowerCase() === "chile") parts.pop();
  if (parts.length > 2 && HOUSE_NUMBER.test(parts[0])) {
    parts.splice(0, 2, `${parts[1]} ${parts[0]}`);
  }
  const out: string[] = [];
  for (const p of parts) {
    if (POSTCODE_ONLY.test(p)) continue;
    if (out.length > 0 && out[out.length - 1].toLowerCase() === p.toLowerCase()) continue;
    out.push(p);
  }
  return out.join(", ").slice(0, MAX_LABEL_LENGTH);
}

/** Convierte la respuesta jsonv2 de `/search` en resultados válidos (descarta los incompletos). */
export function parseNominatim(json: unknown): GeocodeResult[] {
  if (!Array.isArray(json)) return [];
  const out: GeocodeResult[] = [];
  for (const item of json) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    const lat = toNumber(r.lat);
    const lng = toNumber(r.lon);
    if (lat === null || lng === null || !isValidLatLng(lat, lng)) continue;
    if (typeof r.display_name !== "string") continue;
    const label = shortenDisplayName(r.display_name);
    if (label === "") continue;
    const kindRaw = [r.addresstype, r.type, r.category].find((k) => typeof k === "string" && k !== "");
    out.push({ label, lat, lng, kind: typeof kindRaw === "string" ? kindRaw : "place" });
  }
  return out;
}

/** Dirección legible de la respuesta jsonv2 de `/reverse`, o null si no hay resultado. */
export function parseNominatimReverse(json: unknown): string | null {
  if (typeof json !== "object" || json === null || Array.isArray(json)) return null;
  const r = json as Record<string, unknown>;
  if (r.error !== undefined) return null;
  if (typeof r.display_name !== "string") return null;
  const label = shortenDisplayName(r.display_name);
  return label === "" ? null : label;
}

async function fetchJson(url: string, signal: AbortSignal | undefined, message: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { signal, headers: { Accept: "application/json" } });
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw new GeocodeError(message, { cause: err });
  }
  if (!res.ok) throw new GeocodeError(message, { cause: new Error(`HTTP ${res.status}`) });
  try {
    return await res.json();
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw new GeocodeError(message, { cause: err });
  }
}

/** Busca direcciones en Chile. Consulta corta (< 3 caracteres) → []. Lanza `GeocodeError`; AbortError pasa tal cual. */
export async function searchAddress(
  q: string,
  opts: { signal?: AbortSignal; limit?: number } = {},
): Promise<GeocodeResult[]> {
  const query = q.trim();
  if (query.length < MIN_QUERY_LENGTH) return [];
  const rawLimit = Math.floor(opts.limit ?? 5);
  const limit = Number.isFinite(rawLimit) ? Math.min(10, Math.max(1, rawLimit)) : 5;
  const params = new URLSearchParams({
    format: "jsonv2",
    countrycodes: "cl",
    limit: String(limit),
    "accept-language": "es",
    q: query,
  });
  const json = await fetchJson(`${NOMINATIM_BASE}/search?${params.toString()}`, opts.signal, SEARCH_ERROR_MESSAGE);
  return parseNominatim(json).slice(0, limit);
}

/** Dirección aproximada de un punto, o null si no hay. Lanza `GeocodeError`; AbortError pasa tal cual. */
export async function reverseGeocode(
  lat: number,
  lng: number,
  opts: { signal?: AbortSignal } = {},
): Promise<string | null> {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !isValidLatLng(lat, lng)) return null;
  const params = new URLSearchParams({
    format: "jsonv2",
    lat: String(lat),
    lon: String(lng),
    zoom: "18",
    "accept-language": "es",
  });
  const json = await fetchJson(`${NOMINATIM_BASE}/reverse?${params.toString()}`, opts.signal, REVERSE_ERROR_MESSAGE);
  return parseNominatimReverse(json);
}

function inChile(lat: number, lng: number): boolean {
  // Continental, insular (Juan Fernández) e Isla de Pascua.
  return lat >= -56.5 && lat <= -17 && lng >= -110 && lng <= -66;
}

/**
 * Lee coordenadas escritas a mano ("-33.4489, -70.6693", "-33,4489 -70,6693", copiadas de Google Maps).
 * Si vienen invertidas (longitud primero) y así no caen en Chile pero al revés sí, las corrige. null si no son válidas.
 */
export function parseCoordinates(text: string): LatLng | null {
  const tokens = text.match(/[-+−]?\d+(?:[.,]\d+)?/g);
  if (!tokens || tokens.length !== 2) return null;
  const nums = tokens.map((t) => Number(t.replace("−", "-").replace(",", ".")));
  const [a, b] = nums;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (!inChile(a, b) && inChile(b, a)) return { lat: b, lng: a };
  return isValidLatLng(a, b) ? { lat: a, lng: b } : null;
}
