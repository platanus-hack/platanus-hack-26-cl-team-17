/**
 * RADIO_GLOSSARY — términos radiales en lenguaje claro que la IA puede interpretar con seguridad.
 *
 * Las claves numéricas (6-7, 10-0-2…) varían entre Cuerpos de Bomberos y no van
 * aquí: viven en ./radio-claves.ts, el libro de claves configurado para esta
 * instalación (CBLA, RC-03/2022). Una clave fuera de ese libro nunca se adivina.
 *
 * Lo usan el prompt de comunicaciones (texto) y el motor de reglas
 * (codes_interpreted solo para términos de esta lista y claves del libro).
 */
import type { Confidence } from "@/lib/domain";
import { CLAVES_SOURCE } from "./radio-claves";

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
    aliases: ["fuego controlado", "incendio controlado", "emergencia controlada", "situacion controlada", "fuego dominado", "incendio dominado"],
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
    term: "Sectores Alfa, Bravo, Charlie, Delta",
    aliases: ["sector alfa", "sector bravo", "sector charlie", "sector delta", "lado alfa", "lado bravo", "lado charlie", "lado delta", "lado principal"],
    meaning:
      "Sectorización del lugar. Alfa = frente o fachada principal (hacia la calle); Bravo, Charlie y Delta siguen en sentido horario visto desde arriba: Bravo a la izquierda mirando la fachada, Charlie el fondo, Delta a la derecha. Si el OBAC fija otra referencia por radio, manda lo que dijo.",
    certainty: "high",
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
  `Claves numéricas: interpreta solo las del libro de claves (${CLAVES_SOURCE}) que viene aparte. Cualquier otra clave numérica va en codes_interpreted con certainty=low y meaning "Clave no verificada para este Cuerpo; confirmar". No deduzcas la especialidad de una unidad por su letra.`,
  ...RADIO_GLOSSARY.map((e) => `- ${e.term} (certeza ${e.certainty}): ${e.meaning}`),
].join("\n");
