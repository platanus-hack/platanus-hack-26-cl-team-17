/**
 * Token del callback del job de GPU: HMAC-SHA256 (hex) con config.fileSecret sobre
 * `splat:<incidentId>:<reconstructionId>`. Lo genera y verifica solo el servidor;
 * el job lo recibe en SPLAT_CALLBACK_TOKEN y lo reenvía como Bearer. Solo servidor.
 */
import { config } from "@/lib/config";
import { hmacHex, safeEqual } from "@/lib/ids";

export function reconstructionToken(
  incidentId: string,
  reconstructionId: string,
  secret: string = config.fileSecret,
): string {
  return hmacHex(secret, `splat:${incidentId}:${reconstructionId}`);
}

export function verifyReconstructionToken(
  token: string | null | undefined,
  incidentId: string,
  reconstructionId: string,
  secret: string = config.fileSecret,
): boolean {
  if (!token || !incidentId || !reconstructionId) return false;
  return safeEqual(token, reconstructionToken(incidentId, reconstructionId, secret));
}
