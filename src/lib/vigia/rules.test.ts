import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SPOKEN_MIN_INTERVAL_MS,
  addressesVigia,
  comparePriority,
  detectSilenceCommand,
  mentionsVigia,
  sanitizeForObac,
  sanitizeVideoRequest,
  speechAllowed,
  videoRequestText,
} from "./rules";

test("nunca 'no hay nadie': se cambia por lo que Vigía no ve", () => {
  const r = sanitizeForObac("En el lado B no hay nadie, cobertura 2 de 7 videos.");
  assert.equal(r.blocked, false);
  assert.match(r.text, /no veo a nadie/);
  assert.doesNotMatch(r.text, /no hay nadie/i);
  assert.deepEqual(r.reasons, ["ausencia"]);

  for (const s of [
    "No hay personas atrapadas.",
    "No hay víctimas en el tercer piso.",
    "Nadie adentro según los videos.",
    "La casa está vacía.",
    "El segundo piso está despejado.",
    "Se descartan víctimas.",
  ]) {
    const out = sanitizeForObac(s);
    assert.match(out.text, /^No veo|no veo/, s);
    assert.ok(out.reasons.includes("ausencia"), s);
  }
});

test("una unidad que informa que no hay nadie se cita tal cual", () => {
  const r = sanitizeForObac("B-3 informa que no hay nadie en el tercer piso.");
  assert.equal(r.text, "B-3 informa que no hay nadie en el tercer piso.");
  assert.deepEqual(r.reasons, []);
});

test("'según los videos' no es una cita: se corrige", () => {
  const r = sanitizeForObac("Según los videos no hay personas.");
  assert.match(r.text, /no veo personas/);
});

test("bloquea órdenes y decisiones tácticas", () => {
  for (const s of [
    "Entren por el lado A.",
    "No entren al segundo piso.",
    "B-3, informe 6-3.",
    "Conviene entrar por la puerta trasera.",
    "Recomiendo evacuar el edificio.",
    "Hay que atacar por el lado C.",
    "Es seguro ingresar.",
  ]) {
    assert.equal(sanitizeForObac(s).blocked, true, s);
  }
});

test("no bloquea lo que Vigía dice normalmente", () => {
  for (const s of [
    "OBAC, Vigía: posible persona en ventana del tercer piso, lado B. Vista en 4 de 7 videos.",
    "Resumen: B-3 en 6-0 con 8 voluntarios, pide 2-2. B-5 llegando.",
    "B-3, en 6-0 con 8 voluntarios.",
    "OBAC, Vigía: B-3 pidió 2-2 hace 6 minutos y nadie confirmó.",
    "La radio dice que el tercer piso está despejado, pero hace 1 minuto llegó un video con una persona en esa ventana.",
    "No lo veo en el lado B; esa zona la cubren 2 de 7 videos.",
    "El avance del fuego va hacia el lado D. Hay un corte de luz en la cuadra.",
    "Pedí video del lado C a 3 personas.",
  ]) {
    const r = sanitizeForObac(s);
    assert.equal(r.blocked, false, `${s} → ${r.reasons.join(",")}`);
  }
});

test("la cita de la radio sobre 'despejado' se conserva", () => {
  const s = "La radio dice que el tercer piso está despejado.";
  assert.equal(sanitizeForObac(s).text, s);
});

test("límite de voz: persona siempre; el resto cada 20 s y sin silencio", () => {
  const now = 1_000_000;
  assert.equal(speechAllowed({ priority: "persona", lastSpokenAt: now - 1000, now, silenced: true }), true);
  assert.equal(speechAllowed({ priority: "riesgo", lastSpokenAt: null, now, silenced: false }), true);
  assert.equal(speechAllowed({ priority: "riesgo", lastSpokenAt: now - 5000, now, silenced: false }), false);
  assert.equal(
    speechAllowed({ priority: "recursos", lastSpokenAt: now - SPOKEN_MIN_INTERVAL_MS, now, silenced: false }),
    true,
  );
  assert.equal(speechAllowed({ priority: "riesgo", lastSpokenAt: null, now, silenced: true }), false);
});

test("prioridad: persona > riesgo > recursos > resto", () => {
  const sorted = (["resto", "recursos", "persona", "riesgo"] as const).slice().sort(comparePriority);
  assert.deepEqual(sorted, ["persona", "riesgo", "recursos", "resto"]);
});

