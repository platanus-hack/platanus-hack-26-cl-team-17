/**
 * Token de la Zello Channel API para Zello gratis (zello.io): un JWT RS256 con solo
 * `iss` y `exp`, firmado con la llave privada de developers.zello.com. Igual al
 * ejemplo oficial (zello-channel-api/auth/js/tokenmanager.js), sin dependencias.
 */
import { createSign } from "node:crypto";

/** El token solo se usa al iniciar sesión: basta con que dure unos minutos. */
const DEFAULT_TTL_S = 300;

function base64Url(data: string | Buffer): string {
  return Buffer.from(data).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function signZelloToken(opts: { issuer: string; privateKey: string; nowSeconds?: number; ttlSeconds?: number }): string {
  if (!opts.issuer || !opts.privateKey) throw new Error("Faltan ZELLO_ISSUER y ZELLO_PRIVATE_KEY para firmar el token de Zello.");
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const head = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = base64Url(JSON.stringify({ iss: opts.issuer, exp: now + (opts.ttlSeconds ?? DEFAULT_TTL_S) }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${head}.${body}`);
  return `${head}.${body}.${base64Url(signer.sign(opts.privateKey))}`;
}

/**
 * Fuente del auth_token del logon: el token de desarrollo (ZELLO_AUTH_TOKEN) si está,
 * o uno recién firmado en cada conexión. null si no hay ninguno de los dos.
 */
export function zelloTokenSource(env: { authToken: string; issuer: string; privateKey: string }): (() => string) | null {
  if (env.authToken) return () => env.authToken;
  if (env.issuer && env.privateKey) return () => signZelloToken({ issuer: env.issuer, privateKey: env.privateKey });
  return null;
}
