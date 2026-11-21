/**
 * Reglas duras de Vigía. Módulo puro: sin Next, sin store y sin config.
 *
 * Las aplica el agente antes de guardar cada mensaje y las vuelve a aplicar el
 * puente Zello justo antes de transmitir (última barrera). Están en el código y no
 * solo en el prompt porque un error aquí cuesta vidas:
 *  - Vigía nunca afirma que no hay personas: dice lo que no ve.
 *  - Vigía no da órdenes a las unidades ni decide la táctica: lo oye todo el canal.
 *  - Como máximo un mensaje hablado cada ~20 s, salvo una posible persona.
 *  - "Vigía, silencio" deja solo la pantalla, salvo una posible persona.
 *  - Al público solo se le pide un ángulo, siempre "sin acercarse".
 */

/** Prioridad de un mensaje: persona posible > riesgo > recursos > el resto. */
export type VigiaPriority = "persona" | "riesgo" | "recursos" | "resto";

export const VIGIA_PRIORITIES: readonly VigiaPriority[] = ["persona", "riesgo", "recursos", "resto"];

/** Menor = más urgente. */
export const PRIORITY_RANK: Record<VigiaPriority, number> = { persona: 0, riesgo: 1, recursos: 2, resto: 3 };

export function comparePriority(a: VigiaPriority, b: VigiaPriority): number {
  return PRIORITY_RANK[a] - PRIORITY_RANK[b];
}

/** Separación mínima entre dos mensajes hablados (salvo prioridad "persona"). */
export const SPOKEN_MIN_INTERVAL_MS = 20_000;

/* ─────────────────────────────── Texto ─────────────────────────────── */

/** Minúsculas y sin tildes, para comparar. Conserva la longitud carácter a carácter salvo la ñ. */
export function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/** Corta en oraciones conservando la puntuación final. */
function sentences(text: string): string[] {
  return text.match(/[^.!?;\n]+[.!?;\n]*/g) ?? [];
}

/** Indicativo de radio en texto plegado: "b-3", "rx-15", "q 8". */
const CALLSIGN_SRC = String.raw`[a-z]{1,2}x?\s?-?\s?\d{1,2}`;

/**
 * La oración cita a una unidad, la Central o el OBAC ("B-3 informa…", "según la Central…").
 * "Según los videos" NO es cita: es lo que concluye Vigía.
 */
const ATTRIBUTION = new RegExp(
  String.raw`\b(informa|informo|informan|dijo|reporta|reporto|reportan|confirma|confirmo|transmitio|pidio|pide)\b` +
    String.raw`|\bsegun\s+(la radio|radio|la central|central|el obac|obac|${CALLSIGN_SRC})\b` +
    String.raw`|\b(la radio|radio|central|obac|${CALLSIGN_SRC})\s+(dice|dijo|indica|indico)\b`,
);

/* ───────────── 1. Nunca "no hay nadie": solo lo que no se ve ───────────── */

/**
 * Afirmaciones de ausencia de personas → lo que Vigía puede decir.
 * Los patrones usan clases con y sin tilde porque se aplican sobre el texto original.
 */
const ABSENCE_RULES: { re: RegExp; to: string }[] = [
  { re: /\bno\s+hay\s+nadie\b/gi, to: "no veo a nadie" },
  { re: /\bno\s+queda\s+nadie\b/gi, to: "no veo a nadie" },
  { re: /\bno\s+hay\s+(personas|gente|v[ií]ctimas|atrapados|atrapadas|heridos|heridas|ocupantes|moradores|lesionados)\b/gi, to: "no veo $1" },
  { re: /\bno\s+quedan\s+(personas|v[ií]ctimas|atrapados|ocupantes|moradores)\b/gi, to: "no veo $1" },
  { re: /\bnadie\s+(adentro|dentro|en\s+el\s+interior)\b/gi, to: "no veo a nadie $1" },
  { re: /\b(sin|cero)\s+(personas|v[ií]ctimas|atrapados|ocupantes)(\s+(adentro|dentro|atrapad[oa]s))?\b/gi, to: "no veo $2$3" },
  { re: /\b(est[aá]|queda|qued[oó])\s+(vac[ií]o|vac[ií]a|deshabitad[oa])\b/gi, to: "no veo personas" },
  { re: /\b(est[aá]|queda|qued[oó])\s+despejad[oa]\b/gi, to: "no veo personas" },
  { re: /\bse\s+descarta(n)?\s+(personas|v[ií]ctimas|atrapados)\b/gi, to: "no veo $2" },
  { re: /\b(personas|v[ií]ctimas|atrapados)\s+descartad[oa]s\b/gi, to: "no veo $1" },
];

