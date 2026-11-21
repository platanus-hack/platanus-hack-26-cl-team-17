/**
 * Claves radiales del Cuerpo de Bomberos de Los Ángeles (CBLA).
 *
 * Fuente: Instructivo de Comandancia N° 03, «Radiocomunicaciones del Cuerpo de
 * Bomberos de Los Ángeles», Reglamento RC-03/2022. Es el libro de claves
 * configurado para esta instalación: la IA las interpreta con certeza alta y
 * cualquier otra clave numérica sigue tratándose como no verificada.
 *
 * Lo usan los prompts de radio y de situación (CLAVES_TEXT), el motor de reglas
 * (expandClaves / findClaves) y el simulacro de radio del panel.
 */

export interface RadioClave {
  code: string;
  /** Significado según el instructivo (sin los «………» de relleno). */
  meaning: string;
  /** Grupo del instructivo; algunos anteponen un verbo («Se solicita al lugar», «Despache al lugar»). */
  group: string;
}

interface ClaveGroup {
  group: string;
  /** Verbo común del grupo, si el instructivo lo pone como encabezado. */
  prefix?: string;
  claves: ReadonlyArray<readonly [code: string, meaning: string]>;
}

const GROUPS: readonly ClaveGroup[] = [
  {
    group: "Uso exclusivo Central de Alarmas",
    claves: [
      ["0-0", "Silenciar transmisiones"],
      ["0-1", "Proceda a evacuar informe del acto de servicio"],
      ["0-2", "Se consulta y se informa"],
      ["0-3", "Repita"],
      ["0-4", "Se trata de"],
      ["0-5", "Indique su ubicación"],
      ["0-6", "Diríjase al lugar con alarma"],
      ["0-7", "Diríjase al lugar sin alarma"],
      ["0-8", "Material mayor fuera de servicio"],
      ["0-9", "Material mayor en servicio"],
      ["0-10", "Regrese a su cuartel"],
      ["0-11", "Guardia preventiva"],
      ["0-12", "Manténgase alerta a instrucciones"],
      ["0-13", "Activar subcentral de apoyo"],
    ],
  },
  {
    group: "Comuníquese telefónicamente",
    prefix: "Comuníquese telefónicamente",
    claves: [
      ["3-0", "a la Central de Alarmas y Comunicaciones"],
      ["3-1", "a Comandancia"],
      ["3-2", "a su Compañía"],
      ["3-3", "a su domicilio"],
      ["3-4", "a su oficina"],
      ["3-6", "a Superintendencia"],
      ["3-7", "a celular de"],
    ],
  },
  {
    group: "Comuníquese telefónicamente",
    claves: [["3-5", "Desocupar teléfono de cuartel"]],
  },
  {
    group: "Se solicita al lugar",
    prefix: "Se solicita al lugar",
    claves: [
      ["1-0", "Carabineros"],
      ["1-1", "apoyo aéreo"],
      ["1-2", "ambulancia SAMU"],
      ["1-3", "Oficina de Emergencia Municipal"],
      ["1-4", "servicio de empresa que se indica"],
      ["1-5", "Brigada Forestal CONAF"],
      ["1-6", "Comandante"],
      ["1-7", "Capitán de Guardia"],
      ["1-8", "Departamento de Investigación de Incendios"],
      ["1-9", "apoyo bomberil que se indica"],
      ["1-10", "apoyo externo que se indica"],
    ],
  },
  {
    group: "Despache al lugar",
    prefix: "Despache al lugar",
    claves: [
      ["2-0", "carro bomba (B, BX, F)"],
      ["2-1", "carro porta escala (Q)"],
      ["2-2", "carro de rescate (R, RX)"],
      ["2-3", "ambulancia del Cuerpo (S)"],
      ["2-4", "carro cisterna (Z)"],
      ["2-5", "carro HazMat (H, HX)"],
      ["2-6", "carro que se indica"],
      ["2-7", "carro escala mecánica (M)"],
      ["2-8", "carro de transporte o apoyo logístico (J)"],
      ["2-9", "carro de Comandancia (K)"],
      ["2-10", "material mayor con motobomba adicional"],
      ["2-11", "grupo electrógeno estacionario"],
      ["2-12", "carro soporte de aire (C)"],
    ],
  },
  {
    group: "Sintonizar",
    prefix: "Sintonizar",
    claves: [
      ["5-0", "frecuencia nacional ayuda mutua"],
      ["5-1", "frecuencia principal y despacho CBLA digital"],
      ["5-2", "frecuencia táctica digital"],
      ["5-3", "frecuencia táctica análoga"],
      ["5-4", "frecuencia táctica análoga"],
      ["5-5", "frecuencia táctica análoga"],
      ["5-6", "frecuencia de coordinación de Comandantes"],
      ["5-7", "frecuencias internas de Compañía"],
    ],
  },
  {
    group: "Uso para emergencias",
    claves: [
      ["6-0", "Dar conformidad, OBAC y número de bomberos"],
      ["6-1", "Cuartelero o maquinista solo"],
      ["6-2", "Dirección exacta"],
      ["6-3", "Material en el lugar"],
      ["6-4", "Se solicita instrucciones"],
      ["6-5", "Indique ubicación de grifos"],
      ["6-6", "Se solicita personal al lugar"],
      ["6-7", "Situación controlada"],
      ["6-8", "Material mayor disponible"],
      ["6-9", "Material mayor se retira"],
      ["6-10", "Material mayor en su cuartel"],
      ["6-11", "Material mayor en pana"],
      ["6-12", "Material mayor sufrió colisión"],
      ["6-13", "Material mayor se dirige a diligencia"],
      ["6-14", "Material mayor se dirige a servicentro"],
      ["6-15", "Material mayor se dirige a centro asistencial"],
      ["6-16", "Falsa alarma"],
      ["6-17", "Fuego extinguido"],
      ["6-18", "Indique a Central bombero u oficial que tomó parte"],
      ["6-19", "Se informa bombero accidentado"],
    ],
  },
  {
    group: "Informes para oficiales al mando",
    claves: [
      ["7-0", "Se establece puesto de mando en"],
      ["7-1", "Indique hora del llamado, alarma y material concurrente"],
      ["7-2", "Indique ubicación, trabajo que realiza y si está armado a grifo"],
      ["7-3", "Cadáver en el lugar"],
      ["7-4", "Artefacto incendiario o explosivo"],
      ["7-5", "Se sufre agresión"],
      ["7-6", "Se solicita apoyo logístico para el personal"],
      ["7-7", "Informar a la prensa"],
      ["7-8", "Detener el trabajo y evacuar"],
      ["7-9", "Proceda a evacuar moradores o personas del lugar"],
      ["7-10", "Puesto de mando cesa funciones"],
      ["7-11", "Oficial que se indica a cargo de la emergencia"],
      ["7-12", "Diríjase a punto de prensa en"],
    ],
  },
  {
    group: "Comandantes",
    claves: [
      ["8-0", "Comandante disponible"],
      ["8-1", "Comandante no disponible"],
      ["8-2", "Envíe K al cuartel"],
      ["8-3", "Envíe K al domicilio"],
      ["8-4", "Envíe K a la oficina"],
      ["8-5", "Envíe K a"],
      ["8-6", "Me dirijo al lugar por medios propios"],
      ["8-7", "Concurrir Comandantes y Capitán de Guardia"],
    ],
  },
  {
    group: "Órdenes del Comandante",
    claves: [
      ["9-0", "Alerta preventiva (personal en alerta radial y carros alistados)"],
      ["9-1", "Acuartelamiento preventivo (dotación completa por carro)"],
      ["9-2", "Acuartelamiento de guardia nocturna"],
      ["9-3", "Acuartelamiento inmediato (doble dotación completa por carro)"],
      ["9-4", "Requerir bomberos y maquinistas para carros"],
    ],
  },
  {
    group: "Citaciones",
    claves: [
      ["10-20", "Citación de Superintendencia"],
      ["10-21", "Citación de Comandancia"],
      ["10-22", "Reunión de Compañía"],
      ["10-23", "Ejercicio"],
      ["10-24", "Academia"],
      ["10-25", "Campaña económica"],
    ],
  },
  {
    group: "Departamento de Comunicaciones y Central de Alarmas",
    claves: [
      ["11-0", "Indique cómo recibe"],
      ["11-1", "Fuerte y claro"],
      ["11-2", "Se recibe con interferencia"],
      ["11-3", "Central operando solo por frecuencia"],
      ["11-4", "Indique operadores en servicio"],
      ["11-5", "Central inicia transmisiones de prueba"],
      ["11-6", "Central con transmisión abierta accidentalmente"],
      ["11-7", "Central sin energía eléctrica (opera con equipo de respaldo)"],
      ["11-8", "Central con energía eléctrica"],
    ],
  },
  {
    group: "Actos de servicio",
    claves: [
      ["10-0-1", "Incendio menor"],
      ["10-0-2", "Incendio de casa o local comercial menor"],
      ["10-0-3", "Incendio en estructura superior a tres pisos"],
      ["10-0-4", "Incendio en estructura de gran afluencia de público"],
      ["10-0-5", "Incendio en industria con o sin presencia de material peligroso (Matpel)"],
      ["10-1-1", "Incendio de vehículo menor o pesado sin carga"],
      ["10-1-2", "Incendio de vehículo pesado sin carga peligrosa"],
      ["10-1-3", "Incendio de vehículo de transporte público (buses)"],
      ["10-1-4", "Incendio de vehículo con carga peligrosa"],
      ["10-2-1", "Incendio de basurales y pastizales menores"],
      ["10-2-2", "Incendio interfaz"],
      ["10-3-1", "Rescate de persona atrapada en altura"],
      ["10-3-2", "Rescate de persona en espacios confinados, estructura colapsada, derrumbe y zanjas"],
      ["10-3-3", "Rescate de persona atrapada en lecho de río"],
      ["10-3-4", "Atrapamiento de persona"],
      ["10-4-1", "Rescate vehicular máximo 4 personas"],
      ["10-4-2", "Rescate vehicular con mínimo 5 personas"],
      ["10-4-3", "Rescate vehicular que involucre vehículo de transporte"],
      ["10-4-4", "Apoyo a SAMU o entidad médica"],
      ["10-4-5", "Rescate vehicular que involucra vehículo que transporta Matpel"],
      ["10-4-6", "Desbarrancamiento de vehículos o caída de vehículo a lecho de aguas"],
      ["10-5", "Incidente con Matpel (materiales peligrosos)"],
      ["10-6", "Emanación de gas"],
      ["10-7", "Accidente eléctrico"],
      ["10-8", "Emergencia no clasificada"],
      ["10-9-1", "Otros servicios no emergencias (drizas, agua, abrir departamento sin peligro)"],
      ["10-9-2", "Rescate animal"],
      ["10-10", "Llamado a escombros"],
      ["10-11", "Simulacro"],
      ["10-12", "Apoyo a otro Cuerpo de Bomberos"],
      ["10-13", "Posible atentado explosivo"],
      ["10-14", "Accidente aéreo"],
      ["10-15", "Asistencia paramédica (ronda médica para bomberos)"],
      ["10-16", "Emergencia asistencia pública (inundación, voladura de techumbre, caída de árbol)"],
      ["10-17", "Llamado preventivo (resguardo, escolta, stand by)"],
      ["10-18", "Servicio de investigación, inspección o asesorías"],
    ],
  },
  {
    group: "Advertencia o instrucciones",
    claves: [
      ["12-0", "Diríjase al lugar sin alarma"],
      ["12-1", "Asigna cuarteles de reemplazo"],
      ["12-2", "Retira cuarteles de reemplazo"],
      ["12-3", "Diríjase con máxima precaución"],
      ["12-4", "Toque sirena de cuartel"],
      ["12-5", "Active inversor de voz"],
      ["12-6", "Material mayor suficiente en el lugar"],
      ["12-7", "No armar"],
      ["12-8", "Capitán asume el mando del Cuerpo"],
      ["12-9", "Citación a Compañía"],
      ["12-10", "Solicita maquinista para"],
      ["12-11", "Material mayor o cuartel que se indica sin maquinista"],
      ["12-12", "Material mayor o cuartel que se indica con maquinista"],
      ["12-13", "Chofer cuartelero en servicio"],
      ["12-14", "Chofer cuartelero fuera de servicio"],
      ["12-15", "Material mayor que se indica con novedad"],
    ],
  },
];

