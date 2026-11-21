/**
 * Códigos de emergencia que escribe un vecino ("vg 7k3q", "7K3Q", "VG-7K3Q").
 * Puro y sin node:crypto: lo usan tanto las páginas de servidor como el navegador.
 * Misma normalización que `normalizeIncidentCode` de `@/lib/ids` (que es solo de servidor).
 */

/** Largo aceptado del cuerpo del código (hoy son 4; se deja margen por si crecen). */
const BODY_PATTERN = /^[A-Z0-9]{4,8}$/;

/** Ejemplo que mostramos en la interfaz. */
export const INCIDENT_CODE_EXAMPLE = "VG-7K3Q";

/** Quita espacios, guiones y signos; pasa a mayúsculas y saca el prefijo "VG" si viene. */
function codeBody(input: string): string {
  const clean = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return clean.startsWith("VG") ? clean.slice(2) : clean;
}

/** "vg 7k3q" → "VG-7K3Q"; null si no tiene forma de código. */
export function parseIncidentCode(input: string | null | undefined): string | null {
  if (typeof input !== "string") return null;
  const body = codeBody(input);
  return BODY_PATTERN.test(body) ? `VG-${body}` : null;
}

/** Primer valor de un parámetro de búsqueda (`?code=a&code=b` → "a"). */
export function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Decodifica un segmento de ruta sin lanzar si viene mal codificado. */
export function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
