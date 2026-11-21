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