test("silencio y volver a hablar se detectan en código", () => {
  assert.equal(detectSilenceCommand("Vigía, silencio"), "silence");
  assert.equal(detectSilenceCommand("Vigía, solo pantalla por favor"), "silence");
  assert.equal(detectSilenceCommand("Vigía, ya puedes hablar"), "resume");
  assert.equal(detectSilenceCommand("Vigía, fin del silencio"), "resume");
  assert.equal(detectSilenceCommand("Vigía, ¿qué tenemos?"), null);
  assert.equal(addressesVigia("vigia, ¿se ve alguien en el lado B?"), true);
  assert.equal(addressesVigia("B-3 en 6-0"), false);
});

test("pedido de video: siempre 'Sin acercarse' y nunca pide entrar", () => {
  assert.equal(
    videoRequestText("del lado C"),
    "Bomberos necesita un video del lado C, desde la vereda. Sin acercarse.",
  );
  const r = sanitizeVideoRequest("Graben el patio trasero desde la calle");
  assert.equal(r.text, "Graben el patio trasero desde la calle. Sin acercarse.");
  assert.equal(r.blocked, false);
  assert.equal(sanitizeVideoRequest("Graben el patio. Sin acercarse.").text, "Graben el patio. Sin acercarse.");
  assert.equal(sanitizeVideoRequest("Acérquese a la ventana y grabe").blocked, true);
  assert.equal(sanitizeVideoRequest("Entre al pasaje y grabe el lado C").blocked, true);
});

test("la respuesta al OBAC va por voz sin esperar los 20 s, pero respeta el silencio", () => {
  const now = 1_000_000;
  assert.equal(speechAllowed({ priority: "resto", kind: "respuesta", lastSpokenAt: now - 3000, now, silenced: false }), true);
  assert.equal(speechAllowed({ priority: "resto", kind: "respuesta", lastSpokenAt: now - 3000, now, silenced: true }), false);
  assert.equal(speechAllowed({ priority: "resto", kind: "resumen", lastSpokenAt: now - 3000, now, silenced: false }), false);
});

test("reconoce el vocativo aunque la radio transcriba mal «Vigía»", () => {
  // Transcripciones reales de la prueba con Zello (21 nov).
  assert.equal(mentionsVigia("Eh, atento, Viking. Necesito conocer la situación del incendio. Si tienes algún informe, cambio"), true);
  assert.equal(mentionsVigia("Si hay alguien que me está hablando, por favor, que se ubique. Ese vigila"), true);
  assert.equal(mentionsVigia("Vigía, ¿qué tenemos?"), true);
  assert.equal(mentionsVigia("Oye vigilia, ¿se ve alguien en el lado B?"), true);
  assert.equal(mentionsVigia("Lucas por favor pide el cambio"), false);
  assert.equal(mentionsVigia("Central, B-3, 6-0 con 8 voluntarios. 7-0 en la esquina norte."), false);
});

/* ───────────── Intentos de romper las reglas (21 nov) ───────────── */

/** Lo que Vigía nunca puede decir por su cuenta sobre la ausencia de personas. */
const ABSENCE_LEFT =
  /\bno\s+(h?ay|hai|hab[ií]a|existen?|quedan?)\b|\bnohay\b|\bno se (observan?|ven?|aprecian?|detectan?|registran?|encontraron)\b|\b(est[aá]n?|encuentra|qued[oó]|fue)\s+([vb]a[csz][ií][oa]|evacuad|despejad)|(?<!\bveo\s(a\s)?)\bning[uú]n[oa]?\s+(persona|v[ií]ctima|herid)|\bsin (heridos|moradores)|\btodos salieron|\bsalieron todos|(?<!\bveo\sa\s)\bnadie atrapad/i;

