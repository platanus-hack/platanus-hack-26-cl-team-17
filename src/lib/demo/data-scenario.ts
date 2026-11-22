/**
 * Guion del simulacro en vivo: incendio en un edificio de departamentos de 4 pisos
 * en Avenida Independencia (comuna de Independencia, Santiago).
 *
 * Todo es ficticio. Geometría local (ENU, metros) con origen en el edificio:
 * la fachada principal (lado Alfa) mira al poniente, hacia la avenida; el edificio
 * vecino de 3 pisos queda al norte (lado Bravo) y una casa de un piso al sur (lado Delta).
 * Departamento con fuego: 3er piso, sector central de la fachada. Persona en balcón:
 * 3er piso, extremo sur de la fachada. El humo deriva hacia el nororiente. El fuego
 * sube por la fachada al 4º piso y de ahí al entretecho, que el dron ve recién en el paso 4.
 */
import type { MediaAnalysis } from "@/lib/domain";
import type { PosterSpec, ScenarioMediaSpec, ScenarioScript } from "./types";

const STREET = "Av. Independencia";

/** Póster base del edificio; cada fotograma ajusta lo que cambia. */
function building(over: Partial<PosterSpec> & Pick<PosterSpec, "view" | "caption" | "clock" | "variant">): PosterSpec {
  return {
    scene: "structure",
    floors: 4,
    building: "apartment",
    street: STREET,
    ...over,
  };
}

/* ───────────── M1 · vecino en la vereda de enfrente ───────────── */

const M1_CAPTION = "M1 · Vecino · vereda de enfrente";

const M1_ANALYSIS: MediaAnalysis = {
  usable: true,
  unusable_reason: "",
  incident_type: "structure_fire",
  summary:
    "Edificio de departamentos de 4 pisos con humo negro y denso saliendo a presión por dos ventanas del 3er piso, sector central de la fachada. En los últimos segundos se ve resplandor y llamas intermitentes tras una de esas ventanas. No se observan personas en ventanas ni balcones en el material disponible; esto no descarta víctimas.",
  viewpoint: {
    position_description:
      "Vereda poniente de Av. Independencia, frente al acceso del edificio, a nivel de calle; mira al oriente.",
    facing: "E",
    distance_m: 30,
    elevation: "ground",
  },
  structure: {
    present: true,
    kind: "apartment_building",
    floors_visible: 4,
    construction: "concrete",
    exposures:
      "Al norte (lado Bravo), edificio de 3 pisos muy próximo, separado por un pasaje angosto; al sur (lado Delta), casa de un piso con local comercial. El humo se inclina hacia el norte.",
    description:
      "Bloque de hormigón armado de 4 pisos, techo de apariencia plana con alero de planchas metálicas, balcones en la fachada poniente en los pisos 2 a 4 y antejardín con reja baja. Acceso único visible al centro de la fachada.",
  },
  fire: {
    present: true,
    stage: "growth",
    flames_visible: true,
    locations: [
      {
        floor: 3,
        side: "front",
        description:
          "Departamento del sector central del 3er piso: humo a presión por dos ventanas; resplandor anaranjado y llamas intermitentes tras la ventana izquierda (fotogramas 1 y 2).",
      },
    ],
    smoke: {
      present: true,
      color: "black",
      volume: "heavy",
      description:
        "Humo negro, denso y turbulento que sale a presión y sube pegado a la fachada hacia los balcones del 4º piso; aumenta entre el primer y el último fotograma. Compatible con fuego en crecimiento y gases muy calientes en ese departamento; posible combustión súbita generalizada próxima en ese sector. De noche y con alumbrado público el color es poco confiable.",
    },
    spread_risk: "high",
  },
  people: [
    {
      status: "bystander",
      count: 6,
      location: "Vereda oriente, frente al acceso y junto a la reja del antejardín",
      floor: 1,
      frame_refs: [0, 1, 2],
      confidence: "high",
      description: "Vecinos mirando y grabando cerca del acceso; algunos salieron del edificio.",
    },
  ],
  vehicles: [],
  hazards: [
    {
      kind: "power_lines",
      description:
        "Tendido eléctrico aéreo sobre la vereda oriente, frente a la fachada, a la altura aproximada del 2º y 3er piso; puede interferir con el posicionamiento de escalas.",
      severity: "medium",
      frame_refs: [0, 2],
    },
    {
      kind: "crowd",
      description: "Vecinos aglomerados junto al acceso del edificio, en la zona donde trabajarían los carros.",
      severity: "low",
      frame_refs: [1, 2],
    },
  ],
  access: {
    description:
      "Acceso principal por Av. Independencia (fachada poniente), avenida ancha que permite posicionar carros frente al edificio. Antejardín con reja baja y una puerta de acceso al hall. No se ve otro acceso.",
    obstructions: [
      "Autos estacionados junto a la solera oriente, frente al edificio",
      "Tendido eléctrico aéreo sobre la vereda oriente",
      "Árboles en la vereda que pueden limitar la escala",
    ],
    water_sources: [
      "Grifo en la vereda oriente, al sur del acceso, junto a un poste (no se puede verificar su operatividad)",
    ],
  },
  key_frames: [
    { frame: 0, caption: "Primer cuadro: humo negro a presión por dos ventanas del 3er piso, sector central." },
    { frame: 2, caption: "Llamas intermitentes tras la ventana izquierda del 3er piso; el humo ya alcanza los balcones del 4º." },
  ],
  visible_text: ["Numeración «1350» sobre la puerta de acceso", "Letrero de calle «Av. Independencia»"],
  uncertainties: [
    "No se observan personas en ventanas ni balcones en el material disponible. Esto no descarta víctimas.",
    "No se ven los costados norte ni posterior, ni la techumbre.",
    "No se puede determinar si la escalera interior está con humo.",
    "No se observa si el edificio tiene red seca.",
    "El color del humo puede estar alterado por la iluminación nocturna.",
  ],
  confidence: "high",
};

