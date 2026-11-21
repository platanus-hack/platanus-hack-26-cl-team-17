/**
 * Guion del modo demo de Vigía: dos compañías hablando a la vez por radio, con claves.
 * Puro (lo usan el botón de la mesa de mando y scripts/vigia-radio-demo.mjs, que genera
 * los audios de prueba). Los audios reales de Agustín reemplazan los archivos con el mismo
 * nombre en public/demo/; si faltan, las líneas igual entran a la bitácora.
 *
 * Todo entra como source "simulated": la bitácora lo rotula y nunca pasa por real.
 */

export interface DemoRadioLine {
  /** Milisegundos desde que parte el audio de esa radio hasta que termina la frase (ahí entra a la bitácora). */
  offset_ms: number;
  speaker: string;
  channel: string;
  text: string;
}

export interface DemoRadio {
  /** Archivo en public/ (p. ej. /demo/radio-b3.mp3). */
  src: string;
  lines: DemoRadioLine[];
}

/**
 * Pedido de "hace 6 minutos" (B-3 todavía en camino) que nadie confirmó: Vigía lo recuerda.
 * Se registra con la hora atrasada antes de que suenen las radios.
 */
export const DEMO_EARLIER_LINE = {
  minutes_ago: 6,
  speaker: "B-3",
  channel: "5-2",
  text: "Central, B-3 en camino, 0-6. Se solicita 2-2 al lugar.",
};

export const DEMO_RADIOS: DemoRadio[] = [
  {
    src: "/demo/radio-b3.mp3",
    lines: [
      {
        offset_ms: 9800,
        speaker: "B-3",
        channel: "5-2",
        text: "Central, B-3, 6-0, OBAC 43 con 8 voluntarios. 7-0 en la esquina norte. Es un 10-6, fuerte olor a gas en la calle.",
      },
      {
        offset_ms: 17000,
        speaker: "B-3",
        channel: "5-2",
        text: "B-3 a Central, se solicita 1-2 por un vecino con mareos. Cortamos el tránsito en la cuadra.",
      },
    ],
  },
  {
    src: "/demo/radio-b5.mp3",
    lines: [
      {
        offset_ms: 5000,
        speaker: "B-5",
        channel: "5-3",
        text: "Central, B-5, 6-3 por el lado C. Armados a grifo en la esquina sur.",
      },
      {
        offset_ms: 11100,
        speaker: "B-5",
        channel: "5-3",
        text: "B-5 informa: tercer piso despejado por el lado C, sin moradores a la vista.",
      },
    ],
  },
];

/** Texto que se lee en cada audio de prueba (las líneas de esa radio, con pausas). */
export function demoRadioSpeech(radio: DemoRadio): string {
  return radio.lines.map((l) => l.text).join(" ... ");
}
