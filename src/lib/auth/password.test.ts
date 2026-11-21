import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SCRYPT_PARAMS, dummyVerify, hashPassword, verifyPassword } from "./password";

describe("hash de contraseñas (scrypt)", () => {
  it("genera un hash autodescriptivo con sal aleatoria", async () => {
    const a = await hashPassword("clave-larga-123");
    const b = await hashPassword("clave-larga-123");
    const parts = a.split("$");
    assert.equal(parts.length, 6);
    assert.deepEqual(parts.slice(0, 4), ["scrypt", String(SCRYPT_PARAMS.N), String(SCRYPT_PARAMS.r), String(SCRYPT_PARAMS.p)]);
    assert.equal(Buffer.from(parts[4], "base64url").length, SCRYPT_PARAMS.saltBytes);
    assert.equal(Buffer.from(parts[5], "base64url").length, SCRYPT_PARAMS.keylen);
    assert.notEqual(a, b, "dos hashes de la misma clave deben diferir por la sal");
  });

  it("verifica la contraseña correcta y rechaza la incorrecta", async () => {
    const h = await hashPassword("Bomberos#2026");
    assert.equal(await verifyPassword("Bomberos#2026", h), true);
    assert.equal(await verifyPassword("bomberos#2026", h), false);
    assert.equal(await verifyPassword("", h), false);
  });

  it("acepta contraseñas con caracteres no ASCII", async () => {
    const h = await hashPassword("contraseña-ñandú-🔥");
    assert.equal(await verifyPassword("contraseña-ñandú-🔥", h), true);
    assert.equal(await verifyPassword("contrasena-nandu-🔥", h), false);
  });

  it("rechaza (sin lanzar) un hash manipulado o malformado", async () => {
    const h = await hashPassword("una-clave-segura");
    const parts = h.split("$");
    const flipped = parts[5][0] === "A" ? "B" + parts[5].slice(1) : "A" + parts[5].slice(1);
    const tamperedHash = [...parts.slice(0, 5), flipped].join("$");
    const otherSalt = (await hashPassword("x")).split("$")[4];
    const tamperedSalt = [...parts.slice(0, 4), otherSalt, parts[5]].join("$");
    const cases = [
      tamperedHash,
      tamperedSalt,
      h.replace("scrypt$", "bcrypt$"),
      h.replace(`$${SCRYPT_PARAMS.N}$`, "$16384$"),
      h.replace(`$${SCRYPT_PARAMS.N}$`, "$1048577$"), // no es potencia de 2
      h.replace(`$${SCRYPT_PARAMS.N}$`, "$4194304$"), // excede el máximo permitido
      h.replace(`$${SCRYPT_PARAMS.r}$`, "$999$"),
      parts.slice(0, 5).join("$"),
      `${h}$extra`,
      "",
      "scrypt$32768$8$1$!!!$???",
    ];
    for (const c of cases) assert.equal(await verifyPassword("una-clave-segura", c), false, c);
  });

  it("la verificación de relleno no lanza", async () => {
    await dummyVerify("lo-que-sea");
    await dummyVerify("");
  });
});
