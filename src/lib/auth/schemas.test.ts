import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CreateStaffSchema, LoginSchema, normalizeEmail } from "./schemas";

describe("esquemas de personal", () => {
  it("normaliza el correo a minúsculas sin espacios", () => {
    assert.equal(normalizeEmail("  Ana.Perez@Bomberos.CL "), "ana.perez@bomberos.cl");
    const r = LoginSchema.parse({ email: " Admin@Vigia.Local ", password: "x" });
    assert.equal(r.email, "admin@vigia.local");
  });

  it("login de maqueta: acepta datos vacíos o ausentes y solo acota el largo", () => {
    assert.deepEqual(LoginSchema.parse({}), { email: "", password: "" });
    assert.deepEqual(LoginSchema.parse({ email: "", password: "" }), { email: "", password: "" });
    assert.deepEqual(LoginSchema.parse({ email: "a@b.cl" }), { email: "a@b.cl", password: "" });
    assert.equal(LoginSchema.safeParse({ email: "a@b.cl", password: "x".repeat(300) }).success, false);
    assert.equal(LoginSchema.safeParse({ email: "a".repeat(300), password: "x" }).success, false);
  });

  it("crear cuenta valida correo, nombre, rol y contraseña no vacía", () => {
    const good = { email: "Op@Bomberos.cl", name: " Operadora Uno ", role: "operator", password: "0123456789" };
    const r = CreateStaffSchema.parse(good);
    assert.deepEqual(r, { email: "op@bomberos.cl", name: "Operadora Uno", role: "operator", password: "0123456789" });
    assert.equal(CreateStaffSchema.safeParse({ ...good, email: "no-es-correo" }).success, false);
    assert.equal(CreateStaffSchema.safeParse({ ...good, name: "  " }).success, false);
    assert.equal(CreateStaffSchema.safeParse({ ...good, role: "root" }).success, false);
    assert.equal(CreateStaffSchema.safeParse({ ...good, password: "" }).success, false);
  });
});
