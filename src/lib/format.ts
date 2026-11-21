/**
 * Formato de fechas, horas, distancias y cifras para la UI (es-CL).
 *
 * Puro: sin React ni APIs del navegador. Las horas usan la zona horaria local
 * del entorno que ejecuta el código. Valores inválidos o ausentes devuelven "—".
 */

/** Texto que se muestra cuando un valor falta o no es válido. */
export const EMPTY_VALUE = "—";

/** Entrada aceptada para fechas: ISO, milisegundos epoch o `Date`. */
export type DateInput = string | number | Date;

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const numberFormatters = new Map<string, Intl.NumberFormat>();

function numberFormatter(minDigits: number, maxDigits: number): Intl.NumberFormat {
  const key = `${minDigits}:${maxDigits}`;
  let f = numberFormatters.get(key);
  if (!f) {
    f = new Intl.NumberFormat("es-CL", {
      minimumFractionDigits: minDigits,
      maximumFractionDigits: maxDigits,
    });
    numberFormatters.set(key, f);
  }
  return f;
}

function toTime(input: DateInput): number {
  if (input instanceof Date) return input.getTime();
  if (typeof input === "number") return input;
  return Date.parse(input);
}

function toValidDate(input: DateInput): Date | null {
  const t = toTime(input);
  return Number.isFinite(t) ? new Date(t) : null;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function clampDigits(digits: number): number {
  if (!Number.isFinite(digits)) return 0;
  return Math.min(20, Math.max(0, Math.trunc(digits)));
}

/** Hora local 24 h: "14:05:09" o, con `seconds: false`, "14:05". */
export function formatClock(input: DateInput, opts: { seconds?: boolean } = {}): string {
  const d = toValidDate(input);
  if (!d) return EMPTY_VALUE;
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return opts.seconds === false ? hm : `${hm}:${pad2(d.getSeconds())}`;
}

/** Fecha local "21-11-2026" (dd-mm-aaaa, como se escribe en Chile). */
export function formatDate(input: DateInput): string {
  const d = toValidDate(input);
  if (!d) return EMPTY_VALUE;
  return `${pad2(d.getDate())}-${pad2(d.getMonth() + 1)}-${d.getFullYear()}`;
}

/** Fecha y hora local "21-11-2026 14:05" (con `seconds: true`, "21-11-2026 14:05:09"). */
export function formatDateTime(input: DateInput, opts: { seconds?: boolean } = {}): string {
  const d = toValidDate(input);
  if (!d) return EMPTY_VALUE;
  return `${formatDate(d)} ${formatClock(d, { seconds: opts.seconds === true })}`;
}

/** Tiempo transcurrido "HH:MM:SS" (las horas pueden pasar de 99: "123:04:05"); negativo → "00:00:00". */
export function formatElapsed(fromIso: DateInput, to: DateInput = Date.now()): string {
  const from = toTime(fromIso);
  const until = toTime(to);
  if (!Number.isFinite(from) || !Number.isFinite(until)) return "--:--:--";
  const total = Math.max(0, Math.floor((until - from) / SECOND));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

/** Días calendario locales entre dos instantes (b − a), sin depender de la duración del día. */
function calendarDayDiff(a: number, b: number): number {
  const da = new Date(a);
  const db = new Date(b);
  const ua = Date.UTC(da.getFullYear(), da.getMonth(), da.getDate());
  const ub = Date.UTC(db.getFullYear(), db.getMonth(), db.getDate());
  return Math.round((ub - ua) / DAY);
}

/** Tiempo relativo: "recién", "hace 45 s", "hace 12 min", "hace 3 h", "ayer", "hace 3 días"; luego la fecha. Futuro: "en 2 min". */
export function timeAgo(iso: DateInput, now: DateInput = Date.now()): string {
  const t = toTime(iso);
  const n = toTime(now);
  if (!Number.isFinite(t) || !Number.isFinite(n)) return EMPTY_VALUE;
  const diff = n - t;

  // Desfases de reloj de unos pocos segundos no deben mostrarse como futuro.
  if (Math.abs(diff) < 10 * SECOND) return "recién";

  if (diff < 0) {
    const ahead = -diff;
    if (ahead < MINUTE) return `en ${Math.floor(ahead / SECOND)} s`;
    if (ahead < HOUR) return `en ${Math.floor(ahead / MINUTE)} min`;
    if (ahead < DAY) return `en ${Math.floor(ahead / HOUR)} h`;
    return formatDate(t);
  }

  if (diff < MINUTE) return `hace ${Math.floor(diff / SECOND)} s`;
  if (diff < HOUR) return `hace ${Math.floor(diff / MINUTE)} min`;
  if (diff < DAY) return `hace ${Math.floor(diff / HOUR)} h`;
  const days = Math.max(1, calendarDayDiff(t, n));
  if (days === 1) return "ayer";
  if (days < 7) return `hace ${days} días`;
  return formatDate(t);
}

/** Distancia en metros: "85 m", "1,2 km", "12 km" (≥ 10 km sin decimales); null → "—". */
export function formatDistance(m: number | null | undefined): string {
  if (m == null || !Number.isFinite(m)) return EMPTY_VALUE;
  const meters = Math.round(Math.max(0, m));
  if (meters < 1000) return `${meters} m`;
  const km = Math.round(meters / 100) / 10;
  if (km < 10) return `${numberFormatter(1, 1).format(km)} km`;
  return `${numberFormatter(0, 0).format(Math.round(meters / 1000))} km`;
}

/** Duración en segundos: "45 s", "1 min 05 s", "1 h 02 min"; null → "—". */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return EMPTY_VALUE;
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total} s`;
  if (total < 3600) return `${Math.floor(total / 60)} min ${pad2(total % 60)} s`;
  const minutes = Math.floor(total / 60);
  return `${Math.floor(minutes / 60)} h ${pad2(minutes % 60)} min`;
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** Tamaño en bytes (base 1024, coma decimal): "512 B", "1,5 KB", "12,3 MB", "1,02 GB"; null → "—". */
export function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n < 0) return EMPTY_VALUE;
  if (n < 1024) return `${Math.round(n)} B`;
  let unit = 0;
  let value = n;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digitsFor = (u: number) => (u >= 3 ? 2 : 1);
  const factor = 10 ** digitsFor(unit);
  // Si el redondeo llega a 1024 se pasa a la unidad siguiente ("1024 KB" → "1 MB").
  if (Math.round(value * factor) / factor >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${numberFormatter(0, digitsFor(unit)).format(value)} ${BYTE_UNITS[unit]}`;
}

