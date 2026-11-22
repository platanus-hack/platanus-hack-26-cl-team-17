import { test } from "node:test";
import assert from "node:assert/strict";
import { CLAVES_TEXT, claveByCode, expandClaves, findClaves, RADIO_CLAVES } from "./radio-claves";

test("el libro trae los grupos del instructivo sin claves repetidas", () => {
  const codes = RADIO_CLAVES.map((c) => c.code);
  assert.equal(new Set(codes).size, codes.length);
  assert.equal(claveByCode("6-7")?.meaning, "Situación controlada");
  assert.equal(claveByCode("1-2")?.meaning, "Se solicita al lugar: ambulancia SAMU");
  assert.equal(claveByCode("2-1")?.meaning, "Despache al lugar: carro porta escala (Q)");
  assert.equal(claveByCode("10-0-2")?.meaning, "Incendio de casa o local comercial menor");
  assert.match(CLAVES_TEXT, /6-19 Se informa bombero accidentado/);
});

test("findClaves: claves de 3 partes, sin confundir unidades ni claves desconocidas", () => {
  const hits = findClaves("Central a B-3: 10-0-2, 0-6. RX-15 6-3; clave 6-99 y 21-14.");
  assert.deepEqual(
    hits.map((h) => h.clave.code),
    ["10-0-2", "0-6", "6-3"],
  );
});

test("expandClaves agrega el significado en claro tras cada clave", () => {
  assert.equal(expandClaves("OBAC a Central: 6-7."), "OBAC a Central: 6-7 (Situación controlada).");
  assert.equal(expandClaves("Sin claves"), "Sin claves");
});
