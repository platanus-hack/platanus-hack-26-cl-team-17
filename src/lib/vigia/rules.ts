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

/** Unidad dicha por su nombre, en texto plegado: "bomba 3", "compania 5". */
const NAMED_UNIT_SRC = String.raw`(?:bomba|compania|unidad)\s+\d{1,2}`;

/**
 * A quién se puede citar: una unidad, la Central, el OBAC o la radio. A Vigía no.
 * El indicativo no puede ser una palabra corta ("de 7", "en 4").
 */
const SOURCE_SRC =
  String.raw`(?:la\s+)?(?:radio|central)|(?:el\s+)?obac|${NAMED_UNIT_SRC}|` +
  String.raw`(?!(?:a|al|de|el|en|es|la|lo|o|se|su|un|y|ya|e)\b)${CALLSIGN_SRC}`;

const SAY_SRC = String.raw`informa|informan|informo|dice|dicen|dijo|dijeron|indica|indican|indico|reporta|reportan|reporto|confirma|confirman|confirmo|transmite|transmitio|avisa|avisan|aviso`;

/** "B-3 informa que…", "la radio dice: …", "según la Central, …": lo que sigue es una cita. */
const CITE_LEAD = new RegExp(
  String.raw`\b(?:${SOURCE_SRC})\s+(?:ya\s+|tambien\s+|nos\s+|le\s+)?(?:${SAY_SRC})(?:\s+a\s+(?:la\s+|el\s+)?\w+)?\s*(?:que\b|:)` +
    String.raw`|\bsegun\s+(?:${SOURCE_SRC})\b\s*,?`,
  "g",
);

/** "…, informa B-3." / "…, según la Central.": la oración entera es una cita. */
const CITE_TAIL = new RegExp(
  String.raw`,\s*(?:segun\s+(?:(?:${SAY_SRC})\s+)?|(?:${SAY_SRC})\s+)(?:${SOURCE_SRC})\s*[.!?;\n]*$`,
);

/** Después de esto ya no habla el citado sino Vigía. */
const CLAUSE_BREAK = /[,;:]|\b(?:pero|aunque|mientras|sin embargo|ademas|en cambio)\b/;

/**
 * La afirmación que empieza en `at` (de la oración ya plegada) es una cita de una unidad,
 * la Central o el OBAC, no algo que concluye Vigía. "Según los videos", "confirmo que…",
 * "Vigía informa…" o "B-3 pide agua y no hay nadie" NO son citas.
 */
function isCited(folded: string, at: number): boolean {
  if (CITE_TAIL.test(folded)) return true;
  for (const m of folded.matchAll(CITE_LEAD)) {
    const end = m.index + m[0].length;
    if (end > at) continue;
    // "B-5 informa: …" es cita textual hasta el final de la oración; "informa que …", hasta la próxima coma.
    if (m[0].endsWith(":") || !CLAUSE_BREAK.test(folded.slice(end, at))) return true;
  }
  return false;
}

/* ───────────── 1. Nunca "no hay nadie": solo lo que no se ve ───────────── */

/** Personas, en singular o plural, con o sin tilde (texto original). */
const PEOPLE = String.raw`personas?|gente|v[ií]ctimas?|atrapad[oa]s?|herid[oa]s?|lesionad[oa]s?|ocupantes?|moradores?|residentes?|habitantes?|ni[ñn][oa]s`;
const NOBODY = String.raw`nadie|naide|nadien`;
/** "no hay", "no queda", "no se observan", "no se encontraron"… y "no ay", como lo deja una transcripción. */
const NONE =
  String.raw`no\s+(?:h?ay|hai|hab[ií]a|habr[ií]a|hubo|existen?|quedan?|qued[oó]|quedaron)|nohay` +
  String.raw`|no\s+se\s+(?:ven?|observan?|aprecian?|detectan?|registran?|divisan?|distinguen?|encuentran?|encontr[oó]|encontraron|hall[oó]|hallaron)`;
/** "vacío" (también "vasío", "bacío"), "despejado", "evacuado", "libre de personas". */
const EMPTY = String.raw`[vb]a[csz][ií][oóa]s?|deshabitad[oa]s?|despejad[oa]s?|evacuad[oa]s?|libres?\s+de\s+(?:personas|gente|v[ií]ctimas)`;
/** Fin de palabra que entiende tildes (\b no las considera letras). */
const END = String.raw`(?![a-záéíóúüñ])`;
/** Ya dicho como lo que Vigía no ve ("no veo a…", "no encontré…"): no se corrige otra vez. */
const NOT_AFTER_NO = String.raw`(?<!\bno\s+(?:se\s+)?\S+\s+(?:a\s+)?)`;