/** Coordenadas con punto decimal (se pegan tal cual en mapas): "-33.44890, -70.66930". */
export function formatCoord(lat: number, lng: number, digits = 5): string {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return EMPTY_VALUE;
  const d = clampDigits(digits);
  return `${lat.toFixed(d)}, ${lng.toFixed(d)}`;
}

/** Número en formato es-CL con `digits` decimales fijos: 12345.6 → "12.345,6". */
export function formatNumber(n: number, digits = 0): string {
  if (!Number.isFinite(n)) return EMPTY_VALUE;
  const d = clampDigits(digits);
  return numberFormatter(d, d).format(n);
}

/** Proporción 0..1 como porcentaje: 0.63 → "63 %". */
export function formatPercent(ratio: number, digits = 0): string {
  if (!Number.isFinite(ratio)) return EMPTY_VALUE;
  return `${formatNumber(ratio * 100, digits)} %`;
}

/** Cantidad con sustantivo: "1 video", "3 videos" (plural por defecto: singular + "s"). */
export function pluralize(n: number, singular: string, plural?: string): string {
  const word = n === 1 ? singular : (plural ?? `${singular}s`);
  const count = Number.isInteger(n) ? formatNumber(n) : numberFormatter(0, 2).format(n);
  return `${count} ${word}`;
}

const CARDINALS_ES = ["N", "NE", "E", "SE", "S", "SO", "O", "NO"] as const;

/**
 * Rumbo en grados con punto cardinal (8 rumbos): 45 → "45° NE"; null → "—".
 * Valores negativos se tratan como desconocidos: el dominio usa -1 para "se desconoce".
 */
export function formatHeading(deg: number | null | undefined): string {
  if (deg == null || !Number.isFinite(deg) || deg < 0) return EMPTY_VALUE;
  const rounded = Math.round(deg) % 360;
  const idx = Math.round(rounded / 45) % 8;
  return `${rounded}° ${CARDINALS_ES[idx]}`;
}
