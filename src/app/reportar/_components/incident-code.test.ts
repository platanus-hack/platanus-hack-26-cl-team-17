import { test } from "node:test";
import assert from "node:assert/strict";
import { firstParam, parseIncidentCode, safeDecode } from "./incident-code";

test("normaliza lo que escribe un vecino", () => {
  assert.equal(parseIncidentCode("vg 7k3q"), "VG-7K3Q");
  assert.equal(parseIncidentCode("VG-7K3Q"), "VG-7K3Q");
  assert.equal(parseIncidentCode("  vg-7k3q  "), "VG-7K3Q");
  assert.equal(parseIncidentCode("7k3q"), "VG-7K3Q");
  assert.equal(parseIncidentCode("vg_7k.3q"), "VG-7K3Q");
  assert.equal(parseIncidentCode("VG7K3Q"), "VG-7K3Q");
});

test("rechaza lo que no tiene forma de código", () => {
  assert.equal(parseIncidentCode(""), null);
  assert.equal(parseIncidentCode("vg"), null);
  assert.equal(parseIncidentCode("VG-7K"), null);
  assert.equal(parseIncidentCode("VG-123456789"), null);
  assert.equal(parseIncidentCode("ñandú"), null);
  assert.equal(parseIncidentCode(null), null);
  assert.equal(parseIncidentCode(undefined), null);
});

test("coincide con normalizeIncidentCode del servidor en códigos válidos", async () => {
  const { normalizeIncidentCode, newIncidentCode } = await import("@/lib/ids");
  for (const raw of ["vg 7k3q", "VG-ABCD", "abcd", "Vg-2345"]) {
    assert.equal(parseIncidentCode(raw), normalizeIncidentCode(raw));
  }
  for (let i = 0; i < 50; i++) {
    const code = newIncidentCode();
    assert.equal(parseIncidentCode(code), code);
    assert.equal(parseIncidentCode(code.toLowerCase().replace("-", " ")), code);
  }
});

test("firstParam y safeDecode", () => {
  assert.equal(firstParam(["a", "b"]), "a");
  assert.equal(firstParam("x"), "x");
  assert.equal(firstParam(undefined), undefined);
  assert.equal(safeDecode("VG%207K3Q"), "VG 7K3Q");
  assert.equal(safeDecode("%E0%A4%A"), "%E0%A4%A");
});