const M1: ScenarioMediaSpec = {
  source: "demo",
  kind: "video",
  camera: { x: -30, y: 3 },
  accuracy_m: 8,
  heading_deg: 90,
  duration_s: 18,
  captured_ago_s: 40,
  reporter_note: "Estoy al frente, sale mucho humo negro del tercer piso. Los vecinos están bajando.",
  frames: [
    {
      t_s: 1,
      poster: building({
        view: "front",
        caption: M1_CAPTION,
        clock: "20:41:12",
        smoke: { color: "black", volume: "moderate", position: "center" },
        exposures: { left: true, right: true },
        extras: ["power_lines", "crowd"],
        variant: 1,
      }),
    },
    {
      t_s: 8,
      poster: building({
        view: "front",
        caption: M1_CAPTION,
        clock: "20:41:19",
        fire: { floor: 3, position: "center", intensity: "light" },
        smoke: { color: "black", volume: "heavy", position: "center" },
        exposures: { left: true, right: true },
        extras: ["crowd"],
        variant: 2,
      }),
    },
    {
      t_s: 15,
      poster: building({
        view: "front",
        caption: M1_CAPTION,
        clock: "20:41:26",
        fire: { floor: 3, position: "center", intensity: "moderate" },
        smoke: { color: "black", volume: "heavy", position: "center" },
        exposures: { left: true, right: true },
        extras: ["power_lines", "crowd", "hydrant"],
        variant: 3,
      }),
    },
  ],
  analysis: M1_ANALYSIS,
};

/* ───────────── M2 · vecina en diagonal, persona en balcón ───────────── */

const M2_CAPTION = "M2 · Vecina · vereda de enfrente, en diagonal";

