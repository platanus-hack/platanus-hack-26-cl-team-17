/**
 * Códigos QR como SVG (para imprimir o mostrar el enlace de una emergencia).
 * Sin globals del navegador: funciona igual en SSR, node y cliente.
 */
import QRCode from "qrcode";
import type { QRCodeErrorCorrectionLevel, QRCodeToStringOptionsOther } from "qrcode";

export interface QrOptions {
  /** Zona blanca alrededor, en módulos. Por defecto 2. */
  margin?: number;
  /** Color de los módulos, hex "#RRGGBB" o "#RRGGBBAA". Por defecto "#000000". */
  dark?: string;
  /** Color de fondo, hex; "#00000000" para transparente. Por defecto "#ffffff". */
  light?: string;
  /** Por defecto "M" (aguanta ~15 % del código dañado o tapado). */
  errorCorrectionLevel?: QRCodeErrorCorrectionLevel;
  /** Ancho en px del SVG; sin él, el SVG escala al contenedor (solo viewBox). */
  width?: number;
}

// qrcode solo entiende hex; con otro formato no falla, pero pinta cualquier cosa.
const HEX_COLOR = /^#?(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** SVG del código QR como texto. Rechaza con mensaje en español si el texto está vacío o no cabe. */
export async function qrSvgString(text: string, opts: QrOptions = {}): Promise<string> {
  if (!text) throw new Error("No hay nada que poner en el código QR.");
  for (const color of [opts.dark, opts.light]) {
    if (color !== undefined && !HEX_COLOR.test(color)) {
      throw new Error("Color inválido para el código QR: usa formato #RRGGBB.");
    }
  }
  const options: QRCodeToStringOptionsOther = {
    type: "svg",
    margin: opts.margin ?? 2,
    errorCorrectionLevel: opts.errorCorrectionLevel ?? "M",
    color: { dark: opts.dark ?? "#000000", light: opts.light ?? "#ffffff" },
  };
  if (opts.width !== undefined) options.width = opts.width;
  try {
    return await QRCode.toString(text, options);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (/color/i.test(detail)) throw new Error("Color inválido para el código QR: usa formato #RRGGBB.");
    if (/too big|version/i.test(detail)) {
      throw new Error("No pudimos generar el código QR: el texto es demasiado largo.");
    }
    throw new Error("No pudimos generar el código QR.");
  }
}

/** Convierte un SVG en data URL usable en <img src>. */
export function svgToDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** Código QR como "data:image/svg+xml;charset=utf-8,…". */
export async function qrSvgDataUrl(text: string, opts?: QrOptions): Promise<string> {
  return svgToDataUrl(await qrSvgString(text, opts));
}
