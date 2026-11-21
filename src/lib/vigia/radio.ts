/**
 * Lectura de la radio para Vigía: pedidos que quedan pendientes y su confirmación.
 * Puro. Las claves vienen del libro configurado (src/lib/ai/radio-claves.ts).
 */
import { claveByCode, findClaves } from "@/lib/ai/radio-claves";
import { fold } from "./rules";

/** Material mayor que despacha cada clave 2-X (letras de los carros). */
const DISPATCH_LETTERS: Record<string, string[]> = {
  "2-0": ["B", "BX", "F"],
  "2-1": ["Q"],
  "2-2": ["R", "RX"],
  "2-3": ["S"],
  "2-4": ["Z"],
  "2-5": ["H", "HX"],
  "2-7": ["M"],
  "2-8": ["J"],
  "2-9": ["K"],
  "2-12": ["C"],
};

/** Palabras que piden algo; las claves 1-X, 2-X y 6-6 son pedidos por sí mismas tras ellas. */
const ASK = /\b(pide|pido|pedimos|solicita|solicito|solicitamos|se solicita|se solicitan|necesito|necesitamos|necesita|requiere|requerimos|envien|manden)\b/;

/** Pedidos en claro, sin clave. */
const PLAIN_REQUESTS: { re: RegExp; text: string; clave: string | null }[] = [
  { re: /\b(ambulancia|samu)\b/, text: "ambulancia SAMU", clave: "1-2" },
  { re: /\bcarabineros\b/, text: "Carabineros", clave: "1-0" },
  { re: /\b(carro de rescate|rescate)\b/, text: "carro de rescate", clave: "2-2" },
  { re: /\b(escala|porta escala|mecanica)\b/, text: "carro escala", clave: "2-1" },
  { re: /\b(cisterna|agua)\b/, text: "carro cisterna", clave: "2-4" },
  { re: /\b(hazmat|matpel)\b/, text: "carro HazMat", clave: "2-5" },
  { re: /\b(personal|mas gente|refuerzo)\b/, text: "más personal", clave: "6-6" },
  { re: /\binstrucciones\b/, text: "instrucciones", clave: "6-4" },
];

/** Confirmación de que lo pedido va o llegó. */
const CONFIRM =
  /\b(en camino|despacho|despacha|despachado|despachada|despachamos|enviado|enviada|enviamos|va al lugar|van al lugar|sale|salimos|saliendo|llegando|en el lugar|confirmado|confirmada|conforme|recibido|0-6|0-7|6-3)\b/;

/** "Se solicita al lugar: ambulancia SAMU" → "ambulancia SAMU"; "Despache al lugar: carro de rescate (R, RX)" → "carro de rescate". */
function shortMeaning(meaning: string): string {
  return meaning
    .replace(/^(se solicita al lugar|despache al lugar)\s*:\s*/i, "")
    .replace(/\s*\([A-Z, ]+\)\s*$/, "")
    .trim();
}

export interface RadioRequest {
  /** "2-2 (Carro de rescate)" o "ambulancia SAMU". */
  text: string;
  clave: string | null;
}

/** Pedidos de recursos en una línea de radio. Vacío si no pide nada. */
export function radioRequests(text: string): RadioRequest[] {
  const t = fold(text);
  if (!ASK.test(t) && !/\b6-6\b|\b6-4\b/.test(t.replace(/[‐-―−]/g, "-"))) return [];
  const out: RadioRequest[] = [];
  const seen = new Set<string>();
  for (const hit of findClaves(text)) {
    const code = hit.clave.code;
    if (!/^(1-\d+|2-\d+|6-6|6-4)$/.test(code) || seen.has(code)) continue;
    seen.add(code);
    out.push({ text: `${code} (${shortMeaning(hit.clave.meaning)})`, clave: code });
  }
  if (out.length === 0) {
    for (const p of PLAIN_REQUESTS) {
      if (p.re.test(t) && !seen.has(p.clave ?? p.text)) {
        seen.add(p.clave ?? p.text);
        const meaning = p.clave ? claveByCode(p.clave)?.meaning : null;
        out.push({ text: p.clave && meaning ? `${p.clave} (${shortMeaning(meaning)})` : p.text, clave: p.clave });
      }
    }
  }
  return out;
}

/** Indicativos de carro en el texto ("R-1", "RX 15") → letras ("R", "RX"). */
function unitLetters(text: string): string[] {
  const out: string[] = [];
  for (const m of text.toUpperCase().matchAll(/\b([A-Z]{1,2}X?)\s?-\s?\d{1,2}\b/g)) out.push(m[1]);
  return out;
}

/**
 * true si la línea confirma el pedido: repite la clave (o el carro que corresponde) junto a
 * una palabra de despacho o llegada. "Central: despacho R-1 al lugar" confirma un 2-2.
 */
export function confirmsRequest(text: string, clave: string | null, requestText: string): boolean {
  const t = fold(text).replace(/[‐-―−]/g, "-");
  if (!CONFIRM.test(t)) return false;
  if (clave) {
    if (new RegExp(`(^|[^0-9-])${clave.replace("-", "\\s?-\\s?")}($|[^0-9-])`).test(t)) return true;
    const letters = DISPATCH_LETTERS[clave];
    if (letters && unitLetters(text).some((l) => letters.includes(l))) return true;
    if (clave === "1-2" && /\b(ambulancia|samu)\b/.test(t)) return true;
    if (clave === "1-0" && /\bcarabineros\b/.test(t)) return true;
    return false;
  }
  const key = fold(requestText).split(" ")[0];
  return key.length > 3 && t.includes(key);
}

/** Línea de radio con las claves traducidas: «6-7» → «6-7 (Situación controlada)». */
export { expandClaves } from "@/lib/ai/radio-claves";
