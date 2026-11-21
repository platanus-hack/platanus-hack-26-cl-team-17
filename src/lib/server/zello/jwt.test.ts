import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { signZelloToken, zelloTokenSource } from "./jwt";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const fromB64Url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

test("signZelloToken firma un JWT RS256 con iss y exp que se verifica con la llave pública", () => {
  const token = signZelloToken({ issuer: "ISS.abc", privateKey, nowSeconds: 1_700_000_000, ttlSeconds: 120 });
  const [h, b, sig] = token.split(".");
  assert.deepEqual(JSON.parse(fromB64Url(h).toString()), { alg: "RS256", typ: "JWT" });
  assert.deepEqual(JSON.parse(fromB64Url(b).toString()), { iss: "ISS.abc", exp: 1_700_000_120 });
  assert.doesNotMatch(token, /[+/=]/);
  const v = createVerify("RSA-SHA256");
  v.update(`${h}.${b}`);
  assert.ok(v.verify(publicKey, fromB64Url(sig)));
});

test("zelloTokenSource prefiere el token de desarrollo y si no firma uno nuevo", () => {
  assert.equal(zelloTokenSource({ authToken: "dev", issuer: "x", privateKey })?.(), "dev");
  const fresh = zelloTokenSource({ authToken: "", issuer: "ISS", privateKey });
  assert.ok(fresh);
  assert.equal(fresh().split(".").length, 3);
  assert.equal(zelloTokenSource({ authToken: "", issuer: "", privateKey: "" }), null);
  assert.throws(() => signZelloToken({ issuer: "", privateKey: "" }), /ZELLO_ISSUER/);
});