const M2_ANALYSIS: MediaAnalysis = {
  usable: true,
  unusable_reason: "",
  incident_type: "structure_fire",
  summary:
    "Mismo edificio visto en diagonal desde el surponiente. Llamas salen por la ventana del departamento central del 3er piso. Desde el segundo fotograma, una persona sale al balcón del extremo sur del 3er piso y agita un paño pidiendo ayuda, con humo pasando sobre ella.",
  viewpoint: {
    position_description:
      "Vereda poniente de Av. Independencia, al surponiente del edificio, a nivel de calle; ve la fachada en diagonal y parte del costado sur.",
    facing: "NE",
    distance_m: 34,
    elevation: "ground",
  },
  structure: {
    present: true,
    kind: "apartment_building",
    floors_visible: 4,
    construction: "concrete",
    exposures:
      "Edificio de 3 pisos al norte, muy próximo, hacia donde deriva el humo; casa de un piso al sur.",
    description:
      "Bloque de hormigón de 4 pisos con balcones de baranda metálica en la fachada poniente. El balcón del extremo sur del 3er piso es contiguo al departamento con fuego.",
  },
  fire: {
    present: true,
    stage: "fully_developed",
    flames_visible: true,
    locations: [
      {
        floor: 3,
        side: "front",
        description:
          "Llamas saliendo por la ventana del departamento central del 3er piso y lamiendo la fachada hacia el 4º piso; compatible con fuego autoventilado y desarrollado en ese recinto, con riesgo de extensión vertical.",
      },
    ],
    smoke: {
      present: true,
      color: "black",
      volume: "heavy",
      description:
        "Humo negro, denso y turbulento que sube por la fachada y cubre los balcones del 4º piso; parte del humo pasa por delante del balcón sur del 3er piso.",
    },
    spread_risk: "high",
  },
  people: [
    {
      status: "at_window_or_balcony",
      count: 1,
      location: "Balcón del extremo sur del 3er piso, fachada poniente, junto al departamento con fuego",
      floor: 3,
      frame_refs: [1, 2],
      confidence: "high",
      description:
        "Una persona, aparentemente adulta, agita un paño claro hacia la calle; el humo pasa por sobre el balcón. No se ve si hay más personas dentro de ese departamento.",
    },
    {
      status: "bystander",
      count: 4,
      location: "Vereda oriente, frente al edificio",
      floor: 1,
      frame_refs: [0, 2],
      confidence: "medium",
      description: "Vecinos en la vereda haciendo señas hacia el balcón.",
    },
  ],
  vehicles: [],
  hazards: [
    {
      kind: "power_lines",
      description: "Tendido eléctrico aéreo frente a la fachada, entre la calle y el balcón donde está la persona.",
      severity: "medium",
      frame_refs: [1, 2],
    },
  ],
  access: {
    description:
      "El balcón sur del 3er piso da a la avenida y queda al alcance de una escala desde las pistas del costado oriente, sujeto al tendido eléctrico y a los árboles de la vereda.",
    obstructions: ["Tendido eléctrico aéreo frente al balcón", "Árbol de la vereda al sur del acceso"],
    water_sources: [],
  },
  key_frames: [
    { frame: 1, caption: "Persona sale al balcón sur del 3er piso y agita un paño." },
    { frame: 2, caption: "Persona sigue en el balcón con humo pasando sobre ella; llamas en la ventana contigua." },
  ],
  visible_text: [],
  uncertainties: [
    "No se puede determinar si hay más personas en ese departamento, en el departamento con fuego ni en el 4º piso.",
    "No se ve el interior ni el estado de la escalera común.",
    "No se ve la techumbre ni el costado norte.",
    "La persona está a contraluz y parcialmente cubierta por el humo; no se puede evaluar su condición.",
  ],
  confidence: "high",
};

const M2: ScenarioMediaSpec = {
  source: "demo",
  kind: "video",
  camera: { x: -26, y: -22 },
  accuracy_m: 10,
  heading_deg: 50,
  duration_s: 20,
  captured_ago_s: 25,
  reporter_note: "Hay alguien en el balcón del tercero haciendo señas, el humo le pasa encima.",
  frames: [
    {
      t_s: 2,
      poster: building({
        view: "corner",
        caption: M2_CAPTION,
        clock: "20:44:05",
        fire: { floor: 3, position: "center", intensity: "moderate" },
        smoke: { color: "black", volume: "heavy", position: "center" },
        exposures: { left: true, right: true },
        extras: ["crowd"],
        variant: 4,
      }),
    },
    {
      t_s: 9,
      poster: building({
        view: "corner",
        caption: M2_CAPTION,
        clock: "20:44:12",
        fire: { floor: 3, position: "center", intensity: "moderate" },
        smoke: { color: "black", volume: "heavy", position: "center" },
        person: { floor: 3, position: "right", balcony: true },
        exposures: { left: true, right: true },
        extras: ["power_lines"],
        variant: 5,
      }),
    },
    {
      t_s: 16,
      poster: building({
        view: "corner",
        caption: M2_CAPTION,
        clock: "20:44:19",
        fire: { floor: 3, position: "center", intensity: "heavy" },
        smoke: { color: "black", volume: "heavy", position: "right" },
        person: { floor: 3, position: "right", balcony: true },
        exposures: { left: true, right: true },
        extras: ["power_lines", "crowd"],
        variant: 6,
      }),
    },
  ],
  analysis: M2_ANALYSIS,
};