/* ───────────── 2. Sin órdenes a las unidades ni decisiones tácticas ───────────── */

/**
 * Vigía le habla a una unidad: "B-3, informe 6-3", "Unidades: mantengan posición".
 * Un resumen ("B-3, en 6-0 con 8 voluntarios") no calza: después de la coma no hay una orden.
 */
const UNIT_ADDRESS = new RegExp(
  String.raw`^\s*(?:${CALLSIGN_SRC}|central|unidades|todas las unidades|bomberos|companias|compania)\s*[,:]\s*(no\s+)?` +
    String.raw`(informe|informen|indique|indiquen|confirme|confirmen|dirijase|dirijanse|mantenga|mantengan|espere|esperen|repita|repitan|de|den|proceda|procedan|cambie|cambien|vaya|vayan|despache|despachen)\b`,
);

/**
 * Imperativos dirigidos a quien está en el lugar (ustedes / usted). Sin sustantivos
 * ambiguos ("el avance del fuego", "corte de luz").
 */
const IMPERATIVE =
  /\b(no\s+)?(entren|ingresen|salgan|evacuen|evacue|retirense|retirese|ataquen|ataque\s+por|ventilen|ventile|suban|bajen|avancen|procedan|proceda|corten|rompan|armen|tiren|lancen|abandonen|esperen\s+afuera|no\s+entre|entre\s+por|ingrese)\b/;

/** Recomendaciones tácticas: "conviene entrar", "hay que atacar por…", "recomiendo evacuar". */
const TACTICAL =
  /\b(recomiendo|sugiero|conviene|hay que|deben|deberian|tienen que|tendrian que|lo mejor es|propongo|mejor)\s+(no\s+)?(entrar|ingresar|atacar|evacuar|ventilar|retirarse|retirar|salir|subir|romper|cortar|avanzar|abandonar|rescatar|armar)\b|\b(entrar|ingresar|atacar|ataque)\s+por\s+(el|la)\s+(lado|costado|frente|fachada|puerta|ventana|techo|patio)\b|\bpor\s+donde\s+(entrar|atacar|ingresar)\b|\b(es|no es)\s+seguro\s+(entrar|ingresar)\b/;

export interface SanitizeResult {
  /** Texto con las afirmaciones de ausencia cambiadas por "no veo…". */
  text: string;
  /** true → no se transmite ni se muestra como mensaje de Vigía (da una orden o decide la táctica). */
  blocked: boolean;
  /** Reglas aplicadas, para la bitácora ("por qué dijo esto"). */
  reasons: string[];
}

/**
 * Pasa un mensaje de Vigía por las reglas duras.
 *  - Cambia "no hay nadie / no hay personas / está vacío…" por "no veo…", salvo que la
 *    oración cite a otro ("B-3 informa que no hay nadie" es un dato de radio, no de Vigía).
 *  - Bloquea las órdenes a unidades y las decisiones tácticas aunque se citen: el canal
 *    lo oyen todas las compañías y una orden repetida por Vigía suena a orden.
 */