/** "El edificio está vacío" → "El edificio: no veo personas"; al comienzo, solo "no veo personas". */
function emptyTo(before: string, ws: string): string {
  return /^\s*$|[,:;]\s*$/.test(before) ? `${ws}no veo personas` : ": no veo personas";
}

/**
 * Afirmaciones de ausencia de personas → lo que Vigía puede decir.
 * Los patrones usan clases con y sin tilde porque se aplican sobre el texto original.
 */
const ABSENCE_RULES: { re: RegExp; to: string | ((before: string, groups: string[]) => string) }[] = [
  { re: new RegExp(String.raw`\b(?:${NONE})\s+(?:a\s+)?(?:${NOBODY})${END}`, "gi"), to: "no veo a nadie" },
  { re: new RegExp(String.raw`\b(?:${NONE})\s+((?:a\s+)?(?:ning[uú]n[oa]?|ni\s+una?|m[aá]s)\s+)?(${PEOPLE})${END}`, "gi"), to: "no veo $1$2" },
  { re: new RegExp(String.raw`${NOT_AFTER_NO}\b(?:${NOBODY})\s+(adentro|dentro|en\s+el\s+interior|atrapad[oa]s?|herid[oa]s?)${END}`, "gi"), to: "no veo a nadie $1" },
  { re: new RegExp(String.raw`${NOT_AFTER_NO}\b(ning[uú]n[oa]?|ni\s+una?)\s+(${PEOPLE})${END}`, "gi"), to: (_b, [q, p]) => `no veo ${q.toLowerCase()} ${p}` },
  { re: new RegExp(String.raw`\b(?:sin|cero)\s+(${PEOPLE})(\s+(?:adentro|dentro|atrapad[oa]s))?${END}`, "gi"), to: "no veo $1$2" },
  {
    re: new RegExp(
      String.raw`(\s*)\b(?:ya\s+)?(?:est[aá]n?|se\s+encuentran?|queda|quedan|qued[oó]|quedaron|permanecen?|siguen?|parecen?|fue|fueron|ha\s+sido|han\s+sido)\s+(?:(?:completamente|totalmente|ya)\s+)?(?:${EMPTY})${END}`,
      "gi",
    ),
    to: (before, [ws]) => emptyTo(before, ws ?? ""),
  },
  { re: new RegExp(String.raw`\b(piso|nivel|edificio|casa|inmueble|departamento|depto|interior)\s+(?:${EMPTY})${END}`, "gi"), to: "$1: no veo personas" },
  { re: new RegExp(String.raw`\btodo\s+(?:est[aá]\s+)?(?:${EMPTY})${END}`, "gi"), to: "no veo personas" },
  {
    re: /\b(?:ya\s+)?(?:todos\s+(?:ya\s+)?(?:salieron|evacuaron|se\s+fueron|est[aá]n\s+afuera)|(?:salieron|evacuaron)\s+todos|sali[oó]\s+todo\s+el\s+mundo)(?![a-záéíóúüñ])/gi,
    to: "no veo a nadie adentro",
  },
  { re: new RegExp(String.raw`\bse\s+descartan?\s+(${PEOPLE})${END}`, "gi"), to: "no veo $1" },
  { re: new RegExp(String.raw`\b(${PEOPLE})\s+descartad[oa]s?${END}`, "gi"), to: "no veo $1" },
];

/* ───────────── 2. Sin órdenes a las unidades ni decisiones tácticas ───────────── */

/**
 * Vigía le habla a una unidad: "B-3, informe 6-3", "Unidades: mantengan posición".
 * Un resumen ("B-3, en 6-0 con 8 voluntarios") no calza: después de la coma no hay una orden.
 */
const UNIT_ADDRESS = new RegExp(
  String.raw`^\s*(?:${CALLSIGN_SRC}|${NAMED_UNIT_SRC}|central|unidades|todas las unidades|bomberos|companias|compania)\s*[,:]\s*(no\s+)?` +
    String.raw`(?:informe|informen|indique|indiquen|confirme|confirmen|dirijase|dirijanse|mantenga|mantengan|espere|esperen|repita|repitan|de|den|proceda|procedan|cambie|cambien|vaya|vayan|despache|despachen` +
    // Después de "B-3," el singular es una orden ("B-3, suba"), salvo el sustantivo ("B-3, ataque interior…").
    String.raw`|suba|baje|salga|entre|ingrese|rompa|arme|retire|retirese|evacue|ventile|abandone|busque|revise|saque|apague` +
    String.raw`|(?:avance|ataque|corte|rescate)(?!\s+(?:de|del|interior|exterior|en\s+curso)\b)` +
    String.raw`|evacuar|entrar|ingresar|atacar|salir|subir|bajar|avanzar|retirarse|abandonar|ventilar)\b`,
);