/* ───────────── M3 · lote del dron en órbita de 50 m ───────────── */

/** Primer cuadro en el rumbo 230° (surponiente) a 50 m del edificio; los siguientes avanzan hacia el norponiente. */
const DRONE_START = { x: -38.3, y: -32.1 };
const M3_CAPTION = "M3 · Dron D1 · órbita 50 m";

const M3_ANALYSIS: MediaAnalysis = {
  usable: true,
  unusable_reason: "",
  incident_type: "structure_fire",
  summary:
    "Vista aérea del edificio de 4 pisos desde el surponiente hasta el norponiente. Llamas intermitentes en la ventana del 4º piso sobre el departamento afectado y humo a presión entre planchas deformadas de la techumbre del sector central, compatible con extensión vertical al 4º piso y al entretecho; en el 3er piso se ve vapor blanco y menos llama. El humo deriva hacia el nororiente, sobre el edificio vecino de 3 pisos.",
  viewpoint: {
    position_description:
      "Dron en órbita de 50 m a 40 m de altura; los cuadros recorren desde el surponiente (rumbo 230°) hasta el norponiente (rumbo 330°), siempre mirando al edificio.",
    facing: "NE",
    distance_m: 50,
    elevation: "aerial",
  },
  structure: {
    present: true,
    kind: "apartment_building",
    floors_visible: 4,
    construction: "concrete",
    exposures:
      "Edificio de 3 pisos al costado norte (lado Bravo), separado por un pasaje angosto; su techumbre queda bajo la columna de humo. Casa de un piso al sur, fuera de la deriva del humo en estos cuadros.",
    description:
      "Bloque de hormigón con techumbre de planchas metálicas sobre estructura liviana, apoyada en la losa del 4º piso. El sector central de la techumbre, sobre el departamento afectado, muestra planchas deformadas y oscurecidas.",
  },
  fire: {
    present: true,
    stage: "fully_developed",
    flames_visible: true,
    locations: [
      {
        floor: 3,
        side: "front",
        description:
          "Departamento central del 3er piso: menos llama visible que en M1 y M2 y vapor blanco en la ventana (fotograma 0), compatible con agua aplicada desde el interior.",
      },
      {
        floor: 4,
        side: "front",
        description:
          "Ventana del 4º piso justo sobre el departamento afectado: llamas intermitentes (fotogramas 1 y 2), compatible con extensión vertical por la fachada.",
      },
      {
        floor: 4,
        side: "roof",
        description:
          "Techumbre sobre el sector central: humo a presión entre planchas deformadas y oscurecidas (fotogramas 1 a 3), compatible con fuego o gases calientes en el entretecho.",
      },
    ],
    smoke: {
      present: true,
      color: "gray",
      volume: "heavy",
      description:
        "Columna gris oscura, densa y a presión que sale entre las planchas de la techumbre, y vapor blanco en las ventanas del 3er piso. El vapor es compatible con agua aplicada abajo; la presión en la techumbre indica calor que sigue arriba. El viento inclina la columna hacia el nororiente, sobre el edificio vecino.",
    },
    spread_risk: "high",
  },
  people: [
    {
      status: "responder",
      count: 2,
      location: "Escala de la mecánica apoyada en el balcón sur del 3er piso",
      floor: 3,
      frame_refs: [0],
      confidence: "medium",
      description: "Dos bomberos en la parte alta de la escala, a la altura del balcón sur del 3er piso.",
    },
  ],
  vehicles: [],
  hazards: [
    {
      kind: "collapse_risk",
      description:
        "Planchas deformadas y estructura liviana de techumbre expuesta al fuego en el sector central; puede fallar sin aviso visible. Afecta a quien trabaje sobre la techumbre o en el entretecho.",
      severity: "high",
      frame_refs: [1, 2, 3],
    },
    {
      kind: "power_lines",
      description: "Tendido eléctrico de la avenida cerca de la escala posicionada frente al balcón sur.",
      severity: "medium",
      frame_refs: [0, 2],
    },
  ],
  access: {
    description:
      "Un carro bomba y la mecánica posicionados en las pistas del costado oriente de Av. Independencia, frente a la fachada, con la escala hacia el balcón sur del 3er piso. El pasaje entre el edificio y el vecino del norte es angosto; no se ve acceso por la parte posterior.",
    obstructions: ["Pasaje angosto entre el edificio y el vecino del norte", "Tendido eléctrico aéreo sobre la vereda oriente"],
    water_sources: ["Grifo en la vereda oriente al sur del acceso, con una manguera conectada"],
  },
  key_frames: [
    { frame: 0, caption: "Escala de la mecánica en el balcón sur del 3er piso; vapor en la ventana del departamento afectado." },
    { frame: 1, caption: "Llamas en la ventana del 4º piso y planchas deformadas en la techumbre sobre el departamento afectado." },
    { frame: 3, caption: "La columna de humo cae sobre la techumbre del edificio vecino del norte." },
  ],
  visible_text: [],
  uncertainties: [
    "Desde esta altura el balcón sur del 3er piso queda tapado en parte por la losa del balcón del 4º piso y por el humo; no se puede determinar si la persona sigue en él.",
    "No se ve el interior del 4º piso: no se puede determinar cuántos departamentos de ese piso están comprometidos.",
    "No se observan llamas en el edificio vecino del norte en el material disponible; eso no descarta extensión por su techumbre o entretecho.",
    "No se ve la parte posterior del edificio con detalle.",
    "No se observan otras personas en ventanas o balcones en el material disponible. Esto no descarta víctimas.",
  ],
  confidence: "medium",
};