/** Nombre del libro de claves configurado (se muestra en prompts y en el panel). */
export const CLAVES_SOURCE = "Cuerpo de Bomberos de Los Ángeles, Instructivo RC-03/2022";

/** Significado completo: el verbo del grupo + el ítem («Se solicita al lugar: ambulancia SAMU»). */
function fullMeaning(g: ClaveGroup, meaning: string): string {
  return g.prefix ? `${g.prefix}: ${meaning}` : meaning;
}

export const RADIO_CLAVES: readonly RadioClave[] = GROUPS.flatMap((g) =>
  g.claves.map(([code, meaning]) => ({ code, meaning: fullMeaning(g, meaning), group: g.group })),
);

const BY_CODE: ReadonlyMap<string, RadioClave> = new Map(RADIO_CLAVES.map((c) => [c.code, c]));

export function claveByCode(code: string): RadioClave | null {
  return BY_CODE.get(code) ?? null;
}

/**
 * Clave candidata: 2 o 3 números separados por guion, sin pegarse a letras ni a
 * otros números (así "B-3" o "RX-15" no cuentan y "10-0-2" gana a "10-0").
 */
const CANDIDATE_RE = /(?<![\w-])\d{1,2}-\d{1,2}(?:-\d{1,2})?(?![\w-])/g;

