import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CreateStaffSchema, LoginSchema, normalizeEmail } from "./schemas";

describe("esquemas de personal", () => {
  it("normaliza el correo a minúsculas sin espacios", () => {
    assert.equal(normalizeEmail("  Ana.Perez@Bomberos.CL "), "ana.perez@bomberos.cl");
    const r = LoginSchema.parse({ email: " Admin@Vigia.Local ", password: "x" });
    assert.equal(r.email, "admin@vigia.local");
  });

  it("login exige correo y contraseña", () => {
    assert.equal(LoginSchema.safeParse({ email: "", password: "x" }).success, false);
    assert.equal(LoginSchema.safeParse({ email: "a@b.cl", password: "" }).success, false);
    assert.equal(LoginSchema.safeParse({ email: "a@b.cl" }).success, false);
    assert.equal(LoginSchema.safeParse({ email: "a@b.cl", password: "x".repeat(300) }).success, false);
  });

  it("crear cuenta valida correo, nombre, rol y contraseña ≥ 10", () => {
    const good = { email: "Op@Bomberos.cl", name: " Operadora Uno ", role: "operator", password: "0123456789" };
    const r = CreateStaffSchema.parse(good);
    assert.deepEqual(r, { email: "op@bomberos.cl", name: "Operadora Uno", role: "operator", password: "0123456789" });
    assert.equal(CreateStaffSchema.safeParse({ ...good, email: "no-es-correo" }).success, false);
    assert.equal(CreateStaffSchema.safeParse({ ...good, name: "  " }).success, false);
    assert.equal(CreateStaffSchema.safeParse({ ...good, role: "root" }).success, false);
    assert.equal(CreateStaffSchema.safeParse({ ...good, password: "123456789" }).success, false);
  });
});
