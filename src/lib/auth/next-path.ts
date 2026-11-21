/**
 * Saneamiento del parámetro `?next=` del login (evita redirecciones abiertas).
 * Puro: lo usan la página de login, la ruta de login y src/proxy.ts.
 */

export const DEFAULT_NEXT_PATH = "/mando";

/**
 * Devuelve `input` si es una ruta interna segura; si no, `fallback`.
 * Acepta solo rutas que empiezan con "/" y no con "//" ni "/\" (que el navegador
 * interpreta como otro dominio), sin barras invertidas ni caracteres de control.
 * Nunca devuelve /login (evita el bucle de volver al formulario).
 */
export function sanitizeNextPath(
  input: string | null | undefined,
  fallback: string = DEFAULT_NEXT_PATH,
): string {
  if (typeof input !== "string") return fallback;
  const path = input.trim();
  if (path.length === 0 || path.length > 2048) return fallback;
  if (!path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\")) return fallback;
  if (path.includes("\\")) return fallback;
  for (let i = 0; i < path.length; i++) {
    const c = path.charCodeAt(i);
    if (c <= 0x20 || c === 0x7f) return fallback; // control o espacio
  }
  if (/\s/.test(path)) return fallback;
  let parsed: URL;
  try {
    parsed = new URL(path, "http://vigia.invalid");
  } catch {
    return fallback;
  }
  if (parsed.origin !== "http://vigia.invalid") return fallback;
  if (parsed.pathname === "/login" || parsed.pathname.startsWith("/login/")) return fallback;
  return path;
}