export interface ClaveHit {
  clave: RadioClave;
  start: number;
  end: number;
}

/** Claves del libro que aparecen en el texto, en orden. Las desconocidas no se devuelven. */
export function findClaves(text: string): ClaveHit[] {
  const out: ClaveHit[] = [];
  const unified = text.replace(/[‐-―−]/g, "-");
  for (const m of unified.matchAll(CANDIDATE_RE)) {
    const clave = BY_CODE.get(m[0]);
    if (clave) out.push({ clave, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/**
 * Agrega el significado tras cada clave conocida: «6-7» → «6-7 (Situación controlada)».
 * El motor de reglas lee el texto expandido, así una clave cuenta igual que la frase en claro.
 */
export function expandClaves(text: string): string {
  const hits = findClaves(text);
  if (hits.length === 0) return text;
  let out = "";
  let last = 0;
  for (const h of hits) {
    out += `${text.slice(last, h.end)} (${h.clave.meaning})`;
    last = h.end;
  }
  return out + text.slice(last);
}

/** Bloque de texto para los prompts de sistema. */
export const CLAVES_TEXT: string = [
  `CLAVES RADIALES — ${CLAVES_SOURCE}. Libro de claves vigente de este Cuerpo: interprétalas con certainty=high usando exactamente este significado. Una clave que no esté aquí sigue siendo no verificada (certainty=low).`,
  ...GROUPS.map((g) => `${g.prefix ?? g.group}: ${g.claves.map(([code, meaning]) => `${code} ${meaning}`).join(" · ")}`),
].join("\n");