/**
 * Imperativos dirigidos a quien está en el lugar (ustedes / usted). Sin sustantivos
 * ambiguos ("el avance del fuego", "corte de luz").
 */
const IMPERATIVE =
  /\b(no\s+)?(entren|ingresen|salgan|e[vb]acuen|e[vb]acue|retirense|retirese|ataquen|ataque\s+por|ventilen|ventile|suban|bajen|avancen|procedan|proceda|corten|rompan|armen|tiren|lancen|abandonen|rescaten|busquen|revisen|saquen|esperen\s+afuera|no\s+entre|entre\s+por|ingrese)\b/;

/** Orden en infinitivo al comienzo ("Evacuar el edificio.") o como sustantivo ("Evacuación inmediata."). */
const BARE_ORDER =
  /(?:^|:)\s*(?:no\s+)?(?:evacuar|entrar|ingresar|atacar|salir|retirarse|retirar|abandonar|ventilar|subir|bajar|avanzar|romper|cortar|rescatar)\b|\b(?:evacuacion|retirada|retiro|abandono)\s+(?:inmediata|inmediato|urgente|total|ya|ahora|de inmediato)\b/;

/** Recomendaciones tácticas: "conviene entrar", "se debe evacuar", "hay que atacar por…", "ya pueden entrar". */
const TACTICAL = new RegExp(
  String.raw`\b(?:recomiendo|recomendamos|se recomienda|sugiero|sugerimos|se sugiere|conviene|hay que|habria que|deben|debe|deberian|deberia|tienen que|tiene que|tendrian que|tendria que|lo mejor es|lo mejor seria|seria mejor|es necesario|es urgente|urge|necesitan|propongo|mejor)\s+(?:no\s+)?` +
    String.raw`(?:entrar|ingresar|atacar|evacuar|ventilar|retirarse|retirar|salir|subir|romper|cortar|avanzar|abandonar|rescatar|armar)(?:se|los|las|lo|la)?\b` +
    String.raw`|\b(?:ya\s+)?(?:se\s+puede|pueden)\s+(?:entrar|ingresar|evacuar)\b` +
    String.raw`|\b(?:entrar|ingresar|atacar|ataque)\s+por\s+(?:(?:el|la|los|las)\s+)?(?:lado|costado|frente|fachada|puertas?|ventanas?|techo|patio|parte|fondo|atras|detras|acceso|entrada|escalera)\b` +
    String.raw`|\bpor\s+donde\s+(?:entrar|atacar|ingresar)\b` +
    String.raw`|\b(?:es|no es)\s+seguro\s+(?:entrar|ingresar|acceder|subir|el ingreso|la entrada|el acceso)\b`,
);

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

  // NFC: con tildes descompuestas ("i" + U+0301) los patrones con [ií] no calzan.
  for (const raw of sentences(text.normalize("NFC").trim())) {
    let s = raw;
    const folded = fold(s);

    for (const rule of ABSENCE_RULES) {
      s = s.replace(rule.re, (...args: unknown[]) => {
        const match = args[0] as string;
        const at = args.at(-2) as number;
        const whole = args.at(-1) as string;
        // Cada match se mira en su lugar: "B-3 informa que no hay nadie" es cita; "…y no hay nadie" no.
        if (isCited(fold(whole), at)) return match;
        if (!reasons.includes("ausencia")) reasons.push("ausencia");
        const groups = (args.slice(1, -2) as (string | undefined)[]).map((g) => g ?? "");
        return typeof rule.to === "function"
          ? rule.to(whole.slice(0, at), groups)
          : rule.to.replace(/\$(\d)/g, (_m, n: string) => groups[Number(n) - 1] ?? "");
      });
    }

    if (UNIT_ADDRESS.test(folded)) {
      blocked = true;
      if (!reasons.includes("orden_a_unidad")) reasons.push("orden_a_unidad");
    }
    if (IMPERATIVE.test(folded) || BARE_ORDER.test(folded)) {
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
  /** Tipo de mensaje (opcional): "respuesta" = el OBAC preguntó y espera la respuesta. */
  kind?: string;
}

/**
 * true si el mensaje puede ir por voz ahora. Una posible persona pasa siempre
 * (también en silencio y antes de los 20 s). La respuesta a una pregunta del OBAC pasa
 * sin esperar los 20 s (él la pidió), pero respeta el silencio. El resto, solo sin
 * silencio y con SPOKEN_MIN_INTERVAL_MS desde el último mensaje hablado.
 * Lo que no pasa queda en pantalla.
 */
export function speechAllowed(p: SpeechCheck): boolean {
  if (p.priority === "persona") return true;
  if (p.silenced) return false;
  if (p.kind === "respuesta") return true;
  return p.lastSpokenAt === null || p.now - p.lastSpokenAt >= SPOKEN_MIN_INTERVAL_MS;
}

/** El texto le habla a Vigía ("Vigía, …" o "… Vigía"). */
export function addressesVigia(text: string): boolean {
  return /\bvigia\b/.test(fold(text));
}

/**
 * Cómo suele quedar «Vigía» en una transcripción de radio: «Viking», «vigila», «vigilia»,
 * «bigía», «vijía», «vixía», «vigía» con o sin tilde… (medido en la prueba con Zello).
 */
const VIGIA_HEARD = /\b(vig[ií]a|vigias|vigila|vigilia|viking|vikin|vikia|vijia|vixia|bigia|bijia|vigea|vigi)\b/;

/**
 * La transmisión le habla a Vigía, tolerando cómo la transcribe la radio. Se busca en las
 * primeras palabras o al final ("Ese vigila"), donde va el vocativo.
 */
export function mentionsVigia(text: string): boolean {
  const words = fold(text)
    .replace(/[^a-z0-9ñ\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return false;
  const head = words.slice(0, 8).join(" ");
  const tail = words.slice(-4).join(" ");
  return VIGIA_HEARD.test(head) || VIGIA_HEARD.test(tail);
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

/** Texto plegado. "sin acercarse", "no se acerque", "ni entrar" sí se pueden decir. */
const PUBLIC_UNSAFE = new RegExp(
  String.raw`(?<!\b(?:sin|no|ni|no\s+se|no\s+te)\s)\b(?:acer(?:c|qu)\w*|aproxim\w*|arrim\w*|metase|metanse|entre|entren|entra|entrar|ingrese|ingresen|ingresa|ingresar` +
    String.raw`|suba|suban|sube|subir|baje|bajen|cruce|crucen|cruza|cruzar|ayude|ayuden|ayuda a|rescate|rescaten|apague|apaguen|apaga|apagar` +
    String.raw`|vaya|vayan|pase|pasen|salte|salten|trepe|trepen|rodee|rodeen)\b` +
    String.raw`|\b(?:lo\s+)?mas\s+cerca\b|\b(?:de|bien|muy)\s+cerca\b|\bdesde\s+(?:adentro|dentro|el\s+interior|el\s+techo|la\s+azotea|el\s+entretecho)\b`,
);

export interface VideoRequestResult {
  text: string;
  blocked: boolean;
}

/**
 * Pedido para quienes están grabando cerca. Solo pide un ángulo: nunca acercarse,
 * entrar ni dar instrucciones de seguridad. Siempre termina con "Sin acercarse."
 * También se rechaza lo que Vigía no podría decirle al OBAC (órdenes, "está vacío").
 */
export function sanitizeVideoRequest(text: string): VideoRequestResult {
  const base = text.normalize("NFC").trim().replace(/\s+/g, " ");
  const withoutSuffix = base.replace(/[\s,;]*sin acercarse\s*[.!¡]*\s*$/i, "").trim();
  const asObac = sanitizeForObac(withoutSuffix);
  const blocked = PUBLIC_UNSAFE.test(fold(withoutSuffix)) || asObac.blocked || asObac.reasons.includes("ausencia");
  const body = /[.!?]$/.test(withoutSuffix) ? withoutSuffix : `${withoutSuffix}.`;
  return { text: `${body} ${VIDEO_REQUEST_SUFFIX}`, blocked };
}

/** Texto estándar del pedido: "Bomberos necesita un video del lado C, desde la vereda. Sin acercarse." */
export function videoRequestText(zone: string, from = "desde la vereda"): string {
  const z = zone.trim().replace(/[.]+$/, "");
  return sanitizeVideoRequest(`Bomberos necesita un video ${z}, ${from}.`).text;
}
