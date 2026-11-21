import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatClockTime,
  MAX_IMPORT_TEXT_CHARS,
  parseTranscript,
  parseTranscriptLine,
  resolveEntryDates,
} from "./parse-transcript";

test("hora HH:MM, emisor y texto", () => {
  assert.deepEqual(parseTranscriptLine("21:14 B-3: en el lugar, humo negro por ventanas"), {
    time: { h: 21, m: 14, s: 0 },
    speaker: "B-3",
    text: "en el lugar, humo negro por ventanas",
  });
});

test("hora HH:MM:SS entre corchetes y con separador", () => {
  assert.deepEqual(parseTranscriptLine("[21:14:05] Central: B-3, copiado"), {
    time: { h: 21, m: 14, s: 5 },
    speaker: "Central",
    text: "B-3, copiado",
  });
  assert.deepEqual(parseTranscriptLine("09:02:59 - RX-15: llegando al lugar"), {
    time: { h: 9, m: 2, s: 59 },
    speaker: "RX-15",
    text: "llegando al lugar",
  });
  assert.deepEqual(parseTranscriptLine("7:05 — OBAC: mando establecido"), {
    time: { h: 7, m: 5, s: 0 },
    speaker: "OBAC",
    text: "mando establecido",
  });
});

test("emisores típicos sin hora", () => {
  for (const [line, speaker] of [
    ["B-3: en el lugar", "B-3"],
    ["RX-15: rescate en camino", "RX-15"],
    ["Central: copiado", "Central"],
    ["OBAC: solicito segunda alarma", "OBAC"],
    ["Q-8 a Central: en ruta", "Q-8 a Central"],
    ["Segundo Comandante: asumo el mando", "Segundo Comandante"],
  ] as const) {
    const out = parseTranscriptLine(line);
    assert.equal(out?.speaker, speaker, line);
    assert.equal(out?.time, null, line);
  }
});

test("línea suelta: sin hora ni emisor, y frases con dos puntos que no son emisor", () => {
  assert.deepEqual(parseTranscriptLine("se ve fuego en el segundo piso"), {
    time: null,
    speaker: "",
    text: "se ve fuego en el segundo piso",
  });
  assert.equal(parseTranscriptLine("Se ve humo: mucho, negro")?.speaker, "");
  assert.equal(parseTranscriptLine("ver http://ejemplo.cl")?.speaker, "");
  // Hora inválida: queda como texto.
  const bad = parseTranscriptLine("25:70 B-3: en el lugar");
  assert.equal(bad?.time, null);
  assert.equal(bad?.text, "25:70 B-3: en el lugar");
});

test("líneas vacías, espacios y CRLF", () => {
  const out = parseTranscript("21:14 B-3: en el lugar\r\n\r\n   \r\n21:15 Central: copiado\r22:00 Q-8: ok\n");
  assert.equal(out.entries.length, 3);
  assert.deepEqual(
    out.entries.map((e) => [e.line, e.speaker, e.text]),
    [
      [1, "B-3", "en el lugar"],
      [4, "Central", "copiado"],
      [5, "Q-8", "ok"],
    ],
  );
  assert.equal(out.issues.length, 0);
  assert.equal(parseTranscript("").entries.length, 0);
  assert.equal(parseTranscript("\n\n").entries.length, 0);
});

test("líneas sin texto o demasiado largas se informan como problemas", () => {
  const long = "x".repeat(MAX_IMPORT_TEXT_CHARS + 1);
  const out = parseTranscript(`21:14 B-3:\n21:15\n${long}\nB-3: bien`);
  assert.equal(out.entries.length, 1);
  assert.deepEqual(
    out.issues.map((i) => i.line),
    [1, 2, 3],
  );
});

test("cruce de medianoche: la hora que retrocede mucho pasa al día siguiente", () => {
  const out = parseTranscript("23:58 B-3: en el lugar\n23:59 Central: copiado\n00:03 B-3: fuego controlado\nnota suelta");
  assert.deepEqual(
    out.entries.map((e) => e.dayOffset),
    [0, 0, 1, 0],
  );
  // Un pequeño desorden no es medianoche.
  const disorder = parseTranscript("21:15 B-3: a\n21:14 Q-8: b");
  assert.deepEqual(
    disorder.entries.map((e) => e.dayOffset),
    [0, 0],
  );
});

test("fechas: hoy a la hora leída; corre un día atrás si quedaría en el futuro", () => {
  const { entries } = parseTranscript("21:14 B-3: a\nB-3: sin hora\n21:20:30 Central: b");
  const now = new Date(2026, 10, 21, 22, 0, 0);
  const dates = resolveEntryDates(entries, now);
  assert.equal(dates[1], null);
  assert.equal(dates[0], new Date(2026, 10, 21, 21, 14, 0).toISOString());
  assert.equal(dates[2], new Date(2026, 10, 21, 21, 20, 30).toISOString());

  // Pegado a las 00:10 una transcripción de 23:50 → 00:05: ayer y hoy.
  const night = parseTranscript("23:50 B-3: a\n00:05 Central: b").entries;
  const justAfterMidnight = new Date(2026, 10, 22, 0, 10, 0);
  const nd = resolveEntryDates(night, justAfterMidnight);
  assert.equal(nd[0], new Date(2026, 10, 21, 23, 50, 0).toISOString());
  assert.equal(nd[1], new Date(2026, 10, 22, 0, 5, 0).toISOString());

  // Pegado a las 08:00 algo de las 23:50 (anoche, sin cruce): ayer.
  const yesterday = resolveEntryDates(parseTranscript("23:50 B-3: a").entries, new Date(2026, 10, 22, 8, 0, 0));
  assert.equal(yesterday[0], new Date(2026, 10, 21, 23, 50, 0).toISOString());
});

test("formatClockTime", () => {
  assert.equal(formatClockTime({ h: 9, m: 5, s: 0 }), "09:05");
  assert.equal(formatClockTime({ h: 21, m: 14, s: 5 }), "21:14:05");
});
