import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { reconstructionToken, verifyReconstructionToken } from "./token";
import { INCIDENT_ID, REC_ID } from "./test-fixtures";

const SECRET = "secreto-de-prueba";

test("el token es HMAC-SHA256 hex de splat:<incidente>:<reconstrucción>", () => {
  const expected = createHmac("sha256", SECRET).update(`splat:${INCIDENT_ID}:${REC_ID}`).digest("hex");
  assert.equal(reconstructionToken(INCIDENT_ID, REC_ID, SECRET), expected);
  assert.match(expected, /^[0-9a-f]{64}$/);
});

test("verifica el token correcto", () => {
  const token = reconstructionToken(INCIDENT_ID, REC_ID, SECRET);
  assert.equal(verifyReconstructionToken(token, INCIDENT_ID, REC_ID, SECRET), true);
});

test("rechaza token de otra reconstrucción, otro incidente, otro secreto o vacío", () => {
  const token = reconstructionToken(INCIDENT_ID, REC_ID, SECRET);
  assert.equal(verifyReconstructionToken(token, INCIDENT_ID, "otra", SECRET), false);
  assert.equal(verifyReconstructionToken(token, "otro-incidente", REC_ID, SECRET), false);
  assert.equal(verifyReconstructionToken(token, INCIDENT_ID, REC_ID, "otro-secreto"), false);
  assert.equal(verifyReconstructionToken("", INCIDENT_ID, REC_ID, SECRET), false);
  assert.equal(verifyReconstructionToken(null, INCIDENT_ID, REC_ID, SECRET), false);
  assert.equal(verifyReconstructionToken(token.slice(0, 63), INCIDENT_ID, REC_ID, SECRET), false);
  assert.equal(verifyReconstructionToken(token.toUpperCase(), INCIDENT_ID, REC_ID, SECRET), false);
});

test("por defecto usa config.fileSecret", () => {
  const token = reconstructionToken(INCIDENT_ID, REC_ID);
  assert.equal(verifyReconstructionToken(token, INCIDENT_ID, REC_ID), true);
});
