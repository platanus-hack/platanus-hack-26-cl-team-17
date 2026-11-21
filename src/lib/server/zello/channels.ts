/**
 * Quién habla en el canal de Zello. Hay un solo canal (ZELLO_CHANNEL): ahí hablan las
 * compañías, el OBAC y Vigía. Lo que dice el OBAC es una pregunta para Vigía.
 */
import type { CommEntry } from "@/lib/domain";
import { config } from "@/lib/config";
import { fold, mentionsVigia } from "@/lib/vigia/rules";

/** Speaker con que el puente registra lo que Vigía dice en el canal (el agente ignora "Vigía…"). */
export const VIGIA_SPEAKER = "Vigía";

/**
 * Vocativo al inicio, sobre el texto sin tildes: «Vigía, …», «¿Vigía, …?», «Oye, Vigía…».
 * La transcripción a veces oye «Vigilia» o «Wikipedia» (pasó en la prueba real).
 */
const VOCATIVE = /^[\s¿¡"'«(.,—-]*(?:(?:oye|hola|ya|ok|okey|alo)[\s,]+)?(?:vigia|vigilia|wikipedia)\b/;

/** Versión pura de isObacComm, con el usuario del OBAC explícito (para pruebas). */
export function isObacCommWith(comm: Pick<CommEntry, "source" | "speaker" | "text">, obacUsername: string): boolean {
  if (comm.source !== "zello" || isVigiaVoiceComm(comm)) return false;
  const obac = obacUsername.trim().toLowerCase();
  if (obac && comm.speaker.trim().toLowerCase() === obac) return true;
  // mentionsVigia (del agente) tolera «Viking», «vigila», «bigía»… al inicio o al final.
  return VOCATIVE.test(fold(comm.text)) || mentionsVigia(comm.text);
}

/**
 * true si la entrada es una pregunta del OBAC a Vigía: llegó por Zello y la dijo el
 * usuario ZELLO_OBAC_USERNAME, o le habla a Vigía («Vigía, …», «… ese vigila»).
 */
export function isObacComm(comm: Pick<CommEntry, "source" | "speaker" | "text">): boolean {
  return isObacCommWith(comm, config.zelloObacUsername);
}

/** true si la entrada es algo que dijo Vigía por Zello (no es tráfico de las compañías). */
export function isVigiaVoiceComm(comm: Pick<CommEntry, "source" | "speaker">): boolean {
  return comm.source === "zello" && fold(comm.speaker.trim()).startsWith("vigia");
}
