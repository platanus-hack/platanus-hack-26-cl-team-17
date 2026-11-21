/**
 * Vitrina B: colisión múltiple en Av. Departamental con Av. Macul (Macul).
 * Incidente ficticio con datos de demostración; nada de esto es real.
 *
 * Escena ENU con origen en el auto volcado (V1):
 *  - Calzada sur de Departamental (hacia el oriente): eje y = 0, 10,5 m de ancho.
 *  - Bandejón central de 3 m; calzada norte (hacia el poniente): eje y = 13,5.
 *  - Av. Macul cruza de norte a sur en x = -35 (14 m de ancho).
 *  - M2 se grabó desde un balcón del 4º piso del edificio de la esquina nororiente.
 *
 * Cronología (s desde el llamado, 20:40:15): despacho C1 32 s → video M1 (70–92 s,
 * analizado 141 s) → Central retransmite el video C3 152 s → M2 (180–216 s, analizado
 * 262 s) → B-4 llega y confirma el atrapado C5 305 s → RX-15 en el lugar C6 338 s.
 * El atrapamiento pasa de "probable" (M1) a "confirmed" solo con C5.
 */
import type { ShowcaseSpec } from "./types";

const STREET = "Av. Departamental";

export const SHOWCASE_B: ShowcaseSpec = {
  title: "Colisión múltiple — Av. Departamental con Av. Macul, Macul",
  type: "vehicle_collision",
  address: "Av. Departamental con Av. Macul, Macul, Región Metropolitana",
  // Calzada sur de Av. Departamental, ~35 m al oriente del cruce con Av. Macul (según OSM).
  lat: -33.51022,
  lng: -70.58805,
  description:
    "Colisión de tres vehículos en la calzada sur de Av. Departamental, al oriente de Av. Macul. Auto volcado con un ocupante atrapado, derrame de combustible bajo los vehículos, un auto posiblemente eléctrico y tránsito detenido.",
  status: "active",
  started_min_ago: 7,
  mission: null,

  /* ───────────── Medios ───────────── */
  media: [
    // M1: vecino en la vereda sur, a pocos metros del auto volcado.
    {
      source: "demo",
      kind: "video",
      camera: { x: 8, y: -7.5 },
      accuracy_m: 8,
      heading_deg: 310,
      duration_s: 22,
      captured_at_s: 70,
      received_at_s: 118,
      analyzed_at_s: 141,
      reporter_note:
        "Grabé desde la vereda. El auto que quedó dado vuelta tiene a alguien adentro que no puede salir. Hay algo derramado en el suelo.",
      frames: [
        {
          t_s: 2,
          poster: {
            scene: "collision",
            view: "side",
            caption: "M1 · Vecino · vereda sur de Departamental",
            clock: "20:41:27",
            vehicles: [
              { kind: "car", state: "upright", x: 0.18, tag: "V3" },
              { kind: "suv_pickup", state: "upright", x: 0.4, tag: "V2 · daño frontal" },
              { kind: "car", state: "overturned", x: 0.7, tag: "V1 · volcado" },
            ],
            extras: ["fuel_spill", "crowd", "traffic_queue"],
            street: STREET,
            variant: 1,
          },
        },
        {
          t_s: 9,
          poster: {
            scene: "collision",
            view: "front",
            caption: "M1 · Vecino · vereda sur de Departamental",
            clock: "20:41:34",
            vehicles: [{ kind: "car", state: "overturned", x: 0.52, tag: "V1 · ocupante dentro" }],
            extras: ["crowd", "fuel_spill"],
            street: STREET,
            variant: 2,
          },
        },
        {
          t_s: 17,
          poster: {
            scene: "collision",
            view: "side",
            caption: "M1 · Vecino · vereda sur de Departamental",
            clock: "20:41:42",
            vehicles: [
              { kind: "car", state: "upright", x: 0.24, tag: "V3 · daño frontal" },
              { kind: "suv_pickup", state: "upright", x: 0.56, tag: "V2 · derrame" },
            ],
            extras: ["fuel_spill", "traffic_queue"],
            street: STREET,
            variant: 3,
          },
        },
      ],
      analysis: {
        usable: true,
        unusable_reason: "",
        incident_type: "vehicle_collision",
        summary:
          "Colisión de tres vehículos en la calzada sur de una avenida, de noche. Un auto (V1) está volcado sobre el techo, con el techo hundido y una persona dentro que no sale; una camioneta (V2) tiene el frente destruido y bajo ella escurre un líquido hacia V1. Un tercer auto (V3) quedó detenido contra la zaga de V2.",
        viewpoint: {
          position_description:
            "Vereda sur de Av. Departamental, frente a los vehículos, a pocos metros del auto volcado; cámara a la altura de la mano.",
          facing: "NW",
          distance_m: 8,
          elevation: "ground",
        },
        structure: {
          present: false,
          kind: "unknown",
          floors_visible: 0,
          construction: "unknown",
          exposures: "",
          description:
            "No hay edificaciones involucradas. Al fondo se ven locales comerciales cerrados en la vereda norte.",
        },
        fire: {
          present: false,
          stage: "none",
          flames_visible: false,
          locations: [],
          smoke: {
            present: false,
            color: "none",
            volume: "none",
            description:
              "No se observa humo ni vapor en los cuadros. La iluminación nocturna y los focos de los autos dificultan ver vapor tenue.",
          },
          spread_risk: "unknown",
        },
        people: [
          {
            status: "trapped",
            count: 1,
            location: "Habitáculo de V1, lado del conductor, cabeza hacia el pavimento",
            floor: 0,
            frame_refs: [1],
            confidence: "medium",
            description:
              "Se ve una persona dentro de V1 que mueve un brazo pero no sale; la abertura de la ventana del conductor quedó reducida por el techo hundido. En el audio un vecino dice: \"está atrapado, no puede salir\". Compatible con atrapamiento; solo se confirma con acceso al paciente.",
          },
          {
            status: "injured",
            count: 1,
            location: "Junto a la puerta del conductor de V2, sobre la calzada",
            floor: 0,
            frame_refs: [2],
            confidence: "medium",
            description:
              "Persona de pie que se sujeta el brazo izquierdo junto a V2; compatible con su conductor, lesionado.",
          },
          {
            status: "unknown",
            count: 1,
            location: "Junto a la puerta del conductor de V3",
            floor: 0,
            frame_refs: [2],
            confidence: "low",
            description:
              "Persona de pie junto a V3, compatible con su conductor. No se puede apreciar si está lesionada ni si quedan otros ocupantes dentro de V3.",
          },
          {
            status: "bystander",
            count: 6,
            location: "Vereda sur y borde de la calzada, junto a V1",
            floor: 0,
            frame_refs: [0, 1],
            confidence: "high",
            description:
              "Grupo de curiosos; dos de ellos agachados junto a la ventana del conductor de V1, dentro de la zona del derrame.",
          },
        ],
        vehicles: [
          {
            kind: "car",
            state: "overturned",
            damage: "severe",
            occupants_visible: "yes",
            entrapment_suspected: true,
            leaking_fluids: true,
            position:
              "V1: pista central de la calzada sur, volcado sobre el techo, con el frente hacia el sureste.",
            description:
              "Techo hundido sobre el habitáculo y pilares delanteros deformados; parabrisas reventado. Un ocupante visible en el lado del conductor. La parte trasera del habitáculo no se ve desde este ángulo.",
            frame_refs: [0, 1],
          },
          {
            kind: "suv_pickup",
            state: "upright",
            damage: "severe",
            occupants_visible: "no",
            entrapment_suspected: false,
            leaking_fluids: true,
            position:
              "V2: calzada sur, al poniente de V1, sobre sus ruedas, cruzada en diagonal hacia el nororiente.",
            description:
              "Camioneta con el frente destruido (capó levantado, parachoques desprendido). Desde el frente escurre un líquido que avanza por el pavimento hacia V1.",
            frame_refs: [0, 2],
          },
          {
            kind: "car",
            state: "upright",
            damage: "moderate",
            occupants_visible: "unknown",
            entrapment_suspected: false,
            leaking_fluids: false,
            position: "V3: calzada sur, detrás de V2, con el frente contra la zaga de V2.",
            description:
              "Auto con daño frontal moderado tras impactar la zaga de V2; queda parcialmente tapado por V2. Con este ángulo y esta luz no se distingue su tipo de propulsión. No se observa fuga bajo V3 en estos cuadros.",
            frame_refs: [0, 2],
          },
        ],
        hazards: [
          {
            kind: "fuel_spill",
            description:
              "Líquido que escurre desde el frente de V2 y bajo V1 y se extiende por la calzada; posible combustible, no se puede identificar en video.",
            severity: "high",
            frame_refs: [0, 2],
          },
          {
            kind: "other",
            description:
              "V1 descansa sobre el techo hundido: posición inestable mientras no se estabilice. Dos curiosos se apoyan en la carrocería.",
            severity: "high",
            frame_refs: [1],
          },
          {
            kind: "crowd",
            description: "Curiosos junto a V1 y sobre la calzada, dentro de la zona del derrame.",
            severity: "medium",
            frame_refs: [0, 1],
          },
          {
            kind: "traffic",
            description:
              "Fila de autos detenidos detrás de V3; al fondo, la calzada norte sigue con tránsito a baja velocidad.",
            severity: "medium",
            frame_refs: [0, 2],
          },
        ],
        access: {
          description:
            "Avenida de dos calzadas con bandejón central. Los tres vehículos ocupan la calzada sur; hacia el poniente hay autos detenidos en todas las pistas.",
          obstructions: [
            "Fila de autos detenidos en la calzada sur, detrás de V3",
            "Curiosos sobre la calzada junto a V1",
          ],
          water_sources: [],
        },
        key_frames: [
          {
            frame: 1,
            caption:
              "V1 volcado con el techo hundido y un ocupante dentro que no sale: indicio fuerte de atrapamiento.",
          },
          {
            frame: 2,
            caption: "Derrame desde el frente de V2 hacia V1 y persona lesionada junto a V2.",
          },
          {
            frame: 0,
            caption: "Vista general de los tres vehículos en la calzada sur y la fila de autos detenidos.",
          },
        ],
        visible_text: ["Av. Departamental (letrero de calle en el poste de la vereda sur)"],
        uncertainties: [
          "La parte trasera del habitáculo de V1 no se ve: no se puede descartar un segundo ocupante.",
          "No se puede identificar el líquido derramado ni cuánto sigue escurriendo.",
          "El tipo de propulsión de V3 no se distingue en este video.",
          "No se sabe si V1 tiene airbags sin desplegar.",
          "La luz nocturna y los focos de los autos alteran colores y ocultan vapor tenue.",
          "No se observan peatones lesionados en el material disponible; esto no los descarta.",
        ],
        confidence: "medium",
      },
    },

    // M2: vecina en el balcón del 4º piso del edificio de la esquina nororiente.
    {
      source: "demo",
      kind: "video",
      camera: { x: -2, y: 23.6 },
      accuracy_m: 12,
      heading_deg: 175,
      duration_s: 36,
      captured_at_s: 180,
      received_at_s: 236,
      analyzed_at_s: 262,
      reporter_note:
        "Desde mi balcón se ve todo el choque. Uno de los autos dice EV atrás. La fila de autos llega hasta Macul.",
      frames: [
        {
          t_s: 4,
          poster: {
            scene: "collision",
            view: "aerial",
            caption: "M2 · Vecina · balcón 4º piso, esquina nororiente",
            clock: "20:43:19",
            vehicles: [
              { kind: "car", state: "upright", x: 0.26, tag: "V3" },
              { kind: "suv_pickup", state: "upright", x: 0.42, tag: "V2" },
              { kind: "car", state: "overturned", x: 0.66, tag: "V1 · volcado" },
            ],
            extras: ["fuel_spill", "traffic_queue", "crowd"],
            street: STREET,
            variant: 4,
          },
        },
        {
          t_s: 15,
          poster: {
            scene: "collision",
            view: "corner",
            caption: "M2 · Vecina · balcón 4º piso, esquina nororiente",
            clock: "20:43:30",
            vehicles: [
              { kind: "car", state: "upright", x: 0.5, tag: "V3 · rótulo \"EV\"" },
              { kind: "suv_pickup", state: "upright", x: 0.8, tag: "V2" },
            ],
            extras: ["traffic_queue"],
            street: STREET,
            variant: 5,
          },
        },
        {
          t_s: 31,
          poster: {
            scene: "collision",
            view: "aerial",
            caption: "M2 · Vecina · balcón 4º piso, esquina nororiente",
            clock: "20:43:46",
            vehicles: [
              { kind: "suv_pickup", state: "upright", x: 0.3, tag: "V2" },
              { kind: "car", state: "overturned", x: 0.52, tag: "V1" },
            ],
            extras: ["crowd", "hydrant", "traffic_queue", "fuel_spill"],
            street: STREET,
            variant: 6,
          },
        },
      ],
      analysis: {
        usable: true,
        unusable_reason: "",
        incident_type: "vehicle_collision",
        summary:
          "Vista elevada de la colisión: V1 volcado en la pista central de la calzada sur, V2 cruzada al poniente y V3 detenido contra su zaga. Una mancha de líquido cubre la calzada bajo V1 y V2. V3 muestra indicios de vehículo eléctrico: rótulo \"EV\" en la zaga y tapa compatible con puerto de carga.",
        viewpoint: {
          position_description:
            "Balcón del 4º piso del edificio de la esquina nororiente de Departamental con Macul, mirando hacia la calzada sur.",
          facing: "S",
          distance_m: 26,
          elevation: "elevated",
        },
        structure: {
          present: false,
          kind: "unknown",
          floors_visible: 0,
          construction: "unknown",
          exposures: "",
          description: "No hay edificaciones involucradas; el video se grabó desde un edificio residencial vecino.",
        },
        fire: {
          present: false,
          stage: "none",
          flames_visible: false,
          locations: [],
          smoke: {
            present: false,
            color: "none",
            volume: "none",
            description:
              "No se observa humo ni vapor bajo V3 ni en los otros vehículos durante el video. Esto no descarta daño en la batería de V3: el vapor tenue puede no verse de noche.",
          },
          spread_risk: "unknown",
        },
        people: [
          {
            status: "bystander",
            count: 10,
            location: "Vereda sur, frente a V1, y borde de la calzada",
            floor: 0,
            frame_refs: [0, 2],
            confidence: "high",
            description: "Curiosos agrupados frente a V1; dos siguen agachados junto al auto volcado.",
          },
          {
            status: "injured",
            count: 1,
            location: "Sentada en la solera sur, a la altura de V2",
            floor: 0,
            frame_refs: [0],
            confidence: "low",
            description:
              "Persona sentada en la solera sujetándose un brazo; compatible con el conductor de V2 visto en M1.",
          },
          {
            status: "unknown",
            count: 1,
            location: "De pie junto al costado izquierdo de V3",
            floor: 0,
            frame_refs: [1],
            confidence: "medium",
            description: "Persona junto a V3, compatible con su conductor; no se aprecia su estado.",
          },
        ],
        vehicles: [
          {
            kind: "car",
            state: "overturned",
            damage: "severe",
            occupants_visible: "unknown",
            entrapment_suspected: true,
            leaking_fluids: true,
            position: "V1: pista central de la calzada sur, sobre el techo, frente hacia el sureste.",
            description:
              "Techo aplastado contra el pavimento en todo el largo del habitáculo; desde la altura no se ve el interior.",
            frame_refs: [0, 2],
          },
          {
            kind: "suv_pickup",
            state: "upright",
            damage: "severe",
            occupants_visible: "no",
            entrapment_suspected: false,
            leaking_fluids: true,
            position: "V2: calzada sur, al poniente de V1, cruzada hacia el nororiente.",
            description: "Frente destruido; la mancha de líquido nace bajo su motor y llega hasta V1.",
            frame_refs: [0, 2],
          },
          {
            kind: "car",
            state: "upright",
            damage: "moderate",
            occupants_visible: "unknown",
            entrapment_suspected: false,
            leaking_fluids: false,
            position: "V3: calzada sur, detrás de V2, con el frente contra su zaga.",
            description:
              "Indicios de vehículo eléctrico: rótulo \"EV\" en la tapa del maletero, tapa entreabierta compatible con puerto de carga en el guardabarro delantero izquierdo y no se distingue tubo de escape bajo el parachoques trasero. En Chile no hay identificación estandarizada; no se puede confirmar desde el video.",
            frame_refs: [0, 1],
          },
        ],
        hazards: [
          {
            kind: "ev_battery",
            description:
              "V3 posiblemente eléctrico (rótulo \"EV\", posible puerto de carga, sin escape visible). Considerar riesgo eléctrico hasta descartarlo; un eléctrico encendido se mueve en silencio. No se observa vapor ni humo desde la parte baja.",
            severity: "medium",
            frame_refs: [1],
          },
          {
            kind: "fuel_spill",
            description:
              "Mancha de líquido que cubre la pista central bajo V2 y V1 y escurre hacia la solera sur; posible combustible, no identificable en video. No se ve que llegue a V3.",
            severity: "high",
            frame_refs: [0, 2],
          },
          {
            kind: "traffic",
            description:
              "La calzada norte sigue con tránsito lento junto al bandejón; en la calzada sur siguen entrando autos desde Av. Macul hasta la fila detenida.",
            severity: "medium",
            frame_refs: [2],
          },
          {
            kind: "crowd",
            description: "Unas diez personas en la vereda sur frente a V1, algunas sobre la calzada.",
            severity: "medium",
            frame_refs: [0, 2],
          },
        ],
        access: {
          description:
            "La calzada sur está cortada por los tres vehículos. Al oriente de V1 la calzada sur queda libre porque el tránsito está detenido al poniente. Bandejón central con solera entre ambas calzadas.",
          obstructions: [
            "Fila de autos detenidos en la calzada sur desde V3 hasta Av. Macul",
            "Curiosos en la vereda sur frente a V1",
            "Bandejón central entre calzadas",
          ],
          water_sources: [
            "Grifo en la vereda sur, al oriente del auto volcado (cuadro 2); no se puede verificar si está operativo.",
          ],
        },
        key_frames: [
          {
            frame: 1,
            caption: "Zaga de V3 con rótulo \"EV\" y posible puerto de carga: indicio de vehículo eléctrico.",
          },
          {
            frame: 0,
            caption: "Disposición de los tres vehículos y extensión de la mancha del derrame.",
          },
          {
            frame: 2,
            caption: "Curiosos, grifo en la vereda sur y tránsito que sigue pasando por la calzada norte.",
          },
        ],
        visible_text: [
          "\"EV\" en la tapa del maletero de V3",
          "Av. Departamental / Av. Macul (letrero del cruce)",
        ],
        uncertainties: [
          "Desde la altura no se ve el interior de V1: no se puede confirmar ni descartar ocupantes.",
          "No se puede confirmar que V3 sea eléctrico o híbrido, ni si está apagado.",
          "No se puede identificar el líquido derramado.",
          "Los ocupantes de V3 no son visibles.",
          "El video es de las 20:43; la escena puede haber cambiado desde entonces.",
        ],
        confidence: "medium",
      },
    },
  ],

  /* ───────────── Radio ───────────── */
  comms: [
    {
      at_s: 32,
      channel: "Canal 1",
      speaker: "Central",
      text: "Central a RX-15 y B-4: concurrir a Av. Departamental con Av. Macul, comuna de Macul, colisión de tres vehículos en la calzada sur, uno volcado. La informante dice que hay una persona dentro del auto volcado que no puede salir. Carabineros y SAMU en conocimiento.",
    },
    {
      at_s: 70,
      channel: "Canal 1",
      speaker: "RX-15",
      text: "RX-15 a Central, saliendo con cuatro voluntarios. ¿Tiene antecedentes de fuego o derrame en el lugar?",
    },
    {
      at_s: 152,
      channel: "Canal 1",
      speaker: "Central",
      text: "Central a RX-15 y B-4: llegó video de un vecino. Auto volcado sobre el techo, con el techo hundido y una persona adentro que no sale. Camioneta con daño frontal y líquido derramado bajo los vehículos. No se ve fuego.",
    },
    {
      at_s: 196,
      channel: "Canal 1",
      speaker: "Central",
      text: "Central a B-4 y RX-15: Carabineros informa que cortó la calzada sur de Departamental en Macul. SAMU despachó un móvil avanzado, todavía sin hora estimada. La calzada norte sigue con tránsito lento.",
    },
    {
      at_s: 305,
      channel: "Canal 1",
      speaker: "B-4",
      text: "B-4 a Central, en el lugar. Colisión de tres vehículos en la calzada sur de Departamental. Auto volcado sobre el techo con un ocupante atrapado, consciente, lado del conductor. Camioneta con daño frontal, el conductor está fuera con una lesión en el brazo. El tercer auto sería eléctrico, lo tratamos como energizado. Derrame de combustible bajo el volcado y la camioneta. Asumo el mando, puesto de mando en la vereda sur al oriente del volcado. Iniciamos estabilización y control del derrame.",
    },
    {
      at_s: 338,
      channel: "Canal 1",
      speaker: "RX-15",
      text: "RX-15 a Central, en el lugar. Nos ponemos a disposición del mando de B-4 para la extricación del auto volcado. Solicitamos hora estimada de SAMU.",
    },
    {
      at_s: 356,
      channel: "Canal 1",
      speaker: "Central",
      text: "Central a RX-15, SAMU indica móvil avanzado a cinco minutos. Carabineros pide que le avisen cuándo puede habilitar una pista.",
    },
  ],

  comms_analysis: {
    summary:
      "Colisión de tres vehículos con un ocupante atrapado y consciente en el auto volcado, confirmado por B-4 en el lugar. B-4 tiene el mando y RX-15 se suma a la extricación; SAMU está a cinco minutos y Carabineros cortó la calzada sur.",
    units: [
      {
        name: "B-4",
        status: "operating",
        last_report:
          "En el lugar y a cargo: un atrapado consciente en el volcado, tercer auto tratado como eléctrico, derrame bajo V1 y V2; inicia estabilización y control del derrame (C5).",
      },
      {
        name: "RX-15",
        status: "on_scene",
        last_report: "En el lugar, a disposición del mando para la extricación; pidió hora de SAMU (C6).",
      },
      {
        name: "SAMU",
        status: "en_route",
        last_report: "Móvil avanzado a cinco minutos según la Central (C7).",
      },
      {
        name: "Carabineros",
        status: "operating",
        last_report: "Cortó la calzada sur de Departamental en Macul (C4); pide aviso para habilitar una pista (C7).",
      },
    ],
    events: [
      {
        entry_seq: 1,
        kind: "dispatch",
        text: "Despacho de RX-15 y B-4 a colisión de tres vehículos con uno volcado; la informante reporta una persona que no puede salir.",
        priority: "important",
      },
      {
        entry_seq: 1,
        kind: "victim_report",
        text: "Informante: persona dentro del auto volcado que no puede salir.",
        priority: "critical",
      },
      {
        entry_seq: 3,
        kind: "victim_report",
        text: "La Central retransmite el video de un vecino: ocupante dentro del auto volcado con techo hundido; líquido derramado; sin fuego visible.",
        priority: "critical",
      },
      {
        entry_seq: 4,
        kind: "status_update",
        text: "Carabineros cortó la calzada sur en Macul; SAMU despachó un móvil avanzado; tránsito lento en la calzada norte.",
        priority: "important",
      },
      {
        entry_seq: 5,
        kind: "arrival",
        text: "B-4 llega al lugar y asume el mando; puesto de mando en la vereda sur al oriente del volcado.",
        priority: "important",
      },
      {
        entry_seq: 5,
        kind: "victim_report",
        text: "B-4 confirma un ocupante atrapado y consciente en el lado del conductor del auto volcado, y un conductor lesionado en un brazo.",
        priority: "critical",
      },
      {
        entry_seq: 5,
        kind: "hazard",
        text: "Tercer auto posiblemente eléctrico, tratado como energizado; derrame de combustible bajo el volcado y la camioneta.",
        priority: "important",
      },
      {
        entry_seq: 6,
        kind: "arrival",
        text: "RX-15 en el lugar, a disposición del mando para la extricación.",
        priority: "important",
      },
      {
        entry_seq: 6,
        kind: "resource_request",
        text: "RX-15 pide hora estimada de llegada de SAMU.",
        priority: "routine",
      },
      {
        entry_seq: 7,
        kind: "status_update",
        text: "SAMU a cinco minutos; Carabineros pide aviso para habilitar una pista.",
        priority: "routine",
      },
    ],
    victims: {
      status: "reported",
      detail:
        "Un ocupante atrapado y consciente en el auto volcado, confirmado por B-4 en el lugar (C5); ya lo habían reportado la informante (C1) y el video retransmitido por la Central (C3). Conductor de la camioneta con lesión en un brazo (C5). Nadie ha informado sobre los ocupantes del tercer auto.",
      entry_seqs: [1, 3, 5],
    },
    mayday: { active: false, detail: "" },
    resource_requests: ["SAMU: móvil avanzado en ruta, a cinco minutos (C7); aún no está en el lugar."],
    hazards: [
      "Derrame de combustible bajo el auto volcado y la camioneta (C3, C5).",
      "Tercer auto posiblemente eléctrico, tratado como energizado (C5).",
      "Tránsito lento en la calzada norte (C4).",
    ],
    command: {
      established: true,
      commander: "Oficial a cargo de B-4",
      post_location: "Vereda sur de Av. Departamental, al oriente del auto volcado",
    },
    codes_interpreted: [],
    open_questions: [
      "¿Hay más ocupantes en el auto volcado, en el asiento trasero?",
      "¿Cuántos ocupantes tiene el tercer auto y en qué estado están?",
      "¿Se confirmó que el tercer auto es eléctrico y que está apagado?",
      "¿Se necesitan más recursos para el derrame o una segunda unidad de rescate?",
      "¿Hay peatones lesionados o personas que se retiraron del lugar?",
    ],
  },

  /* ───────────── Informe de situación (estado final, tras C7) ───────────── */
  situation: {
    headline:
      "Colisión de 3 vehículos: auto volcado con 1 atrapado confirmado; derrame y posible auto eléctrico",
    incident_type: "vehicle_collision",
    severity: "high",
    trapped: {
      status: "confirmed",
      count_min: 1,
      count_max: 2,
      locations: ["V1, auto volcado sobre el techo: asiento del conductor"],
      basis:
        "B-4, en el lugar, confirma por radio un ocupante atrapado y consciente en el lado del conductor de V1 (C5). M1 ya mostraba a una persona dentro del habitáculo deformado que no salía y a un vecino diciendo que estaba atrapada. La parte trasera del habitáculo no se ve en M1 ni en M2: no se descarta un segundo ocupante, por eso el máximo es 2.",
      evidence: [
        { ref: "C5", frame: -1, note: "B-4: auto volcado con un ocupante atrapado, consciente, lado del conductor." },
        { ref: "M1", frame: 1, note: "Persona dentro de V1 que mueve un brazo y no sale; techo hundido sobre la ventana." },
        { ref: "C1", frame: -1, note: "La informante dice que hay una persona que no puede salir del auto volcado." },
        { ref: "M2", frame: 0, note: "Techo de V1 aplastado en todo el largo del habitáculo; interior no visible." },
      ],
    },
    injured: {
      status: "confirmed",
      count_estimate: 2,
      detail:
        "El ocupante atrapado en V1 y el conductor de V2, con una lesión en el brazo (C5; visto en M1 cuadro 2). El estado de los ocupantes de V3 no se conoce.",
    },
    fire: {
      present: false,
      stage: "none",
      location: "",
      spread:
        "No se observa fuego. El derrame bajo V1 y V2 y la batería de V3, si es eléctrico, son las fuentes de riesgo de ignición a vigilar.",
      smoke:
        "No se observa humo ni vapor en M1 ni en M2 (hasta las 20:43). Esto no descarta daño en la batería de V3.",
    },
    structure: {
      description:
        "No hay edificaciones involucradas. En la esquina nororiente del cruce hay un edificio residencial, desde cuyo balcón se grabó M2.",
      floors: 0,
      construction: "unknown",
      exposures: "Sin exposiciones estructurales; los primeros autos de la fila quedan a pocos metros de V3.",
    },
    vehicles: {
      count: 3,
      description:
        "V1 auto volcado sobre el techo; V2 camioneta con daño frontal severo; V3 auto posiblemente eléctrico, con daño frontal tras chocar la zaga de V2.",
      entrapment: "confirmed",
      details:
        "V1: sobre el techo, techo hundido y pilares delanteros deformados, pierde líquido; un atrapado confirmado (C5). V2: sobre sus ruedas, frente destruido, pierde líquido bajo el motor; conductor fuera y lesionado. V3: sobre sus ruedas, daño frontal moderado; rótulo \"EV\", posible puerto de carga y sin escape visible (M2 cuadro 1), tratado como energizado por B-4. No se sabe si V1 tiene airbags sin desplegar.",
    },
    hazards: [
      {
        kind: "fuel_spill",
        description:
          "Mancha de líquido bajo V2 y V1, posible combustible, que escurre hacia la solera sur; cubre la zona donde se trabajará en V1.",
        severity: "high",
        evidence: [
          { ref: "M1", frame: 2, note: "Líquido que escurre desde el frente de V2 hacia V1." },
          { ref: "M2", frame: 0, note: "Mancha que cubre la pista central bajo V1 y V2." },
          { ref: "C5", frame: -1, note: "B-4 informa derrame de combustible bajo el volcado y la camioneta." },
        ],
      },
      {
        kind: "other",
        description: "V1 sobre el techo hundido: posición inestable hasta estabilizarlo; curiosos apoyados en la carrocería.",
        severity: "high",
        evidence: [
          { ref: "M1", frame: 1, note: "Dos curiosos agachados y apoyados en V1 volcado." },
          { ref: "C5", frame: -1, note: "B-4 inicia la estabilización." },
        ],
      },
      {
        kind: "ev_battery",
        description:
          "V3 posiblemente eléctrico: considerar riesgo eléctrico y de fuga térmica hasta descartarlo. No se observa vapor ni humo bajo el vehículo, lo que no descarta daño en la batería.",
        severity: "medium",
        evidence: [
          { ref: "M2", frame: 1, note: "Rótulo \"EV\" en la zaga y tapa compatible con puerto de carga." },
          { ref: "C5", frame: -1, note: "B-4: el tercer auto sería eléctrico, lo tratan como energizado." },
        ],
      },
      {
        kind: "traffic",
        description:
          "La calzada norte sigue con tránsito lento junto al bandejón, a pocos metros de la zona de trabajo.",
        severity: "medium",
        evidence: [
          { ref: "M2", frame: 2, note: "Autos pasando por la calzada norte." },
          { ref: "C4", frame: -1, note: "La Central informa tránsito lento en la calzada norte." },
        ],
      },
      {
        kind: "crowd",
        description: "Unas diez personas en la vereda sur frente a V1, algunas dentro de la zona del derrame.",
        severity: "medium",
        evidence: [
          { ref: "M1", frame: 1, note: "Curiosos junto a la ventana de V1." },
          { ref: "M2", frame: 2, note: "Grupo de curiosos en la vereda sur." },
        ],
      },
    ],
    access: {
      best_approach:
        "Por la calzada sur de Departamental desde el oriente: queda libre porque el tránsito está detenido al poniente de los vehículos. Desde Av. Macul por la calzada sur hay una fila de autos detenidos hasta el cruce.",
      obstructions: [
        "Fila de autos detenidos en la calzada sur desde V3 hasta Av. Macul",
        "Curiosos en la vereda sur frente a V1",
        "Bandejón central entre ambas calzadas",
        "Tránsito lento en la calzada norte",
      ],
      water_supply:
        "Grifo en la vereda sur, unos 35 m al oriente del auto volcado (M2 cuadro 2); operatividad no verificada. Sirve de respaldo para una línea de protección por el derrame.",
      staging_suggestion:
        "Material mayor y SAMU en la calzada sur al oriente del puesto de mando, fuera de la mancha del derrame y con salida libre hacia el oriente.",
    },
    insights: [
      {
        id: "I1",
        category: "life_safety",
        priority: "critical",
        title: "Ocupante atrapado y consciente en V1",
        detail:
          "B-4 lo confirma en el lado del conductor del auto volcado. El techo hundido y los pilares deformados son compatibles con atrapamiento físico; el nivel de atrapamiento solo lo determina quien accede al paciente.",
        confidence: "high",
        evidence: [
          { ref: "C5", frame: -1, note: "B-4: un ocupante atrapado, consciente, lado del conductor." },
          { ref: "M1", frame: 1, note: "Persona dentro de V1 que no sale; ventana del conductor reducida." },
        ],
      },
      {
        id: "I2",
        category: "life_safety",
        priority: "high",
        title: "Posible segundo ocupante en V1, sin verificar",
        detail:
          "Ningún medio muestra la parte trasera del habitáculo de V1. No se observan otras personas en el material disponible; esto no descarta víctimas. Tampoco se ha buscado a posibles eyectados.",
        confidence: "low",
        evidence: [
          { ref: "M1", frame: 1, note: "Solo se ve el lado del conductor de V1." },
          { ref: "M2", frame: 0, note: "Desde la altura no se ve el interior de V1." },
        ],
      },
      {
        id: "I3",
        category: "vehicle",
        priority: "high",
        title: "V1 sobre el techo: inestable hasta estabilizar",
        detail:
          "El auto descansa sobre el techo hundido y hay curiosos apoyados en la carrocería. La posición condiciona la estabilización y el acceso al paciente.",
        confidence: "high",
        evidence: [
          { ref: "M1", frame: 1, note: "V1 volcado con curiosos apoyados." },
          { ref: "M2", frame: 0, note: "V1 sobre el techo en la pista central." },
        ],
      },
      {
        id: "I4",
        category: "hazard",
        priority: "high",
        title: "Derrame bajo la zona de trabajo",
        detail:
          "La mancha nace bajo V2 y cubre el entorno de V1, donde se hará la extricación. El líquido no se puede identificar en video; B-4 lo informa como combustible.",
        confidence: "medium",
        evidence: [
          { ref: "M2", frame: 0, note: "Mancha bajo V1 y V2." },
          { ref: "M1", frame: 2, note: "Líquido que escurre desde el frente de V2." },
          { ref: "C5", frame: -1, note: "Derrame de combustible bajo el volcado y la camioneta." },
        ],
      },
      {
        id: "I5",
        category: "hazard",
        priority: "high",
        title: "V3 posiblemente eléctrico",
        detail:
          "Rótulo \"EV\" en la zaga, posible puerto de carga y sin escape visible. Considerar riesgo eléctrico hasta descartarlo: puede seguir encendido y moverse en silencio. Vigilar vapor o humo blanco desde la parte baja, chasquidos o silbidos, señales de fuga térmica.",
        confidence: "medium",
        evidence: [
          { ref: "M2", frame: 1, note: "Rótulo \"EV\" y tapa compatible con puerto de carga en V3." },
          { ref: "C5", frame: -1, note: "B-4 trata el tercer auto como energizado." },
        ],
      },
      {
        id: "I6",
        category: "life_safety",
        priority: "medium",
        title: "Conductor de V2 lesionado en un brazo",
        detail: "Está fuera del vehículo; en M2 aparece sentado en la solera sur junto a V2.",
        confidence: "high",
        evidence: [
          { ref: "M1", frame: 2, note: "Persona junto a V2 sujetándose el brazo izquierdo." },
          { ref: "C5", frame: -1, note: "B-4: conductor de la camioneta fuera, con lesión en el brazo." },
        ],
      },
      {
        id: "I7",
        category: "life_safety",
        priority: "medium",
        title: "Ocupantes de V3 sin evaluar",
        detail:
          "Se ve una persona de pie junto a V3, compatible con su conductor. No se sabe si hay más ocupantes ni su estado; nadie lo ha informado por radio.",
        confidence: "low",
        evidence: [
          { ref: "M1", frame: 2, note: "Persona de pie junto a la puerta del conductor de V3." },
          { ref: "M2", frame: 1, note: "Persona junto al costado izquierdo de V3." },
        ],
      },
      {
        id: "I8",
        category: "hazard",
        priority: "medium",
        title: "Tránsito activo junto a la zona de trabajo",
        detail:
          "La calzada norte sigue con tránsito lento al otro lado del bandejón, y en M2 siguen entrando autos a la calzada sur desde Macul.",
        confidence: "high",
        evidence: [
          { ref: "M2", frame: 2, note: "Autos pasando por la calzada norte y entrando desde Macul." },
          { ref: "C4", frame: -1, note: "Tránsito lento en la calzada norte." },
        ],
      },
      {
        id: "I9",
        category: "resources",
        priority: "medium",
        title: "SAMU aún no está en el lugar",
        detail: "Móvil avanzado a cinco minutos según la Central; hay al menos dos lesionados.",
        confidence: "high",
        evidence: [{ ref: "C7", frame: -1, note: "SAMU indica móvil avanzado a cinco minutos." }],
      },
      {
        id: "I10",
        category: "access",
        priority: "low",
        title: "Calzada sur libre al oriente y grifo cercano",
        detail:
          "Al oriente de V1 la calzada sur no tiene tránsito; hay un grifo en la vereda sur en ese tramo, de operatividad no verificada.",
        confidence: "medium",
        evidence: [
          { ref: "M2", frame: 2, note: "Grifo en la vereda sur al oriente de V1." },
          { ref: "M2", frame: 0, note: "Calzada sur sin autos al oriente de V1." },
        ],
      },
    ],
    contradictions: [
      {
        description:
          "La Central informa que Carabineros cortó la calzada sur en Macul (C4), pero en M2, grabado poco después, siguen entrando autos a la calzada sur desde Macul. El corte pudo no estar completo a esa hora.",
        sources: ["C4", "M2"],
      },
    ],
    unknowns: [
      "Si hay un segundo ocupante en V1: el asiento trasero no se ve en ningún medio.",
      "Si V3 es eléctrico o híbrido y si está apagado.",
      "Qué líquido es el derrame y si sigue escurriendo.",
      "Cuántos ocupantes tiene V3 y en qué estado están.",
      "Si V1 tiene airbags sin desplegar.",
      "Si hubo peatones lesionados o eyectados: no se observan en el material disponible, lo que no los descarta.",
    ],
    recommended_actions: [
      {
        action: "Considerar completar la estabilización de V1 antes de cualquier acceso al paciente.",
        rationale: "V1 descansa sobre el techo hundido y hay civiles apoyados en la carrocería.",
        priority: "critical",
      },
      {
        action: "Considerar una línea de protección y absorbente sobre el derrame, controlando fuentes de ignición en el perímetro interno.",
        rationale: "El derrame cubre la zona donde se hará la extricación de V1.",
        priority: "high",
      },
      {
        action: "Considerar un recorrido 360° buscando un segundo ocupante en V1 y posibles eyectados.",
        rationale: "La parte trasera de V1 no se ve en ningún medio; la ausencia de evidencia no descarta víctimas.",
        priority: "high",
      },
      {
        action: "Considerar mantener V3 como energizado: verificar emblemas y cableado naranjo y vigilar vapor o chasquidos bajo el vehículo.",
        rationale: "Indicios de vehículo eléctrico en M2; en Chile no hay identificación estandarizada.",
        priority: "high",
      },
      {
        action: "Considerar pedir a Carabineros cortar la pista interior de la calzada norte y confirmar el corte en Macul.",
        rationale: "El tránsito sigue pasando junto a la zona de trabajo y M2 muestra autos entrando a la calzada sur.",
        priority: "medium",
      },
      {
        action: "Considerar recibir a SAMU por la calzada sur desde el oriente, junto al puesto de mando.",
        rationale: "Es el tramo libre de tránsito y fuera de la mancha del derrame.",
        priority: "medium",
      },
    ],
    briefing: {
      spoken:
        "Colisión de tres vehículos en avenida Departamental con avenida Macul, calzada sur. Auto volcado con un ocupante atrapado y consciente, confirmado por la unidad B cuatro; no se descarta un segundo ocupante. Derrame de combustible bajo el volcado y la camioneta. El tercer auto sería eléctrico: tratarlo como energizado. Tránsito lento en la calzada norte. Llegar por la calzada sur desde el oriente, que está libre. Puesto de mando en la vereda sur, al oriente del volcado. SAMU a cinco minutos.",
      bullets: [
        "V1 volcado: 1 atrapado consciente, lado conductor (B-4, C5)",
        "Posible 2º ocupante en V1: no verificado",
        "Derrame bajo V1 y V2: controlar ignición",
        "V3 posiblemente eléctrico: tratar como energizado",
        "Conductor de V2 lesionado en un brazo",
        "Calzada sur cortada; calzada norte con tránsito lento",
        "Acceso por calzada sur desde el oriente; SAMU a 5 min",
      ],
    },
    overall_confidence: "medium",
  },

  /* ───────────── Escena ───────────── */
  scene: {
    description:
      "Tres vehículos en la calzada sur de Av. Departamental, unos 35 m al oriente de Av. Macul: V1 volcado en la pista central, V2 cruzada al poniente y V3 contra la zaga de V2. Derrame bajo V1 y V2, fila de autos detenidos al poniente y tránsito lento en la calzada norte.",
    ground: {
      street_axis_deg: 90,
      notes:
        "Av. Departamental corre de oriente a poniente con dos calzadas separadas por un bandejón; Av. Macul la cruza de norte a sur. Terreno plano.",
    },
    roads: [
      {
        id: "R1",
        name: "Av. Departamental (calzada sur, hacia el oriente)",
        x1: -200,
        y1: 0,
        x2: 200,
        y2: 0,
        width_m: 10.5,
        blocked: true,
      },
      {
        id: "R2",
        name: "Av. Departamental (calzada norte, hacia el poniente)",
        x1: -200,
        y1: 13.5,
        x2: 200,
        y2: 13.5,
        width_m: 10.5,
        blocked: false,
      },
      {
        id: "R3",
        name: "Av. Macul",
        x1: -35,
        y1: -200,
        x2: -35,
        y2: 200,
        width_m: 14,
        blocked: false,
      },
    ],
    structures: [
      {
        id: "S1",
        label: "Edificio residencial, esquina nororiente",
        kind: "apartment_building",
        role: "reference",
        x: -8,
        y: 34,
        width_m: 30,
        depth_m: 20,
        floors: 8,
        floor_height_m: 2.7,
        rotation_deg: 180,
        roof: "flat",
        construction: "concrete",
        confidence: "medium",
        notes: "No involucrado. Desde un balcón del 4º piso de su fachada sur se grabó M2.",
      },
    ],
    fire_zones: [],
    smoke_plumes: [],
    people: [
      {
        id: "P1",
        status: "trapped",
        count: 1,
        structure_id: "",
        floor: 0,
        x: 4.3,
        y: -1.2,
        z: 0.5,
        confidence: "high",
        note: "Ocupante atrapado y consciente en el lado del conductor de V1, confirmado por B-4.",
        evidence: [
          { ref: "C5", frame: -1, note: "B-4 confirma un ocupante atrapado y consciente." },
          { ref: "M1", frame: 1, note: "Persona dentro de V1 que no sale." },
        ],
      },
      {
        id: "P2",
        status: "injured",
        count: 1,
        structure_id: "",
        floor: 0,
        x: -7.5,
        y: -4.6,
        z: 0,
        confidence: "high",
        note: "Conductor de V2 con lesión en un brazo, fuera del vehículo.",
        evidence: [
          { ref: "M1", frame: 2, note: "Persona junto a V2 sujetándose el brazo." },
          { ref: "C5", frame: -1, note: "B-4: conductor de la camioneta lesionado en el brazo." },
        ],
      },
      {
        id: "P3",
        status: "unknown",
        count: 1,
        structure_id: "",
        floor: 0,
        x: -11,
        y: 1.4,
        z: 0,
        confidence: "low",
        note: "Persona junto a V3, compatible con su conductor; estado desconocido.",
        evidence: [
          { ref: "M1", frame: 2, note: "Persona de pie junto a la puerta del conductor de V3." },
          { ref: "M2", frame: 1, note: "Persona junto al costado izquierdo de V3." },
        ],
      },
      {
        id: "P4",
        status: "bystander",
        count: 10,
        structure_id: "",
        floor: 0,
        x: 6,
        y: -6.8,
        z: 0,
        confidence: "high",
        note: "Curiosos en la vereda sur frente a V1; algunos sobre la calzada.",
        evidence: [
          { ref: "M1", frame: 0, note: "Grupo de curiosos junto a V1." },
          { ref: "M2", frame: 2, note: "Unas diez personas en la vereda sur." },
        ],
      },
    ],
    vehicles: [
      {
        id: "V1",
        kind: "car",
        state: "overturned",
        x: 4,
        y: -1.5,
        rotation_deg: 140,
        length_m: 4.4,
        width_m: 1.8,
        entrapment_suspected: true,
        burning: false,
        note: "Volcado sobre el techo, techo hundido; un atrapado confirmado (C5). Pierde líquido.",
      },
      {
        id: "V2",
        kind: "suv_pickup",
        state: "upright",
        x: -6,
        y: 1.5,
        rotation_deg: 75,
        length_m: 5.3,
        width_m: 1.9,
        entrapment_suspected: false,
        burning: false,
        note: "Camioneta con frente destruido; el derrame nace bajo su motor. Conductor fuera, lesionado.",
      },
      {
        id: "V3",
        kind: "car",
        state: "upright",
        x: -11.5,
        y: -0.5,
        rotation_deg: 80,
        length_m: 4.7,
        width_m: 1.85,
        entrapment_suspected: false,
        burning: false,
        note: "Daño frontal contra la zaga de V2. Posiblemente eléctrico (rótulo \"EV\", posible puerto de carga).",
      },
    ],
    hazards: [
      {
        id: "H1",
        kind: "fuel_spill",
        x: 0,
        y: -0.5,
        z: 0,
        radius_m: 8,
        severity: "high",
        note: "Derrame bajo V1 y V2, posible combustible; escurre hacia la solera sur.",
      },
      {
        id: "H2",
        kind: "other",
        x: 4,
        y: -1.5,
        z: 0.7,
        radius_m: 3,
        severity: "high",
        note: "V1 inestable sobre el techo hasta estabilizar.",
      },
      {
        id: "H3",
        kind: "ev_battery",
        x: -11.5,
        y: -0.5,
        z: 0.3,
        radius_m: 10,
        severity: "medium",
        note: "Posible vehículo eléctrico: tratar como energizado hasta descartarlo.",
      },
      {
        id: "H4",
        kind: "traffic",
        x: 0,
        y: 13.5,
        z: 0,
        radius_m: 15,
        severity: "medium",
        note: "Tránsito lento en la calzada norte junto al bandejón.",
      },
      {
        id: "H5",
        kind: "crowd",
        x: 6,
        y: -6.8,
        z: 0,
        radius_m: 5,
        severity: "medium",
        note: "Curiosos en la vereda sur, algunos dentro de la zona del derrame.",
      },
    ],
    access_points: [
      {
        id: "A1",
        kind: "command_post",
        x: 22,
        y: -8,
        label: "Puesto de mando (B-4)",
        note: "Vereda sur al oriente del volcado, fuera de la zona del derrame (C5).",
      },
      {
        id: "A2",
        kind: "staging",
        x: 48,
        y: 0,
        label: "Material mayor y SAMU",
        note: "Calzada sur al oriente, libre de tránsito y con salida hacia el oriente.",
      },
      {
        id: "A3",
        kind: "hydrant",
        x: 40,
        y: -7.5,
        label: "Grifo",
        note: "Vereda sur, visto en M2; operatividad no verificada.",
      },
      {
        id: "A4",
        kind: "street_entry",
        x: 120,
        y: 0,
        label: "Entrada por la calzada sur desde el oriente",
        note: "Tramo sin tránsito: el tránsito está detenido al poniente de los vehículos.",
      },
    ],
    cameras: [
      { media_ref: "M1", x: 8, y: -7.5, z: 1.5, facing_deg: 310, confidence: "high" },
      { media_ref: "M2", x: -2, y: 23.6, z: 9.6, facing_deg: 175, confidence: "medium" },
    ],
    annotations: [
      { x: -70, y: 0, z: 2, text: "Fila de autos detenidos hasta Av. Macul y más al poniente" },
      { x: 20, y: 6.75, z: 1, text: "Bandejón central" },
      { x: 4, y: -1.5, z: 2.5, text: "V1: 1 atrapado confirmado (C5)" },
      { x: -11.5, y: -0.5, z: 2.5, text: "V3: posible eléctrico" },
    ],
    uncertainty_notes: [
      "Posiciones de los vehículos estimadas desde la vista elevada de M2 y desde M1; error de algunos metros.",
      "Ancho de calzadas (10,5 m) y bandejón (3 m) asumidos.",
      "Cruce con Av. Macul ubicado unos 35 m al poniente según el letrero visible en M2.",
      "Radio del derrame estimado desde la mancha visible en M2 a las 20:43; puede haber crecido.",
    ],
    confidence: "medium",
  },

  /* ───────────── Línea de tiempo ───────────── */
  events: [
    {
      at_s: 145,
      kind: "alert",
      severity: "critical",
      title: "Posible persona atrapada en auto volcado (V1)",
      detail:
        "M1 muestra un auto volcado con el techo hundido y una persona dentro que no sale. Atrapamiento probable; se confirma solo con acceso al paciente.",
      media: 0,
    },
    {
      at_s: 147,
      kind: "alert",
      severity: "warning",
      title: "Derrame bajo V1 y V2",
      detail: "M1 muestra líquido que escurre desde el frente de la camioneta hacia el auto volcado; posible combustible.",
      media: 0,
    },
    {
      at_s: 160,
      kind: "situation_updated",
      severity: "notice",
      title: "Informe actualizado: atrapamiento probable en V1",
      detail: "Fusión de M1 y C1–C3: colisión de tres vehículos, auto volcado con ocupante que no sale, derrame, sin fuego visible.",
    },
    {
      at_s: 266,
      kind: "alert",
      severity: "warning",
      title: "Posible vehículo eléctrico (V3)",
      detail:
        "M2 muestra rótulo \"EV\" en la zaga de V3 y una tapa compatible con puerto de carga. Considerar riesgo eléctrico hasta descartarlo.",
      media: 1,
    },
    {
      at_s: 280,
      kind: "situation_updated",
      severity: "notice",
      title: "Informe actualizado: posible auto eléctrico y extensión del derrame",
      detail: "M2 agrega la disposición de los vehículos, indicios de vehículo eléctrico en V3 y un grifo en la vereda sur.",
    },
    {
      at_s: 308,
      kind: "comms_alert",
      severity: "critical",
      title: "B-4 confirma ocupante atrapado en V1",
      detail: "B-4 en el lugar: un ocupante atrapado y consciente en el lado del conductor del auto volcado. Asume el mando.",
      comm_seq: 5,
    },
    {
      at_s: 340,
      kind: "comms",
      severity: "info",
      title: "RX-15 en el lugar para la extricación",
      detail: "RX-15 se pone a disposición del mando de B-4 y pide hora estimada de SAMU.",
      comm_seq: 6,
    },
    {
      at_s: 376,
      kind: "situation_updated",
      severity: "notice",
      title: "Informe actualizado: atrapamiento confirmado por B-4",
      detail:
        "Un atrapado consciente en V1 (C5), sin descartar un segundo ocupante; conductor de V2 lesionado; derrame bajo V1 y V2; V3 posiblemente eléctrico; SAMU a cinco minutos.",
    },
    {
      at_s: 376,
      kind: "scene_updated",
      severity: "info",
      title: "Escena reconstruida: 3 vehículos, derrame y zonas de riesgo",
      detail: "Calzadas de Departamental y Av. Macul, posición de V1–V3, derrame, posible batería de V3, puesto de mando, grifo y cámaras de M1 y M2.",
    },
  ],
};