export function sanitizeForObac(text: string): SanitizeResult {
  const reasons: string[] = [];
  let blocked = false;
  const out: string[] = [];

  for (const raw of sentences(text.trim())) {
    let s = raw;
    const folded = fold(s);
    const cited = ATTRIBUTION.test(folded);

    if (!cited) {
      for (const rule of ABSENCE_RULES) {
        rule.re.lastIndex = 0;
        if (rule.re.test(s)) {
          rule.re.lastIndex = 0;
          s = s.replace(rule.re, rule.to);
          if (!reasons.includes("ausencia")) reasons.push("ausencia");
        }
      }
    }

    if (UNIT_ADDRESS.test(folded)) {
      blocked = true;
      if (!reasons.includes("orden_a_unidad")) reasons.push("orden_a_unidad");
    }
    if (IMPERATIVE.test(folded)) {
      blocked = true;
      if (!reasons.includes("orden")) reasons.push("orden");
    }
    if (TACTICAL.test(folded)) {
      blocked = true;
      if (!reasons.includes("decision_tactica")) reasons.push("decision_tactica");
    }
    out.push(s);
  }

  const joined = out.join("").replace(/\s+/g, " ").trim();
  // Mayúscula inicial si un reemplazo quedó al comienzo de una oración.
  const cased = joined.replace(/(^|[.!?]\s+)([a-záéíóúñ])/g, (_m, p: string, c: string) => p + c.toUpperCase());
  return { text: cased, blocked, reasons };
}

/* ───────────── 3. Límite de voz y silencio ───────────── */

export interface SpeechCheck {
  priority: VigiaPriority;
  /** Epoch ms del último mensaje hablado, o null si aún no habla. */
  lastSpokenAt: number | null;
  now: number;
  /** El OBAC dijo "Vigía, silencio". */
  silenced: boolean;
}

/**
 * true si el mensaje puede ir por voz ahora. Una posible persona pasa siempre
 * (también en silencio y antes de los 20 s); el resto, solo sin silencio y con
 * SPOKEN_MIN_INTERVAL_MS desde el último mensaje hablado. Lo que no pasa queda en pantalla.
 */
export function speechAllowed(p: SpeechCheck): boolean {
  if (p.priority === "persona") return true;
  if (p.silenced) return false;
  return p.lastSpokenAt === null || p.now - p.lastSpokenAt >= SPOKEN_MIN_INTERVAL_MS;
}

/** El texto le habla a Vigía ("Vigía, …" o "… Vigía"). */
export function addressesVigia(text: string): boolean {
  return /\bvigia\b/.test(fold(text));
}

/**
 * Orden de silencio o de volver a hablar en un mensaje del OBAC; null si no hay.
 * Se evalúa en código (no lo decide el modelo).
 */
export function detectSilenceCommand(text: string): "silence" | "resume" | null {
  const t = fold(text);
  if (/\b(puedes|puede|ya puedes|vuelve a|vuelva a)\s+hablar\b|\bfin del silencio\b|\btermina(r)? (el )?silencio\b|\bsin silencio\b|\bhabla de nuevo\b/.test(t)) {
    return "resume";
  }
  if (/\bsilencio\b|\bcallate\b|\bno hables\b|\bsolo (en )?pantalla\b/.test(t)) return "silence";
  return null;
}

/* ───────────── 4. Pedidos de video al público ───────────── */

export const VIDEO_REQUEST_SUFFIX = "Sin acercarse.";

const PUBLIC_UNSAFE =
  /\b(?<!sin\s)(?<!no\s)(acerquese|acercate|acercarse|acerquense|entre|entra|entrar|ingrese|ingresa|ingresar|suba|sube|subir|cruce|cruza|cruzar|ayude|ayuda a|rescate|apague|apaga|apagar)\b/;

export interface VideoRequestResult {
  text: string;
  blocked: boolean;
}

/**
 * Pedido para quienes están grabando cerca. Solo pide un ángulo: nunca acercarse,
 * entrar ni dar instrucciones de seguridad. Siempre termina con "Sin acercarse."
 */
export function sanitizeVideoRequest(text: string): VideoRequestResult {
  const base = text.trim().replace(/\s+/g, " ");
  const withoutSuffix = base.replace(/\s*sin acercarse\.?\s*$/i, "").trim();
  const blocked = PUBLIC_UNSAFE.test(fold(withoutSuffix));
  const body = /[.!?]$/.test(withoutSuffix) ? withoutSuffix : `${withoutSuffix}.`;
  return { text: `${body} ${VIDEO_REQUEST_SUFFIX}`, blocked };
}

/** Texto estándar del pedido: "Bomberos necesita un video del lado C, desde la vereda. Sin acercarse." */
export function videoRequestText(zone: string, from = "desde la vereda"): string {
  const z = zone.trim().replace(/[.]+$/, "");
  return sanitizeVideoRequest(`Bomberos necesita un video ${z}, ${from}.`).text;
}