const M3: ScenarioMediaSpec = {
  source: "drone",
  kind: "frames",
  camera: DRONE_START,
  accuracy_m: 3,
  heading_deg: 50,
  duration_s: null,
  captured_ago_s: 10,
  reporter_note: "Cuadros del dron D1 en órbita sobre el edificio (simulado).",
  drone_alt_m: 40,
  frames: [
    {
      t_s: 0,
      poster: building({
        view: "aerial",
        caption: `${M3_CAPTION} · surponiente`,
        clock: "20:52:10",
        fire: { floor: 3, position: "center", intensity: "light" },
        smoke: { color: "gray", volume: "heavy", position: "center" },
        exposures: { left: true, right: true },
        extras: ["fire_engine", "power_lines"],
        variant: 7,
      }),
    },
    {
      t_s: 5,
      poster: building({
        view: "aerial",
        caption: `${M3_CAPTION} · poniente`,
        clock: "20:52:15",
        fire: { floor: 4, position: "center", intensity: "moderate" },
        smoke: { color: "gray", volume: "heavy", position: "center" },
        exposures: { left: true, right: true },
        extras: ["roof_damage", "fire_engine"],
        variant: 8,
      }),
    },
    {
      t_s: 10,
      poster: building({
        view: "aerial",
        caption: `${M3_CAPTION} · poniente`,
        clock: "20:52:20",
        fire: { floor: 4, position: "center", intensity: "light" },
        smoke: { color: "gray", volume: "heavy", position: "center" },
        exposures: { left: true, right: false },
        extras: ["roof_damage", "fire_engine", "power_lines", "hydrant"],
        variant: 9,
      }),
    },
    {
      t_s: 15,
      poster: building({
        view: "aerial",
        caption: `${M3_CAPTION} · norponiente`,
        clock: "20:52:25",
        smoke: { color: "gray", volume: "heavy", position: "left" },
        exposures: { left: true, right: false },
        extras: ["roof_damage"],
        variant: 10,
      }),
    },
    {
      t_s: 20,
      poster: building({
        view: "aerial",
        caption: `${M3_CAPTION} · norponiente`,
        clock: "20:52:30",
        smoke: { color: "gray", volume: "moderate", position: "left" },
        exposures: { left: true, right: false },
        extras: ["roof_damage", "fire_engine"],
        variant: 11,
      }),
    },
  ],
  analysis: M3_ANALYSIS,
};

