import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_NEXT_PATH, sanitizeNextPath } from "./next-path";

describe("sanitizeNextPath", () => {
  it("acepta rutas internas", () => {
    assert.equal(sanitizeNextPath("/mando"), "/mando");
    assert.equal(sanitizeNextPath("/mando?x=1"), "/mando?x=1");
    assert.equal(sanitizeNextPath("/mando/abc-123?tab=media#fotos"), "/mando/abc-123?tab=media#fotos");
    assert.equal(sanitizeNextPath("/"), "/");
    assert.equal(sanitizeNextPath("/mando/personal?next=//evil.com"), "/mando/personal?next=//evil.com");
  });

  it("rechaza destinos externos o ambiguos", () => {
    const bad = [
      "//evil.com",
      "//evil.com/mando",
      "/\\evil",
      "/\\/evil.com",
      "/mando\\..\\..\\evil",
      "https://x",
      "http://evil.com/mando",
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "data:text/html,hola",
      "mando",
      "",
      "   ",
      "/\tevil",
      "/\n/evil.com",
      " //evil.com",
      "/mando\u0000",
      "/" + "a".repeat(3000),
    ];
    for (const b of bad) assert.equal(sanitizeNextPath(b), DEFAULT_NEXT_PATH, JSON.stringify(b));
  });

  it("evita volver al login", () => {
    assert.equal(sanitizeNextPath("/login"), DEFAULT_NEXT_PATH);
    assert.equal(sanitizeNextPath("/login?next=/mando"), DEFAULT_NEXT_PATH);
  });

  it("usa el respaldo para null/undefined y respeta un respaldo propio", () => {
    assert.equal(sanitizeNextPath(null), DEFAULT_NEXT_PATH);
    assert.equal(sanitizeNextPath(undefined), DEFAULT_NEXT_PATH);
    assert.equal(sanitizeNextPath("//evil.com", "/"), "/");
  });

  it("el respaldo por defecto es /mando", () => {
    assert.equal(DEFAULT_NEXT_PATH, "/mando");
  });
});
