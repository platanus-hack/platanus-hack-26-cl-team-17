/**
 * RADIO_GLOSSARY — términos radiales que la IA puede interpretar con seguridad.
 *
 * ADVERTENCIA: las claves y la nomenclatura de unidades varían entre Cuerpos de
 * Bomberos de Chile, y la investigación de radio quedó incompleta. Por eso aquí
 * solo hay lenguaje claro y términos de alta certeza. No se incluye ninguna
 * clave numérica (10-x, 6-x…): el único listado hallado es no oficial e
 * inconsistente (ver .coord/research-doctrina.md). Si un Cuerpo necesita sus
 * claves, deben configurarse explícitamente, nunca adivinarse.
 *
 * Lo usan el prompt de comunicaciones (texto) y el motor de reglas
 * (codes_interpreted solo para términos de esta lista).
 */
import type { Confidence } from "@/lib/domain";

export interface RadioGlossaryEntry {
  /** Forma canónica, tal como se mostraría en el panel. */
  term: string;
  /** Variantes en minúsculas y sin tildes con que aparece en la bitácora (para el motor de reglas). */
  aliases: readonly string[];
  meaning: string;
  certainty: Confidence;
}

export const RADIO_GLOSSARY: readonly RadioGlossaryEntry[] = [
  {
    term: "En el lugar",
    aliases: ["en el lugar", "en el sitio", "llegando al lugar", "llegamos al lugar"],
    meaning: "La unidad llegó a la emergencia; desde ahí lo que informa es observación directa.",
    certainty: "high",
  },
  {
    term: "Mayday / bombero en peligro",
    aliases: ["mayday", "bombero en peligro", "bombero herido", "bombero atrapado", "bombero perdido", "bombero extraviado"],
    meaning: "Emergencia de un bombero: perdido, atrapado, herido o sin aire. Prioridad absoluta del mando.",
    certainty: "high",
  },
  {
    term: "Personas atrapadas",
    aliases: ["personas atrapadas", "persona atrapada", "gente atrapada", "victimas atrapadas", "victima atrapada", "atrapados", "atrapado", "atrapada"],
    meaning: "Se informa al menos una víctima que no puede salir por sus medios.",
    certainty: "high",
  },
  {
    term: "Sin personas atrapadas",
    aliases: ["sin personas atrapadas", "no hay personas atrapadas", "no hay atrapados", "sin atrapados", "sin victimas", "no hay victimas"],
    meaning: "Una unidad informa que no hay víctimas atrapadas. Solo vale si quien lo dice está en el lugar.",
    certainty: "high",
  },
  {
    term: "Pre-informe",
    aliases: ["pre-informe", "preinforme", "pre informe", "informe de situacion"],
    meaning: "Primer informe del OBAC a la Central: tipo y afectación, riesgo a la vida, propagación, estrategia y recursos.",
    certainty: "high",
  },
  {
    term: "OBAC",
    aliases: ["obac"],
    meaning: "Oficial o Bombero a Cargo de la emergencia; define estrategia y sectorización.",
    certainty: "high",
  },
  {
    term: "Central",
    aliases: ["central", "cat"],
    meaning: "Central de Alarmas y Telecomunicaciones: despacha y recibe los informes.",
    certainty: "high",
  },
  {
    term: "Con / sin peligro de propagación",
    aliases: ["peligro de propagacion", "sin peligro de propagacion", "con peligro de propagacion", "se evalua peligro de propagacion"],
    meaning: "Elemento obligatorio del pre-informe sobre si el fuego puede extenderse a exposiciones.",
    certainty: "high",
  },
  {
    term: "Estrategia ofensiva / defensiva",
    aliases: ["estrategia ofensiva", "estrategia defensiva", "ataque ofensivo", "ataque defensivo"],
    meaning: "Ofensiva = trabajo interior; defensiva = desde el exterior, sin ingreso. La fija el OBAC.",
    certainty: "high",
  },
  {
    term: "Fuego controlado",
    aliases: ["fuego controlado", "incendio controlado", "emergencia controlada", "fuego dominado", "incendio dominado"],
    meaning: "El fuego dejó de avanzar; aún puede haber trabajo de remoción y riesgo de reignición.",
    certainty: "high",
  },
  {
    term: "Alarma (2ª, 3ª, general)",
    aliases: ["segunda alarma", "2a alarma", "2da alarma", "tercera alarma", "3a alarma", "3ra alarma", "alarma general"],
    meaning: "Escalamiento del despacho: se llaman más unidades al incidente.",
    certainty: "medium",
  },
  {
    term: "Material mayor",
    aliases: ["material mayor"],
    meaning: "Los carros de Bomberos (bombas, escalas, rescate…).",
    certainty: "high",
  },
  {
    term: "Lado Alfa",
    aliases: ["lado alfa", "lado principal"],
    meaning: "Lado principal del incidente, normalmente la fachada hacia la calle principal. Bravo/Charlie/Delta siguen en sentido horario (convención SCI, no verificada en Chile).",
    certainty: "medium",
  },
  {
    term: "Puesto de Comando",
    aliases: ["puesto de comando", "puesto de mando"],
    meaning: "Lugar desde donde opera el mando del incidente.",
    certainty: "medium",
  },
  {
    term: "Identificadores de unidad (B, BX, Q, RX, H, Z…)",
    aliases: [],
    meaning:
      "Letras + número del carro, p. ej. B-3, RX-15, Q-8. Son identificadores de unidad; qué tipo de carro indica cada letra varía por Cuerpo, así que no se asume su especialidad.",
    certainty: "medium",
  },
];

/** Bloque de texto para incluir en el prompt de sistema de comunicaciones. */
export const RADIO_GLOSSARY_TEXT: string = [
  "RADIO_GLOSSARY — términos que puedes interpretar (lista cerrada):",
  "Advertencia: las claves radiales varían entre Cuerpos de Bomberos. NO interpretes claves numéricas (10-x, 6-x u otras): si aparecen, regístralas en codes_interpreted con certainty=low y meaning \"Clave no verificada para este Cuerpo; confirmar\". No deduzcas la especialidad de una unidad por su letra.",
  ...RADIO_GLOSSARY.map((e) => `- ${e.term} (certeza ${e.certainty}): ${e.meaning}`),
].join("\n");