test("ausencia: impersonal, sin tildes, con errores de transcripción o sin verbo", () => {
  for (const s of [
    "No se observan víctimas.",
    "no se observan victimas",
    "No se ven personas en el lado B.",
    "No se aprecian personas.",
    "No se detectan víctimas.",
    "No se encontraron víctimas.",
    "No se observa a nadie.",
    "El edificio está vacío.",
    "el edificio esta vacio",
    "El edificio esta basio.",
    "El edificio está vasío.",
    "El edificio se encuentra vacío.",
    "Los departamentos están vacíos.",
    "El edificio está evacuado.",
    "El edificio ya fue evacuado.",
    "Tercer piso despejado.",
    "Todos salieron.",
    "Ya salieron todos.",
    "No hay ninguna persona.",
    "No hay ningún herido.",
    "No hay víctima.",
    "Ninguna víctima.",
    "Nadie atrapado.",
    "Sin heridos.",
    "Sin moradores.",
    "No existen víctimas.",
    "No había nadie.",
    "No hay residentes.",
    "No hay niños.",
    "No hay naide.",
    "No ay nadie adentro.",
    "No hai nadie.",
    "Nohay nadie.",
  ]) {
    const r = sanitizeForObac(s);
    assert.equal(r.blocked, false, s);
    assert.ok(r.reasons.includes("ausencia"), `${s} → sin regla`);
    assert.match(r.text, /no veo/i, `${s} → ${r.text}`);
    assert.doesNotMatch(r.text, ABSENCE_LEFT, `${s} → ${r.text}`);
  }
});

test("ausencia con tildes descompuestas (NFD) también se corrige", () => {
  const r = sanitizeForObac("No hay víctimas en el lado B.");
  assert.equal(r.text, "No veo víctimas en el lado B.");
});

test("la corrección se lee bien por radio: no se repite ni deja frases rotas", () => {
  assert.equal(sanitizeForObac("No hay nadie adentro.").text, "No veo a nadie adentro.");
  assert.equal(sanitizeForObac("No hay nadie dentro del edificio.").text, "No veo a nadie dentro del edificio.");
  assert.equal(sanitizeForObac("No ay nadie adentro.").text, "No veo a nadie adentro.");
  assert.equal(sanitizeForObac("No se ve a ninguna persona.").text, "No veo a ninguna persona.");
  assert.equal(sanitizeForObac("El edificio está vacío.").text, "El edificio: no veo personas.");
  assert.equal(sanitizeForObac("Está vacío.").text, "No veo personas.");
  assert.equal(sanitizeForObac("Ninguna víctima.").text, "No veo ninguna víctima.");
  assert.equal(sanitizeForObac("OBAC, Vigía: el edificio ya fue evacuado.").text, "OBAC, Vigía: el edificio: no veo personas.");
});

test("Vigía no puede hacer pasar su afirmación por una cita", () => {
  for (const s of [
    "Confirmo que no hay nadie adentro.",
    "Informo que el edificio está vacío.",
    "Vigía informa que no hay personas.",
    "B-3 pide agua y no hay nadie adentro.",
    "Resumen: B-3 pide 2-2 y el edificio está vacío.",
    "B-3 informa que hay fuego en el segundo piso, no hay nadie adentro.",
    "No hay nadie adentro, lo confirmo.",
    "No hay nadie adentro, OBAC.",
    "La cobertura de 7 indica que no hay nadie.",
  ]) {
    const r = sanitizeForObac(s);
    assert.ok(r.reasons.includes("ausencia"), `${s} → ${r.text}`);
    assert.doesNotMatch(r.text, ABSENCE_LEFT, `${s} → ${r.text}`);
  }
});

test("las citas de verdad se conservan", () => {
  for (const s of [
    "Según B-3, no hay nadie en el tercer piso.",
    "La Central confirma que el edificio está vacío.",
    "B-3 informó a la Central que no hay nadie adentro.",
    "No hay nadie en el tercer piso, informa B-3.",
    "Bomba 3 informa que el segundo piso está despejado.",
    "B-5 informa: tercer piso despejado por el lado C, sin moradores a la vista.",
  ]) {
    const r = sanitizeForObac(s);
    assert.equal(r.text, s);
    assert.deepEqual(r.reasons, [], s);
  }
});