/* ───────────── Guion ───────────── */

export const SCENARIO: ScenarioScript = {
  incident: {
    type: "structure_fire",
    title: "Simulacro — Incendio en edificio de departamentos, Av. Independencia 1350",
    address: "Avenida Independencia 1350, Independencia, Región Metropolitana",
    lat: -33.4187,
    lng: -70.6559,
    description:
      "Simulacro guiado con datos ficticios: fuego en un departamento del 3er piso de un edificio de 4 pisos. Ningún video, análisis ni comunicación de este incidente es real.",
  },
  // Guion corto para acompañar el pitch (≈35 s): solo los momentos en que Vigía cambia algo.
  // El dron despega con la alarma para llegar a su órbita justo cuando se piden sus cuadros.
  steps: [
    {
      label: "Alarma: humo en un 3er piso — despega el dron D1",
      wait_s: 4,
      mission: { pattern: "orbit", radius_m: 50, altitude_m: 40, speed_ms: 15 },
      events: [
        {
          kind: "comms",
          severity: "notice",
          title: "Alarma recibida — llamados de vecinos",
          detail:
            "La Central recibe llamados por humo en un departamento del 3er piso en Avenida Independencia 1350. Simulacro: datos ficticios.",
        },
      ],
      comms: [
        {
          channel: "Canal 1",
          speaker: "Central",
          text: "Central a B-3 y Q-8, concurran a incendio en edificio de departamentos, Avenida Independencia 1350. Humo negro por ventanas del tercer piso. Dron D1 despegando hacia el lugar.",
        },
      ],
    },
    {
      label: "Vigía analiza el video de un vecino",
      wait_s: 5,
      media: M1,
    },
    {
      label: "Vigía detecta una persona en el balcón del 3er piso",
      wait_s: 6,
      media: M2,
    },
    {
      label: "Central avisa a B-3 antes de que llegue",
      wait_s: 4,
      comms: [
        {
          channel: "Canal 1",
          speaker: "Central",
          text: "Central a B-3, video de una vecina muestra una persona en el balcón del tercer piso, costado sur, haciendo señas.",
        },
        {
          channel: "Canal 1",
          speaker: "B-3",
          text: "B-3 conforme. Q-8, prepare la mecánica para rescate por ese balcón.",
        },
      ],
    },
    {
      label: "Dron: el fuego sube al 4º piso y a la techumbre",
      wait_s: 6,
      drone_media: M3,
    },
    {
      label: "Rescate en el balcón; nadie sube al techo",
      wait_s: 5,
      comms: [
        {
          channel: "Canal 1",
          speaker: "Q-8",
          text: "Q-8 a B-3, persona rescatada desde el balcón del tercer piso con la mecánica. Consciente, con inhalación de humo, a cargo de SAMU.",
        },
        {
          channel: "Canal 1",
          speaker: "B-3",
          text: "B-3 a todas las unidades, el dron muestra llamas en el cuarto piso y humo a presión por la techumbre. Línea al cuarto piso, nadie sube al techo: la estructura está comprometida.",
        },
      ],
      events: [
        {
          kind: "comms",
          severity: "notice",
          title: "Persona rescatada desde el balcón del 3er piso",
          detail:
            "Q-8 informa el rescate con la mecánica; la paciente queda a cargo de SAMU. La búsqueda en el resto del edificio sigue pendiente.",
        },
      ],
    },
    {
      label: "Fuego controlado — la búsqueda sigue abierta",
      wait_s: 3,
      status: "controlled",
      comms: [
        {
          channel: "Canal 1",
          speaker: "B-3",
          text: "B-3 a Central, fuego controlado en tercer y cuarto piso y en la techumbre. Seguimos con la búsqueda en los pisos tres y cuatro; no ha terminado.",
        },
      ],
      events: [
        {
          kind: "incident_updated",
          severity: "notice",
          title: "Fuego controlado — búsqueda en curso",
          detail:
            "B-3 informa fuego controlado. La búsqueda en los pisos 3 y 4 no ha terminado: ninguna unidad ha informado el edificio revisado por completo.",
        },
      ],
    },
  ],
};
