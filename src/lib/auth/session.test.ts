import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SESSION_TTL_MS,
  SESSION_VERSION,
  SessionConfigError,
  clearedSessionCookieOptions,
  createSessionToken,
  getSessionSecret,
  isSecureRequest,
  sessionCookieOptions,
  signSessionPayload,
  verifySessionToken,
} from "./session";

const SECRET = "secreto-de-prueba-0123456789abcdef";
const SID = "6f1c1b7e-2a51-4a59-9f2f-1d0c1e2a3b4c";

function b64urlJson(v: unknown): string {
  return Buffer.from(JSON.stringify(v)).toString("base64url");
}

describe("cookie de sesión firmada (HMAC-SHA256)", () => {
  it("firma y verifica un token válido", async () => {
    const now = Date.now();
    const token = await createSessionToken(SID, SECRET, now);
    assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const payload = await verifySessionToken(token, SECRET, now + 1000);
    assert.deepEqual(payload, { sid: SID, exp: now + SESSION_TTL_MS, v: SESSION_VERSION });
  });

  it("dura 12 horas", () => {
    assert.equal(SESSION_TTL_MS, 12 * 60 * 60 * 1000);
  });

  it("rechaza un payload manipulado con la firma original", async () => {
    const now = Date.now();
    const token = await createSessionToken(SID, SECRET, now);
    const [, sig] = token.split(".");
    const forgedBody = b64urlJson({ sid: "otra-cuenta", exp: now + SESSION_TTL_MS, v: 1 });
    assert.equal(await verifySessionToken(`${forgedBody}.${sig}`, SECRET, now), null);
    const longerExp = b64urlJson({ sid: SID, exp: now + 10 * SESSION_TTL_MS, v: 1 });
    assert.equal(await verifySessionToken(`${longerExp}.${sig}`, SECRET, now), null);
  });

  it("rechaza una firma manipulada", async () => {
    const token = await createSessionToken(SID, SECRET);
    const [body, sig] = token.split(".");
    const flipped = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
    assert.equal(await verifySessionToken(`${body}.${flipped}`, SECRET), null);
    assert.equal(await verifySessionToken(`${body}.${sig.slice(0, -2)}`, SECRET), null);
    assert.equal(await verifySessionToken(`${body}.`, SECRET), null);
    assert.equal(await verifySessionToken(`${body}.${sig}.extra`, SECRET), null);
    assert.equal(await verifySessionToken(body, SECRET), null);
  });

  it("rechaza un token vencido", async () => {
    const now = Date.now();
    const token = await createSessionToken(SID, SECRET, now);
    assert.notEqual(await verifySessionToken(token, SECRET, now + SESSION_TTL_MS - 1), null);
    assert.equal(await verifySessionToken(token, SECRET, now + SESSION_TTL_MS), null);
    assert.equal(await verifySessionToken(token, SECRET, now + SESSION_TTL_MS + 60_000), null);
  });

  it("rechaza un token firmado con otro secreto", async () => {
    const token = await createSessionToken(SID, SECRET);
    assert.equal(await verifySessionToken(token, "otro-secreto-distinto"), null);
    assert.equal(await verifySessionToken(token, ""), null);
  });

  it("rechaza otra versión del payload aunque la firma sea válida", async () => {
    const exp = Date.now() + 60_000;
    const v2 = await signSessionPayload({ sid: SID, exp, v: 2 }, SECRET);
    assert.equal(await verifySessionToken(v2, SECRET), null);
    const v1 = await signSessionPayload({ sid: SID, exp, v: 1 }, SECRET);
    assert.notEqual(await verifySessionToken(v1, SECRET), null);
  });

  it("rechaza tokens vacíos, basura y payloads con forma inválida", async () => {
    for (const t of [undefined, null, "", ".", "a.b", "%%%.%%%", "x".repeat(5000)]) {
      assert.equal(await verifySessionToken(t, SECRET), null, String(t));
    }
    const exp = Date.now() + 60_000;
    // Firmados correctamente pero con campos inválidos.
    const bad = [
      { sid: "", exp, v: 1 },
      { sid: SID, exp: "mañana", v: 1 },
      { sid: 42, exp, v: 1 },
    ];
    for (const p of bad) {
      const token = await signSessionPayload(p as never, SECRET);
      assert.equal(await verifySessionToken(token, SECRET), null, JSON.stringify(p));
    }
  });
});

describe("secreto de sesión", () => {
  const saved = process.env.VIGIA_SESSION_SECRET;
  afterEach(() => {
    if (saved === undefined) delete process.env.VIGIA_SESSION_SECRET;
    else process.env.VIGIA_SESSION_SECRET = saved;
  });

  it("lanza un error claro si falta VIGIA_SESSION_SECRET", () => {
    delete process.env.VIGIA_SESSION_SECRET;
    assert.throws(() => getSessionSecret(), (err: unknown) => {
      assert.ok(err instanceof SessionConfigError);
      assert.match((err as Error).message, /VIGIA_SESSION_SECRET/);
      return true;
    });
  });

  it("devuelve el secreto configurado", () => {
    process.env.VIGIA_SESSION_SECRET = "  abc123  ";
    assert.equal(getSessionSecret(), "abc123");
  });

  it("no firma sin secreto", async () => {
    await assert.rejects(() => createSessionToken(SID, ""), SessionConfigError);
  });
});

describe("opciones de la cookie", () => {
  it("Secure según el protocolo o x-forwarded-proto", () => {
    assert.equal(isSecureRequest(new Request("https://vigia.example/api/auth/login")), true);
    assert.equal(isSecureRequest(new Request("http://localhost:3000/api/auth/login")), false);
    const behindLb = new Request("http://10.0.0.1:8080/api/auth/login", {
      headers: { "x-forwarded-proto": "https" },
    });
    assert.equal(isSecureRequest(behindLb), true);
    const chain = new Request("https://x/api", { headers: { "x-forwarded-proto": "http, https" } });
    assert.equal(isSecureRequest(chain), false);
  });

  it("HttpOnly, SameSite=Lax, Path=/ y 12 h", () => {
    const opts = sessionCookieOptions(new Request("https://vigia.example/"));
    assert.deepEqual(opts, { httpOnly: true, sameSite: "lax", path: "/", secure: true, maxAge: 43200 });
    assert.equal(clearedSessionCookieOptions(new Request("http://localhost/")).maxAge, 0);
  });
});