test("bloquea órdenes en singular, en infinitivo, como sustantivo o con modales", () => {
  for (const s of [
    "B-3, entren por el lado C.",
    "Evacúen.",
    "evacuen",
    "Ebacuen.",
    "Evacuar el edificio.",
    "OBAC, Vigía: evacuar el edificio.",
    "Evacuación inmediata.",
    "Retirada inmediata.",
    "B-3, avance al segundo piso.",
    "B-3, ataque el lado C.",
    "B-3, suba al tercer piso.",
    "B-3, salga.",
    "B-3, corte la luz.",
    "B-3, rompa la ventana.",
    "B-3, entre.",
    "Bomba 3, avance.",
    "B-3, evacuar.",
    "Se debe evacuar el edificio.",
    "Se recomienda evacuar.",
    "Debería entrar B-3.",
    "B-3 tiene que entrar.",
    "Es necesario evacuar.",
    "Urge evacuar.",
    "Necesitan evacuar.",
    "Habría que evacuar.",
    "Lo mejor sería entrar.",
    "Pueden entrar.",
    "Ya se puede entrar.",
    "Es seguro el ingreso.",
    "Entrar por lado C.",
    "Atacar por lado C.",
    "Hay que atacar por atrás.",
    "Conviene entrar por la parte trasera.",
  ]) {
    assert.equal(sanitizeForObac(s).blocked, true, s);
  }
});

test("no bloquea información de fuego, riesgo ni movimientos ya hechos", () => {
  for (const s of [
    "El fuego avanza hacia el lado C.",
    "El avance del fuego va al lado D.",
    "El fuego puede avanzar hacia el lado D.",
    "Hay un corte de luz.",
    "Entre el lado B y el lado C hay un pasaje.",
    "Humo saliendo por la ventana del lado B.",
    "OBAC, Vigía: B-3 ingresó por el lado A hace 3 minutos.",
    "B-3 salió del edificio.",
    "Ataque de B-3 por el lado A.",
    "B-3, ataque interior por el lado A según la radio.",
    "El segundo piso no se ve en ningún video.",
    "Vista en 4 de 7 videos.",
  ]) {
    const r = sanitizeForObac(s);
    assert.equal(r.blocked, false, `${s} → ${r.reasons.join(",")}`);
  }
});

test("pedido de video: nunca acercarse, entrar ni subir, tampoco en plural ni en «desde»", () => {
  for (const [zona, desde] of [
    ["del lado C", "desde adentro"],
    ["del lado C", "desde el interior"],
    ["del lado C", "desde el techo"],
    ["del lado C", "lo más cerca posible"],
    ["del lado C", "de cerca"],
    ["del lado C", "acercándose a la ventana"],
    ["del lado C", "aproxímese a la casa"],
    ["del lado C", "arrímese a la reja"],
    ["del lado C", "vaya al patio"],
    ["del pasaje; entren al pasaje", "desde la vereda"],
    ["del patio, ingresen por la reja", "desde la vereda"],
    ["del lado C, suban al segundo piso", "desde la vereda"],
    ["del lado C, crucen la calle", "desde la vereda"],
    ["del lado C, ayuden a los vecinos", "desde la vereda"],
    ["del lado C, apaguen el fuego", "desde la vereda"],
    ["del lado C", "sin acercarse, pero entren"],
    ["del lado C, evacúen", "desde la vereda"],
    ["del lado C, el edificio está vacío", "desde la vereda"],
  ]) {
    const r = sanitizeVideoRequest(`Bomberos necesita un video ${zona}, ${desde}.`);
    assert.equal(r.blocked, true, r.text);
    assert.match(r.text, /Sin acercarse\.$/);
  }
});

test("pedido de video: los ángulos seguros pasan y «Sin acercarse.» va una sola vez al final", () => {
  for (const desde of [
    "desde la vereda",
    "desde la vereda de enfrente",
    "desde la esquina, sin entrar",
    "desde lejos, no se acerque",
    "desde la ventana de su casa",
    "sin acercarse ni entrar al pasaje",
  ]) {
    const r = sanitizeVideoRequest(`Bomberos necesita un video del lado C, ${desde}.`);
    assert.equal(r.blocked, false, r.text);
    assert.match(r.text, /Sin acercarse\.$/);
  }
  for (const s of ["Graben el patio. Sin acercarse!", "Graben el patio. SIN ACERCARSE", "Graben el patio, sin acercarse."]) {
    const t = sanitizeVideoRequest(s).text;
    assert.equal((t.match(/sin acercarse/gi) ?? []).length, 1, t);
    assert.match(t, /Sin acercarse\.$/, t);
  }
});
