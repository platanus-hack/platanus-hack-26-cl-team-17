/**
 * Vitrina A — incendio estructural en vivienda de dos pisos, Ñuñoa (ficticio).
 *
 * Geometría de la escena (ENU, metros, origen en la casa involucrada S1):
 *  - Dublé Almeyda corre Este–Oeste con eje en y = −14 (calzada de 9 m); S1 está
 *    al norte de la calle con la fachada mirando al sur (rotation 180).
 *  - Los Talaveras corre Norte–Sur con eje en x = 64; el grifo queda en la vereda de la
 *    esquina norponiente, a ~59 m de la casa.
 *  - Coordenadas: tramo recto de Dublé Almeyda (rumbo real ~95°, se aproxima a 90°) a
 *    64 m al poniente de Los Talaveras, según OpenStreetMap; el número es ficticio.
 *  - Foco en el 2º piso, costado posterior (norte) hacia el oriente; cilindros de gas
 *    en el patio, junto al muro trasero; tendido eléctrico por la vereda norte.
 *  - Viento del surponiente: el humo deriva al nororiente (65°) y cubre la parte
 *    posterior de la vivienda vecina S2.
 *  - Los textos citan fotogramas en base 1, como los muestra la interfaz
 *    ("fotograma 2" = frames[1]).
 *
 * Todo es material de demostración: los análisis son simulados y los pósters
 * llevan marca de agua.
 */
import type { DemoFrameSpec, PosterSpec, ShowcaseSpec } from "./types";

/** Hora local de inicio del incidente impresa en los pósters (atardecer de noviembre). */
const START_CLOCK_S = 20 * 3600 + 41 * 60;

function clockAt(incidentS: number): string {
  const t = START_CLOCK_S + Math.round(incidentS);
  const hh = Math.floor(t / 3600) % 24;
  const mm = Math.floor(t / 60) % 60;
  const ss = t % 60;
  return [hh, mm, ss].map((n) => String(n).padStart(2, "0")).join(":");
}

const STREET = "Dublé Almeyda";

/** Fotograma: `capturedAtS` es el inicio de la grabación (segundos desde el inicio del incidente). */
function frame(capturedAtS: number, tS: number, poster: Omit<PosterSpec, "scene" | "clock">): DemoFrameSpec {
  return {
    t_s: tS,
    poster: { scene: "structure", clock: clockAt(capturedAtS + tS), ...poster },
  };
}

const M1_AT = 75;
const M2_AT = 190;
const M3_AT = 300;
const M4_AT = 590;

const NO_VICTIM_RULEOUT = "No se observan personas en el material disponible. Esto no descarta víctimas.";

export const SHOWCASE_A: ShowcaseSpec = {
  title: "Incendio estructural — Dublé Almeyda 2847, Ñuñoa",
  type: "structure_fire",
  address: "Dublé Almeyda 2847, Ñuñoa, Santiago",
  lat: -33.4568,
  lng: -70.59169,
  description:
    "Vivienda de dos pisos de material mixto con fuego en el segundo piso, costado posterior. Vecinos reportan una persona en una ventana del segundo piso y cilindros de gas en el patio.",
  status: "active",
  started_min_ago: 12,

  /* ═════════════════════════════ Medios ═════════════════════════════ */
  media: [
    /* ── M1 · vecino en la vereda de enfrente ── */
    {
      source: "demo",
      kind: "video",
      camera: { x: -3, y: -20 },
      accuracy_m: 8,
      heading_deg: 2,
      duration_s: 48,
      captured_at_s: M1_AT,
      received_at_s: 150,
      analyzed_at_s: 175,
      reporter_note:
        "¡Hay una señora en la ventana del segundo piso! Está golpeando el vidrio, el humo sale por atrás de la casa. Estoy en la vereda de enfrente.",
      frames: [
        frame(M1_AT, 4, {
          view: "front",
          caption: "M1 · Vecino · vereda de enfrente",
          floors: 2,
          building: "house",
          smoke: { color: "gray", volume: "moderate", position: "right" },
          exposures: { left: true, right: true },
          extras: ["power_lines"],
          street: STREET,
          variant: 11,
        }),
        frame(M1_AT, 18, {
          view: "front",
          caption: "M1 · Vecino · vereda de enfrente",
          floors: 2,
          building: "house",
          smoke: { color: "gray", volume: "moderate", position: "right" },
          person: { floor: 2, position: "left" },
          exposures: { left: true, right: true },
          extras: ["power_lines"],
          street: STREET,
          variant: 12,
        }),
        frame(M1_AT, 31, {
          view: "front",
          caption: "M1 · Vecino · vereda de enfrente",
          floors: 2,
          building: "house",
          smoke: { color: "gray", volume: "heavy", position: "right" },
          person: { floor: 2, position: "left" },
          exposures: { left: true, right: true },
          extras: ["power_lines"],
          street: STREET,
          variant: 13,
        }),
        frame(M1_AT, 44, {
          view: "front",
          caption: "M1 · Vecino · vereda de enfrente",
          floors: 2,
          building: "house",
          smoke: { color: "black", volume: "heavy", position: "center" },
          exposures: { left: true, right: true },
          extras: ["power_lines", "crowd"],
          street: STREET,
          variant: 14,
        }),
      ],
      analysis: {
        usable: true,
        unusable_reason: "",
        incident_type: "structure_fire",
        summary:
          "Casa de dos pisos con humo que sale desde detrás de la techumbre, costado oriente, y aumenta de volumen durante el video. En los fotogramas 2 y 3 se observa una persona en la ventana del 2º piso, lado izquierdo (poniente) de la fachada, golpeando el vidrio.",
        viewpoint: {
          position_description: "Vereda sur de Dublé Almeyda, frente al domicilio, mirando al norte.",
          facing: "N",
          distance_m: 20,
          elevation: "ground",
        },
        structure: {
          present: true,
          kind: "house_2_story",
          floors_visible: 2,
          construction: "mixed",
          exposures:
            "Vivienda de dos pisos al oriente separada por un pasillo lateral angosto; vivienda de un piso al poniente, también cercana.",
          description:
            "Primer piso de albañilería y segundo piso aparentemente de tabiquería revestida, techo a dos aguas. Antejardín con reja y portón metálico; número 2847 en el pilar.",
        },
        fire: {
          present: true,
          stage: "growth",
          flames_visible: false,
          locations: [
            {
              floor: 2,
              side: "rear",
              description:
                "No se ven llamas desde el frente. El humo nace detrás de la cumbrera, hacia el oriente: compatible con un foco en el 2º piso, costado posterior.",
            },
          ],
          smoke: {
            present: true,
            color: "gray",
            volume: "heavy",
            description:
              "Humo gris de volumen moderado que pasa a abundante y se oscurece hacia negro en el último fotograma; en el fotograma 4 empieza a salir también por el alero del frente y cubre la ventana donde estaba la persona. Deriva hacia el oriente.",
          },
          spread_risk: "high",
        },
        people: [
          {
            status: "at_window_or_balcony",
            count: 1,
            location: "Ventana del 2º piso, lado izquierdo (poniente) de la fachada",
            floor: 2,
            frame_refs: [1, 2],
            confidence: "medium",
            description:
              "Silueta de una persona adulta que golpea el vidrio desde adentro. En el fotograma 4 el humo tapa la ventana y no se puede saber si sigue ahí.",
          },
          {
            status: "bystander",
            count: 6,
            location: "Vereda sur, frente al domicilio",
            floor: 0,
            frame_refs: [3],
            confidence: "high",
            description: "Vecinos mirando y gritando hacia la casa.",
          },
        ],
        vehicles: [],
        hazards: [
          {
            kind: "power_lines",
            description:
              "Tendido eléctrico aéreo por la vereda norte, con empalme que llega a la fachada de la casa.",
            severity: "medium",
            frame_refs: [0, 3],
          },
        ],
        access: {
          description:
            "Frente directo a Dublé Almeyda, con autos estacionados a ambos lados. Antejardín corto con portón metálico y puerta principal al centro de la fachada.",
          obstructions: ["Autos estacionados en ambos costados de la calzada", "Reja y portón del antejardín"],
          water_sources: [],
        },
        key_frames: [
          { frame: 1, caption: "Persona en la ventana del 2º piso poniente: riesgo a la vida." },
          { frame: 2, caption: "La persona sigue en la ventana mientras el humo aumenta." },
          { frame: 3, caption: "Humo más oscuro sale por el alero del frente y cubre la ventana." },
        ],
        visible_text: ["2847 (pilar del portón)"],
        uncertainties: [
          "No se ve el costado posterior: la ubicación del foco es inferida por el origen del humo.",
          "Luz de atardecer: el color del humo puede verse alterado.",
          "No se sabe si la persona sigue en la ventana después del fotograma 3.",
          "No se puede saber si hay más personas adentro: el video muestra solo la fachada.",
        ],
        confidence: "medium",
      },
    },

    /* ── M2 · vecino desde el patio de la casa del lado oriente ── */
    {
      source: "demo",
      kind: "video",
      camera: { x: 11, y: 12 },
      accuracy_m: 12,
      heading_deg: 232,
      duration_s: 35,
      captured_at_s: M2_AT,
      received_at_s: 255,
      analyzed_at_s: 285,
      reporter_note:
        "Grabo desde mi patio, la casa de al lado. Sale fuego por la ventana de atrás del segundo piso y ¡tienen los balones de gas pegados a la pared! Ahí vive la señora Marta con su mamá.",
      frames: [
        frame(M2_AT, 3, {
          view: "rear",
          caption: "M2 · Vecino · patio de la casa oriente",
          floors: 2,
          building: "house",
          fire: { floor: 2, position: "left", intensity: "moderate" },
          smoke: { color: "black", volume: "heavy", position: "left" },
          exposures: { left: true },
          extras: ["gas_cylinders"],
          variant: 21,
        }),
        frame(M2_AT, 15, {
          view: "rear",
          caption: "M2 · Vecino · patio de la casa oriente",
          floors: 2,
          building: "house",
          fire: { floor: 2, position: "left", intensity: "heavy" },
          smoke: { color: "black", volume: "heavy", position: "center" },
          exposures: { left: true },
          extras: ["gas_cylinders"],
          variant: 22,
        }),
        frame(M2_AT, 29, {
          view: "side",
          caption: "M2 · Vecino · patio de la casa oriente",
          floors: 2,
          building: "house",
          fire: { floor: 2, position: "right", intensity: "heavy" },
          smoke: { color: "black", volume: "heavy", position: "right" },
          exposures: { left: true },
          extras: ["gas_cylinders"],
          variant: 23,
        }),
      ],
      analysis: {
        usable: true,
        unusable_reason: "",
        incident_type: "structure_fire",
        summary:
          "Desde el patio vecino del lado oriente se ven llamas saliendo por una ventana del 2º piso en el costado posterior y humo negro denso a presión por la ventana y los aleros. Junto al muro posterior, bajo esa ventana, hay al menos dos cilindros de gas licuado.",
        viewpoint: {
          position_description:
            "Patio posterior de la vivienda vecina del lado oriente, mirando al surponiente hacia el costado posterior de la casa.",
          facing: "SW",
          distance_m: 11,
          elevation: "ground",
        },
        structure: {
          present: true,
          kind: "house_2_story",
          floors_visible: 2,
          construction: "mixed",
          exposures:
            "La vivienda desde donde se graba queda al otro lado de un pasillo lateral angosto; su alero está de cara al foco y a sotavento.",
          description:
            "Costado posterior con ampliación del 2º piso en tabiquería, ventana con marco de madera. Patio con piso de cemento.",
        },
        fire: {
          present: true,
          stage: "fully_developed",
          flames_visible: true,
          locations: [
            {
              floor: 2,
              side: "rear",
              description:
                "Llamas por la ventana del 2º piso posterior, hacia el oriente: compatible con una pieza en pleno desarrollo y autoventilada. En el fotograma 3 las llamas alcanzan el alero.",
            },
          ],
          smoke: {
            present: true,
            color: "black",
            volume: "heavy",
            description:
              "Humo negro, denso y turbulento, sale a presión por la ventana y por los aleros posteriores, en volutas rápidas. Compatible con gases muy calientes en el 2º piso y posible paso al entretecho.",
          },
          spread_risk: "high",
        },
        people: [],
        vehicles: [],
        hazards: [
          {
            kind: "gas_cylinder",
            description:
              "Al menos dos cilindros de gas licuado de formato grande, apoyados en el muro posterior justo bajo la ventana con llamas; reciben calor directo.",
            severity: "high",
            frame_refs: [0, 1, 2],
          },
          {
            kind: "collapse_risk",
            description:
              "Ampliación del 2º piso en tabiquería con fuego sostenido; la construcción liviana puede fallar sin aviso visible.",
            severity: "medium",
            frame_refs: [1, 2],
          },
        ],
        access: {
          description:
            "Al patio posterior se llega por el pasillo lateral oriente desde la calle; el pasillo es angosto, para personal a pie.",
          obstructions: ["Pasillo lateral angosto con un portón de reja", "Cilindros de gas en el patio"],
          water_sources: [],
        },
        key_frames: [
          { frame: 0, caption: "Llamas en la ventana del 2º piso posterior y cilindros de gas bajo ella." },
          { frame: 1, caption: "Las llamas crecen; humo negro a presión por los aleros." },
          { frame: 2, caption: "Llamas alcanzan el alero; el alero de la casa vecina queda expuesto." },
        ],
        visible_text: [],
        uncertainties: [
          NO_VICTIM_RULEOUT,
          "No se ve el interior ni el costado poniente.",
          "No se puede saber si los cilindros están conectados ni si alguno tiene la válvula abierta.",
          "No se sabe si el fuego ya entró al entretecho.",
        ],
        confidence: "high",
      },
    },

    /* ── M3 · vecino en la esquina con Los Talaveras ── */
    {
      source: "demo",
      kind: "video",
      camera: { x: 70, y: -21 },
      accuracy_m: 6,
      heading_deg: 287,
      duration_s: 40,
      captured_at_s: M3_AT,
      received_at_s: 365,
      analyzed_at_s: 390,
      reporter_note:
        "Estoy en la esquina con Los Talaveras. Se ve la columna de humo negro, los cables pasan justo por delante de la casa. Ya se escuchan las sirenas.",
      frames: [
        frame(M3_AT, 5, {
          view: "corner",
          caption: "M3 · Vecino · esquina con Los Talaveras",
          floors: 2,
          building: "house",
          smoke: { color: "black", volume: "heavy", position: "center" },
          exposures: { left: true, right: true },
          extras: ["power_lines", "hydrant"],
          street: STREET,
          variant: 31,
        }),
        frame(M3_AT, 20, {
          view: "corner",
          caption: "M3 · Vecino · esquina con Los Talaveras",
          floors: 2,
          building: "house",
          smoke: { color: "black", volume: "heavy", position: "right" },
          exposures: { left: true, right: true },
          extras: ["power_lines", "hydrant", "crowd"],
          street: STREET,
          variant: 32,
        }),
        frame(M3_AT, 36, {
          view: "corner",
          caption: "M3 · Vecino · esquina con Los Talaveras",
          floors: 2,
          building: "house",
          smoke: { color: "black", volume: "heavy", position: "right" },
          exposures: { left: true, right: true },
          vehicles: [
            { kind: "car", state: "upright", x: 0.22 },
            { kind: "suv_pickup", state: "upright", x: 0.78 },
          ],
          extras: ["power_lines", "crowd"],
          street: STREET,
          variant: 33,
        }),
      ],
      analysis: {
        usable: true,
        unusable_reason: "",
        incident_type: "structure_fire",
        summary:
          "Vista por Dublé Almeyda hacia el poniente desde la esquina con Los Talaveras. Columna de humo negro abundante que sale de la parte posterior de la casa y deriva al nororiente sobre la vivienda vecina. Tendido eléctrico por la vereda norte frente a las casas, autos estacionados en ambos costados y un grifo en la vereda de la esquina norponiente.",
        viewpoint: {
          position_description:
            "Esquina suroriente de Dublé Almeyda con Los Talaveras, mirando al poniente por Dublé Almeyda.",
          facing: "W",
          distance_m: 73,
          elevation: "ground",
        },
        structure: {
          present: true,
          kind: "house_2_story",
          floors_visible: 2,
          construction: "unknown",
          exposures:
            "Vivienda de dos pisos al oriente de la casa afectada, bajo la deriva del humo; vivienda de un piso al poniente.",
          description:
            "Casa de dos pisos en la vereda norte, vista en ángulo; desde aquí no se distingue el material.",
        },
        fire: {
          present: true,
          stage: "growth",
          flames_visible: false,
          locations: [
            {
              floor: 0,
              side: "rear",
              description: "No se ven llamas desde la esquina; el humo nace en la parte posterior de la casa.",
            },
          ],
          smoke: {
            present: true,
            color: "black",
            volume: "heavy",
            description:
              "Columna negra y densa que se inclina hacia el nororiente, señal de viento del surponiente; envuelve el techo de la casa vecina oriente.",
          },
          spread_risk: "high",
        },
        people: [
          {
            status: "bystander",
            count: 10,
            location: "Veredas de Dublé Almeyda frente al domicilio",
            floor: 0,
            frame_refs: [1, 2],
            confidence: "medium",
            description: "Grupo de vecinos en las veredas y parte de la calzada.",
          },
        ],
        vehicles: [],
        hazards: [
          {
            kind: "power_lines",
            description:
              "Tendido eléctrico aéreo por la vereda norte, cruzando delante de las fachadas, con empalmes hacia las casas; limita el uso de escalas al frente.",
            severity: "medium",
            frame_refs: [0, 1, 2],
          },
          {
            kind: "crowd",
            description: "Vecinos en la calzada que pueden estorbar la llegada y el posicionamiento de los carros.",
            severity: "low",
            frame_refs: [1, 2],
          },
        ],
        access: {
          description:
            "Con autos estacionados a ambos lados de Dublé Almeyda queda un carril libre. Desde Los Talaveras se entra directo a la cuadra.",
          obstructions: [
            "Autos estacionados en ambos costados de Dublé Almeyda",
            "Vecinos en la calzada",
            "Tendido eléctrico bajo frente a las fachadas",
          ],
          water_sources: [
            "Grifo en la vereda de la esquina norponiente de Dublé Almeyda con Los Talaveras, en la misma vereda del domicilio, al final de la cuadra; no se ve si está obstruido ni se puede saber si está operativo.",
          ],
        },
        key_frames: [
          { frame: 0, caption: "Grifo en la esquina norponiente y tendido eléctrico frente a las casas." },
          { frame: 1, caption: "Columna de humo negro inclinada al nororiente sobre la casa vecina." },
          { frame: 2, caption: "Calzada angosta por autos estacionados y vecinos en la calle." },
        ],
        visible_text: ["Dublé Almeyda", "Los Talaveras"],
        uncertainties: [
          "Desde esta distancia no se distinguen ventanas ni personas en la casa afectada.",
          "No se ve si el grifo funciona.",
          "No se puede saber si el tendido sigue energizado.",
        ],
        confidence: "medium",
      },
    },

    /* ── M4 · lote del dron D1 en órbita ── */
    {
      source: "drone",
      kind: "frames",
      camera: { x: 0, y: -60 },
      accuracy_m: 3,
      heading_deg: 0,
      duration_s: null,
      captured_at_s: M4_AT,
      received_at_s: 615,
      analyzed_at_s: 645,
      reporter_note: "",
      drone_alt_m: 45,
      // Cuadros cada ~25° de órbita (media.ts): a 8 m/s y 60 m de radio son ~3,3 s entre cuadros.
      // Izquierda/derecha según lo que ve la cámara mirando al centro desde cada punto.
      frames: [
        frame(M4_AT, 0, {
          view: "aerial",
          caption: "M4 · Dron D1 · órbita 60 m, 45 m de altura (desde el sur)",
          floors: 2,
          building: "house",
          fire: { floor: 2, position: "right", intensity: "heavy" },
          smoke: { color: "black", volume: "heavy", position: "right" },
          exposures: { left: true, right: true },
          vehicles: [
            { kind: "truck", state: "upright", x: 0.52, tag: "B-3" },
            { kind: "truck", state: "upright", x: 0.75, tag: "Q-8" },
          ],
          extras: ["power_lines"],
          street: STREET,
          variant: 41,
        }),
        frame(M4_AT, 3, {
          view: "aerial",
          caption: "M4 · Dron D1 · órbita 60 m, 45 m de altura (desde el sur-surponiente)",
          floors: 2,
          building: "house",
          fire: { floor: 2, position: "center", intensity: "heavy" },
          smoke: { color: "black", volume: "heavy", position: "right" },
          exposures: { left: true, right: true },
          vehicles: [
            { kind: "truck", state: "upright", x: 0.63, tag: "B-3" },
            { kind: "truck", state: "upright", x: 0.86, tag: "Q-8" },
          ],
          extras: ["power_lines"],
          street: STREET,
          variant: 42,
        }),
        frame(M4_AT, 7, {
          view: "aerial",
          caption: "M4 · Dron D1 · órbita 60 m, 45 m de altura (desde el surponiente)",
          floors: 2,
          building: "house",
          fire: { floor: 2, position: "center", intensity: "heavy" },
          smoke: { color: "black", volume: "heavy", position: "center" },
          exposures: { left: true, right: true },
          extras: ["fire_engine"],
          variant: 43,
        }),
        frame(M4_AT, 10, {
          view: "aerial",
          caption: "M4 · Dron D1 · órbita 60 m, 45 m de altura (desde el poniente-surponiente)",
          floors: 2,
          building: "house",
          fire: { floor: 2, position: "left", intensity: "heavy" },
          smoke: { color: "black", volume: "heavy", position: "center" },
          exposures: { left: true, right: true },
          extras: ["gas_cylinders"],
          variant: 44,
        }),
        frame(M4_AT, 13, {
          view: "aerial",
          caption: "M4 · Dron D1 · órbita 60 m, 45 m de altura (desde el poniente)",
          floors: 2,
          building: "house",
          fire: { floor: 2, position: "left", intensity: "heavy" },
          smoke: { color: "black", volume: "heavy", position: "center" },
          exposures: { left: true, right: true },
          extras: ["gas_cylinders"],
          variant: 45,
        }),
      ],
      analysis: {
        usable: true,
        unusable_reason: "",
        incident_type: "structure_fire",
        summary:
          "Vista aérea en órbita. Llamas en el 2º piso posterior hacia el oriente y humo negro a presión que sale también por la cumbrera y el faldón posterior del techo, compatible con fuego en el entretecho. El humo cubre la parte posterior del techo y el alero de la vivienda vecina oriente. Los cilindros de gas siguen junto al muro posterior. Carros B-3 y Q-8 en Dublé Almeyda, escala de mano apoyada en la fachada.",
        viewpoint: {
          position_description:
            "Dron D1 en órbita de 60 m de radio a 45 m de altura; los cuadros van desde el sur hasta el poniente.",
          facing: "N",
          distance_m: 75,
          elevation: "aerial",
        },
        structure: {
          present: true,
          kind: "house_2_story",
          floors_visible: 2,
          construction: "mixed",
          exposures:
            "Vivienda de dos pisos al oriente, separada por un pasillo angosto y bajo la deriva del humo; vivienda de un piso al poniente, a barlovento. Patio posterior con cilindros de gas.",
          description:
            "Techo a dos aguas de planchas de zinc, con la cumbrera paralela a la calle; sale humo por la cumbrera, el faldón posterior y los aleros. No se ve hundimiento de la techumbre en estos cuadros.",
        },
        fire: {
          present: true,
          stage: "fully_developed",
          flames_visible: true,
          locations: [
            {
              floor: 2,
              side: "rear",
              description: "Llamas por la ventana posterior del 2º piso, hacia el oriente.",
            },
            {
              floor: 2,
              side: "roof",
              description:
                "Humo a presión por la cumbrera y aleros posteriores: compatible con fuego en el entretecho; no se ven llamas atravesando el techo.",
            },
          ],
          smoke: {
            present: true,
            color: "black",
            volume: "heavy",
            description:
              "Humo negro, denso y turbulento desde la parte posterior; deriva al nororiente y envuelve el techo de la casa vecina oriente. Por la ventana del 2º piso del frente, lado poniente, sale humo gris.",
          },
          spread_risk: "high",
        },
        people: [
          {
            status: "responder",
            count: 6,
            location: "Frente de la casa y antejardín",
            floor: 1,
            frame_refs: [0, 1],
            confidence: "high",
            description:
              "Bomberos con líneas tendidas hacia la puerta principal y una escala de mano en la ventana del 2º piso poniente.",
          },
        ],
        vehicles: [],
        hazards: [
          {
            kind: "gas_cylinder",
            description: "Dos cilindros de gas siguen en el patio, junto al muro posterior bajo el foco.",
            severity: "high",
            frame_refs: [3, 4],
          },
          {
            kind: "power_lines",
            description: "Tendido eléctrico por la vereda norte, entre los carros y la fachada.",
            severity: "medium",
            frame_refs: [0, 1],
          },
          {
            kind: "collapse_risk",
            description:
              "Fuego sostenido en el 2º piso posterior y posible entretecho comprometido sobre construcción liviana; no se ven señales de hundimiento, lo que no garantiza estabilidad.",
            severity: "medium",
            frame_refs: [1, 3],
          },
        ],
        access: {
          description:
            "Carros en Dublé Almeyda frente al domicilio; pasillo lateral oriente hacia el patio posterior; la casa poniente de un piso deja ver el costado poniente.",
          obstructions: ["Autos estacionados en ambos costados", "Tendido eléctrico frente a la fachada"],
          water_sources: [],
        },
        key_frames: [
          { frame: 0, caption: "Frente con B-3 y Q-8; humo gris por la ventana del 2º piso poniente." },
          { frame: 1, caption: "Humo por la cumbrera y el faldón posterior: posible fuego en entretecho; cubre la casa oriente." },
          { frame: 2, caption: "Casa poniente de un piso, a barlovento, sin humo visible sobre su techo." },
          { frame: 3, caption: "Cilindros de gas aún junto al muro posterior, bajo las llamas." },
        ],
        visible_text: ["B-3 (techo del carro bomba)"],
        uncertainties: [
          "No se ve a la persona reportada: la ventana del 2º piso poniente está cubierta de humo. Esto no descarta víctimas.",
          "Desde el aire no se puede confirmar si el fuego ya pasó al entretecho de la casa vecina.",
          "No se ve el grifo de la esquina en estos cuadros.",
        ],
        confidence: "medium",
      },
    },
  ],

  /* ═══════════════════════════ Radio ═══════════════════════════ */
  comms: [
    {
      at_s: 30,
      channel: "Central",
      speaker: "Central",
      text: "Central a B-3, B-1 y Q-8: incendio estructural en Dublé Almeyda 2847, entre Brown Sur y Los Talaveras, comuna de Ñuñoa. Casa de dos pisos. Llamados de vecinos indican persona en el segundo piso.",
    },
    {
      at_s: 55,
      channel: "Central",
      speaker: "B-3",
      text: "B-3 a Central, conforme, saliendo a cargo del teniente Rojas con seis voluntarios. ¿Tiene más antecedentes del domicilio?",
    },
    {
      at_s: 90,
      channel: "Central",
      speaker: "Central",
      text: "Central a B-3: vecinos informan humo saliendo por la parte de atrás, segundo piso. Un llamado dice que una señora se asomó por la ventana del frente pidiendo ayuda. Grifo más cercano en la esquina con Los Talaveras.",
    },
    {
      at_s: 130,
      channel: "Central",
      speaker: "Q-8",
      text: "Q-8 a Central, en ruta por Irarrázaval. Consulto si hay tendido eléctrico frente al domicilio y cómo está la calle para la mecánica.",
    },
    {
      at_s: 185,
      channel: "Central",
      speaker: "Central",
      text: "Central a unidades en ruta: llegó a la plataforma un video de un vecino desde la vereda de enfrente. En el video M1 se ve una persona en la ventana del segundo piso, lado poniente de la fachada. El humo sale por detrás de la casa y va en aumento.",
    },
    {
      at_s: 235,
      channel: "Central",
      speaker: "Central",
      text: "Central a B-3: segundo llamado indica que en la casa vivirían dos personas, una señora y su mamá, adulta mayor.",
    },
    {
      at_s: 300,
      channel: "Central",
      speaker: "Central",
      text: "Central a B-3 y Q-8: video desde el patio vecino muestra llamas por una ventana de atrás del segundo piso y cilindros de gas en el patio, pegados al muro posterior.",
    },
    {
      at_s: 400,
      channel: "Central",
      speaker: "Central",
      text: "Central a Q-8: video desde la esquina muestra tendido eléctrico por la vereda norte frente a las casas y autos estacionados a ambos lados. Grifo en la esquina norponiente con Los Talaveras. Se despliega el dron D1 sobre el lugar.",
    },
    {
      at_s: 455,
      channel: "Central",
      speaker: "B-3",
      text: "B-3 a Central, en el lugar. Se trata de casa habitación de dos pisos, material mixto, con fuego declarado en el segundo piso, costado posterior, y humo negro a presión por los aleros. Vecinos insisten en una persona en el segundo piso; desde el frente no la vemos en este momento. Exposiciones a ambos costados, la más comprometida al oriente. Tendido eléctrico al frente y cilindros de gas en el patio. Estrategia ofensiva, lado principal Dublé Almeyda, hacia el sur. Se evalúa peligro de propagación.",
    },
    {
      at_s: 475,
      channel: "Central",
      speaker: "B-3",
      text: "B-3 a Central: solicito segunda compañía, ambulancia SAMU, Carabineros para cortar el tránsito en Dublé Almeyda y que se pida a Enel el corte de energía del sector.",
    },
    {
      at_s: 500,
      channel: "Central",
      speaker: "Central",
      text: "Central a B-3, conforme: se despachan el B-5 y una ambulancia SAMU. Carabineros y Enel notificados, todavía sin hora de llegada.",
    },
    {
      at_s: 520,
      channel: "Central",
      speaker: "Teniente Rojas (B-3)",
      text: "Teniente Rojas a Central: asumo el mando. Puesto de mando en la vereda sur, frente al domicilio. Personal del B-3 entra por la puerta principal con línea de ataque y búsqueda en el segundo piso.",
    },
    {
      at_s: 548,
      channel: "Central",
      speaker: "Q-8",
      text: "Q-8 en el lugar, nos ubicamos en Dublé Almeyda al oriente del B-3. El tendido no deja levantar la mecánica al frente; ponemos escala de mano a la ventana del segundo piso poniente.",
    },
    {
      at_s: 650,
      channel: "Central",
      speaker: "B-1",
      text: "B-1 a Central, en el lugar. Armados desde el grifo de la esquina con Los Talaveras, alimentando al B-3.",
    },
    {
      at_s: 700,
      channel: "Central",
      speaker: "Teniente Rojas (B-3)",
      text: "Mando a Central: línea atacando el foco del segundo piso posterior. Búsqueda primaria en curso, todavía sin ubicar a la persona. Por lo que muestra el dron, el B-5 a su llegada protege la casa del oriente y revisa el entretecho. Los cilindros siguen en el patio, se enfrían con una línea por el pasillo oriente.",
    },
  ],

  comms_analysis: {
    summary:
      "Incendio en el 2º piso posterior de una casa de dos pisos en Dublé Almeyda 2847 con persona reportada en el 2º piso, aún no ubicada por la búsqueda primaria. Mando establecido por el teniente Rojas (B-3) con estrategia ofensiva; B-3, Q-8 y B-1 operando y B-5, SAMU, Carabineros y corte de energía solicitados sin confirmar en el lugar.",
    units: [
      { name: "B-3", status: "operating", last_report: "Línea de ataque al foco del 2º piso posterior y búsqueda primaria en curso (C15)." },
      { name: "Q-8", status: "operating", last_report: "Escala de mano a la ventana del 2º piso poniente; la mecánica no se levanta por el tendido (C13)." },
      { name: "B-1", status: "operating", last_report: "Armado desde el grifo de Los Talaveras, alimenta al B-3 (C14)." },
      { name: "B-5", status: "dispatched", last_report: "Despachado como segunda compañía; a su llegada protegerá la casa del oriente (C11, C15)." },
      { name: "SAMU", status: "dispatched", last_report: "Ambulancia despachada (C11)." },
      { name: "Carabineros", status: "dispatched", last_report: "Notificados para cortar el tránsito, sin hora de llegada (C11)." },
    ],
    events: [
      { entry_seq: 1, kind: "dispatch", text: "Despacho de B-3, B-1 y Q-8 a Dublé Almeyda 2847, Ñuñoa; llamados indican persona en el 2º piso.", priority: "critical" },
      { entry_seq: 3, kind: "victim_report", text: "Un llamado informa una señora asomada a la ventana del frente pidiendo ayuda; humo por la parte posterior del 2º piso.", priority: "critical" },
      { entry_seq: 4, kind: "other", text: "Q-8 consulta por tendido eléctrico y estado de la calle para la escala mecánica.", priority: "routine" },
      { entry_seq: 5, kind: "victim_report", text: "Central retransmite el video M1: persona en la ventana del 2º piso, lado poniente.", priority: "critical" },
      { entry_seq: 6, kind: "victim_report", text: "En la casa vivirían dos personas, una de ellas adulta mayor.", priority: "critical" },
      { entry_seq: 7, kind: "hazard", text: "Llamas por la ventana posterior del 2º piso y cilindros de gas pegados al muro posterior.", priority: "important" },
      { entry_seq: 8, kind: "hazard", text: "Tendido eléctrico frente a las casas y autos estacionados a ambos lados; grifo en la esquina norponiente con Los Talaveras; se despliega el dron D1.", priority: "important" },
      { entry_seq: 9, kind: "arrival", text: "B-3 llega al lugar.", priority: "important" },
      { entry_seq: 9, kind: "size_up", text: "Casa de dos pisos de material mixto con fuego declarado en el 2º piso posterior y humo negro a presión; persona no vista desde el frente; exposición más comprometida al oriente; estrategia ofensiva, lado principal Dublé Almeyda al sur.", priority: "critical" },
      { entry_seq: 10, kind: "resource_request", text: "Se piden segunda compañía, SAMU, Carabineros para el tránsito y corte de energía a Enel.", priority: "important" },
      { entry_seq: 11, kind: "status_update", text: "Central despacha B-5 y SAMU; Carabineros y Enel notificados sin hora de llegada.", priority: "routine" },
      { entry_seq: 12, kind: "order", text: "Teniente Rojas asume el mando; puesto de mando en la vereda sur; B-3 entra con línea y búsqueda al 2º piso.", priority: "important" },
      { entry_seq: 13, kind: "arrival", text: "Q-8 en el lugar; el tendido impide la mecánica, coloca escala de mano en la ventana del 2º piso poniente.", priority: "important" },
      { entry_seq: 14, kind: "arrival", text: "B-1 en el lugar, armado desde el grifo de Los Talaveras.", priority: "routine" },
      { entry_seq: 15, kind: "status_update", text: "Línea atacando el foco; búsqueda primaria sin ubicar aún a la persona; B-5 protegerá la casa oriente y el entretecho; cilindros siguen en el patio y se enfrían.", priority: "critical" },
    ],
    victims: {
      status: "reported",
      detail:
        "Vecinos y Central reportan una persona en la ventana del 2º piso y que en la casa vivirían dos personas, una adulta mayor. Ninguna unidad en el lugar ha ubicado ni descartado a nadie: la búsqueda primaria sigue en curso.",
      entry_seqs: [1, 3, 5, 6, 9, 15],
    },
    mayday: { active: false, detail: "" },
    resource_requests: [
      "B-5 (segunda compañía), despachado",
      "Ambulancia SAMU, despachada",
      "Carabineros para cortar el tránsito en Dublé Almeyda",
      "Corte de energía del sector por Enel, sin confirmar",
    ],
    hazards: [
      "Cilindros de gas en el patio posterior, bajo el foco, aún sin retirar (C7, C9, C15)",
      "Tendido eléctrico frente a la fachada; corte de energía solicitado y no confirmado (C8, C10, C13)",
      "Humo negro a presión por los aleros y posible entretecho comprometido (C9, C15)",
    ],
    command: {
      established: true,
      commander: "Teniente Rojas (B-3)",
      post_location: "Vereda sur de Dublé Almeyda, frente al domicilio",
    },
    codes_interpreted: [],
    open_questions: [
      "¿Confirmó Enel el corte de energía del tendido frente a la casa?",
      "¿Algún vecino sabe en qué pieza duerme o suele estar la adulta mayor?",
      "¿Cuál es la hora estimada de llegada del B-5 y de la ambulancia SAMU?",
      "¿Se pudo revisar el entretecho de la casa del oriente?",
      "¿Los cilindros del patio están conectados a la casa o sueltos?",
    ],
  },

  /* ═══════════════════════ Informe de situación ═══════════════════════ */
  situation: {
    headline:
      "Casa de 2 pisos con fuego en 2º piso posterior; persona probable en ventana del 2º piso; cilindros de gas en el patio",
    incident_type: "structure_fire",
    severity: "critical",
    trapped: {
      status: "probable",
      count_min: 1,
      count_max: 2,
      locations: [
        "2º piso, ventana del frente lado poniente (vista en M1 a las 20:42)",
        "Segunda ocupante adulta mayor, ubicación desconocida (C6)",
      ],
      basis:
        "M1 muestra a una persona golpeando el vidrio de la ventana del 2º piso poniente (fotogramas 1 y 2) y Central recibió llamados en el mismo sentido (C1, C3). Un segundo llamado indica que en la casa vivirían dos personas (C6). Al llegar, B-3 no la ve desde el frente (C9) y el dron tampoco (M4, ventana con humo); la búsqueda primaria aún no la ubica (C15). Esto no descarta víctimas.",
      evidence: [
        { ref: "M1", frame: 1, note: "Persona en la ventana del 2º piso poniente golpeando el vidrio." },
        { ref: "M1", frame: 2, note: "La persona sigue en la ventana mientras aumenta el humo." },
        { ref: "C3", frame: -1, note: "Llamado: una señora se asomó por la ventana del frente pidiendo ayuda." },
        { ref: "C6", frame: -1, note: "En la casa vivirían dos personas, una adulta mayor." },
        { ref: "C9", frame: -1, note: "B-3: vecinos insisten en persona en el 2º piso; desde el frente no la ven." },
        { ref: "M4", frame: 0, note: "Ventana del 2º piso poniente cubierta de humo; no se ve a la persona." },
      ],
    },
    injured: {
      status: "no_evidence",
      count_estimate: 0,
      detail:
        "No se ven ni se informan lesionados. La persona vista en la ventana pudo estar expuesta al humo; ambulancia SAMU despachada (C11).",
    },
    fire: {
      present: true,
      stage: "fully_developed",
      location:
        "2º piso, costado posterior hacia el oriente; humo por la cumbrera compatible con fuego en el entretecho de la mitad posterior.",
      spread:
        "Hacia el entretecho y hacia la vivienda vecina oriente, a sotavento y separada por un pasillo angosto. La casa poniente, de un piso, está a barlovento.",
      smoke:
        "Pasó de gris moderado (M1, 20:42) a negro, denso y a presión por ventana, aleros y cumbrera (M2, M3, M4); deriva al nororiente.",
    },
    structure: {
      description:
        "Casa de dos pisos con antejardín, fachada al sur hacia Dublé Almeyda; 1er piso de albañilería y 2º piso de tabiquería, techo a dos aguas de planchas de zinc.",
      floors: 2,
      construction: "mixed",
      exposures:
        "Oriente: casa de dos pisos tras un pasillo angosto, con humo sobre su techo y alero (M4). Poniente: casa de un piso cercana.",
    },
    vehicles: {
      count: 0,
      description: "No hay vehículos involucrados en la emergencia; autos estacionados a ambos lados de la calzada.",
      entrapment: "no_evidence",
      details: "",
    },
    hazards: [
      {
        kind: "gas_cylinder",
        description:
          "Al menos dos cilindros de gas licuado grandes junto al muro posterior, bajo la ventana con llamas; siguen ahí en los cuadros del dron.",
        severity: "high",
        evidence: [
          { ref: "M2", frame: 0, note: "Cilindros apoyados en el muro posterior bajo la ventana con llamas." },
          { ref: "M4", frame: 3, note: "Los cilindros siguen en el patio, bajo el foco." },
          { ref: "C15", frame: -1, note: "Mando: los cilindros siguen en el patio y se enfrían con una línea." },
        ],
      },
      {
        kind: "power_lines",
        description:
          "Tendido eléctrico aéreo por la vereda norte, frente a la fachada, con empalme a la casa; impide la escala mecánica al frente. Corte de energía solicitado, sin confirmar.",
        severity: "medium",
        evidence: [
          { ref: "M3", frame: 0, note: "Tendido frente a las fachadas, visto desde la esquina." },
          { ref: "M1", frame: 0, note: "Empalme que llega a la fachada." },
          { ref: "C13", frame: -1, note: "Q-8: el tendido no deja levantar la mecánica." },
        ],
      },
      {
        kind: "collapse_risk",
        description:
          "Fuego sostenido en el 2º piso de tabiquería y posible entretecho comprometido; no se ven señales de hundimiento, lo que no garantiza estabilidad.",
        severity: "medium",
        evidence: [
          { ref: "M2", frame: 2, note: "Llamas en la ampliación de tabiquería alcanzan el alero." },
          { ref: "M4", frame: 1, note: "Humo a presión por la cumbrera de la mitad posterior." },
        ],
      },
    ],
    access: {
      best_approach:
        "Por Dublé Almeyda desde Los Talaveras; carros frente al domicilio, fuera de la vertical del tendido. Al patio posterior solo a pie por el pasillo lateral oriente.",
      obstructions: [
        "Autos estacionados a ambos lados de Dublé Almeyda (queda un carril)",
        "Tendido eléctrico frente a la fachada",
        "Vecinos en la calzada",
        "Pasillo lateral oriente angosto",
      ],
      water_supply:
        "Grifo en la vereda de la esquina norponiente de Dublé Almeyda con Los Talaveras, a unos 60 m; B-1 informa que se armó desde él (C14).",
      staging_suggestion:
        "Material mayor que llegue (B-5, SAMU) en Los Talaveras al sur de Dublé Almeyda, sin entrar a la cuadra hasta que el mando lo asigne.",
    },
    insights: [
      {
        id: "I1",
        category: "life_safety",
        priority: "critical",
        title: "Persona vista en ventana del 2º piso poniente",
        detail:
          "M1 la muestra golpeando el vidrio a las 20:42; B-3 no la ve desde el frente al llegar y el dron ve esa ventana cubierta de humo. Puede haberse retirado hacia el interior. La búsqueda primaria aún no la ubica.",
        confidence: "medium",
        evidence: [
          { ref: "M1", frame: 1, note: "Persona en la ventana del 2º piso poniente." },
          { ref: "C9", frame: -1, note: "Desde el frente no la ven al llegar." },
          { ref: "C15", frame: -1, note: "Búsqueda primaria sin ubicar aún a la persona." },
        ],
      },
      {
        id: "I2",
        category: "life_safety",
        priority: "high",
        title: "Posible segunda ocupante, adulta mayor",
        detail:
          "Un llamado y la nota del vecino de M2 indican que en la casa viven dos personas, una adulta mayor. Su ubicación es desconocida y nada indica que haya salido.",
        confidence: "low",
        evidence: [
          { ref: "C6", frame: -1, note: "En la casa vivirían dos personas, una adulta mayor." },
          { ref: "M2", frame: -1, note: "Nota del vecino: ahí vive la señora Marta con su mamá." },
        ],
      },
      {
        id: "I3",
        category: "hazard",
        priority: "high",
        title: "Cilindros de gas bajo el foco",
        detail:
          "Al menos dos cilindros grandes junto al muro posterior reciben calor directo de la ventana con llamas. Siguen en el patio en los cuadros del dron.",
        confidence: "high",
        evidence: [
          { ref: "M2", frame: 1, note: "Llamas sobre los cilindros." },
          { ref: "M4", frame: 3, note: "Cilindros aún en el patio." },
        ],
      },
      {
        id: "I4",
        category: "fire_behavior",
        priority: "high",
        title: "Posible fuego en el entretecho",
        detail:
          "Humo negro a presión por aleros y cumbrera de la mitad posterior: compatible con extensión al entretecho y gases muy calientes en el 2º piso.",
        confidence: "medium",
        evidence: [
          { ref: "M2", frame: 1, note: "Humo negro a presión por los aleros posteriores." },
          { ref: "M4", frame: 1, note: "Humo por la cumbrera de la mitad posterior." },
          { ref: "C9", frame: -1, note: "B-3 informa humo negro a presión por los aleros." },
        ],
      },
      {
        id: "I5",
        category: "structure",
        priority: "high",
        title: "Exposición oriente a sotavento",
        detail:
          "La casa de dos pisos del oriente está tras un pasillo angosto y el humo cubre su techo y alero. Es la exposición más comprometida, como informó B-3.",
        confidence: "medium",
        evidence: [
          { ref: "M4", frame: 4, note: "Humo sobre el techo y el alero de la casa oriente." },
          { ref: "M2", frame: 2, note: "Llamas alcanzan el alero frente a la casa vecina." },
          { ref: "C9", frame: -1, note: "Exposición más comprometida al oriente." },
        ],
      },
      {
        id: "I6",
        category: "hazard",
        priority: "medium",
        title: "Tendido eléctrico frente a la fachada",
        detail:
          "Impide levantar la mecánica al frente y queda cerca de la escala de mano. El corte de energía está pedido a Enel y no se ha confirmado.",
        confidence: "high",
        evidence: [
          { ref: "M3", frame: 0, note: "Tendido frente a las fachadas." },
          { ref: "C13", frame: -1, note: "La mecánica no se levanta por el tendido." },
          { ref: "C11", frame: -1, note: "Enel notificado, sin confirmación." },
        ],
      },
      {
        id: "I7",
        category: "access",
        priority: "medium",
        title: "Calzada angosta y grifo en la esquina",
        detail:
          "Autos estacionados a ambos lados dejan un carril en Dublé Almeyda. El grifo de la esquina norponiente con Los Talaveras está en uso por B-1.",
        confidence: "high",
        evidence: [
          { ref: "M3", frame: 2, note: "Autos estacionados a ambos lados y vecinos en la calle." },
          { ref: "M3", frame: 0, note: "Grifo en la vereda de la esquina." },
          { ref: "C14", frame: -1, note: "B-1 armado desde el grifo." },
        ],
      },
      {
        id: "I8",
        category: "structure",
        priority: "medium",
        title: "2º piso de construcción liviana",
        detail:
          "La ampliación de tabiquería lleva varios minutos con fuego. No se ven señales de colapso, pero la construcción liviana puede fallar sin aviso.",
        confidence: "medium",
        evidence: [
          { ref: "M2", frame: 2, note: "Fuego sostenido en la ampliación de tabiquería." },
          { ref: "M1", frame: 0, note: "2º piso de tabiquería revestida." },
        ],
      },
      {
        id: "I9",
        category: "resources",
        priority: "medium",
        title: "Apoyos pedidos aún no en el lugar",
        detail: "B-5, SAMU, Carabineros y el corte de energía están solicitados y sin confirmar en el lugar.",
        confidence: "high",
        evidence: [
          { ref: "C10", frame: -1, note: "B-3 pide segunda compañía, SAMU, Carabineros y corte de energía." },
          { ref: "C11", frame: -1, note: "Central despacha B-5 y SAMU; Carabineros y Enel notificados." },
        ],
      },
      {
        id: "I10",
        category: "structure",
        priority: "low",
        title: "Exposición poniente de menor riesgo aparente",
        detail: "La casa poniente es de un piso y queda a barlovento; no se ve humo sobre ella en el material disponible.",
        confidence: "low",
        evidence: [{ ref: "M4", frame: 2, note: "Techo de la casa poniente sin humo visible." }],
      },
    ],
    contradictions: [
      {
        description:
          "M1 muestra a una persona en la ventana del 2º piso poniente; al llegar, B-3 informa que desde el frente no la ve. Pudo retirarse de la ventana o quedar oculta por el humo: no descarta víctima.",
        sources: ["M1", "C9"],
      },
    ],
    unknowns: [
      "Dónde está ahora la persona vista en la ventana",
      "Si hay una segunda ocupante y dónde está",
      "Si el fuego ya pasó al entretecho de la casa oriente",
      "Si el tendido frente a la casa sigue energizado",
      "Si los cilindros del patio están conectados o sueltos",
      "Interior del 2º piso y escalera: no hay imágenes",
    ],
    recommended_actions: [
      {
        action: "Considerar priorizar la búsqueda en la pieza del 2º piso frente poniente, donde se vio a la persona.",
        rationale: "Es la última ubicación conocida (M1, fotogramas 1 y 2) y el humo ya cubre esa ventana (M4).",
        priority: "critical",
      },
      {
        action: "Evaluar mantener el enfriamiento de los cilindros del patio y retirarlos solo si es seguro.",
        rationale: "Reciben calor directo bajo la ventana con llamas (M2) y siguen en el patio (M4, C15).",
        priority: "high",
      },
      {
        action: "Considerar revisar el entretecho propio y el de la casa oriente cuando llegue el B-5.",
        rationale: "Humo a presión por la cumbrera y sobre la casa oriente (M4); el mando ya lo anticipó (C15).",
        priority: "high",
      },
      {
        action: "Tratar el tendido como energizado hasta que Enel confirme el corte.",
        rationale: "La escala de mano trabaja cerca del tendido (M4, C13) y el corte no está confirmado (C11).",
        priority: "high",
      },
      {
        action: "Evaluar coordinar cualquier apertura de ventanas con la línea de ataque en posición.",
        rationale: "Humo negro a presión y posible entretecho comprometido (M2, M4): una ventilación no coordinada puede acelerar el fuego.",
        priority: "medium",
      },
      {
        action: "Considerar dejar al B-5 y la ambulancia en espera en Los Talaveras al sur de Dublé Almeyda.",
        rationale: "La cuadra queda con un carril por autos estacionados y vecinos en la calle (M3).",
        priority: "medium",
      },
    ],
    briefing: {
      spoken:
        "Incendio en casa de dos pisos en Dublé Almeyda 2847, Ñuñoa. Fuego en el segundo piso, costado posterior, con posible paso al entretecho. Persona vista en la ventana del segundo piso poniente; la búsqueda aún no la ubica y podría haber una segunda ocupante, adulta mayor. Cilindros de gas en el patio bajo el foco. Tendido eléctrico al frente, sin corte confirmado. Exposición más comprometida al oriente. Grifo en la esquina con Los Talaveras. Zona de espera sugerida en Los Talaveras.",
      bullets: [
        "Casa 2 pisos, material mixto — Dublé Almeyda 2847",
        "Fuego 2º piso posterior; posible entretecho",
        "Persona probable en ventana 2º piso poniente (M1); posible 2ª ocupante",
        "Cilindros de gas en el patio, bajo el foco",
        "Tendido eléctrico al frente; corte de Enel sin confirmar",
        "Exposición oriente a sotavento",
        "Grifo esquina Los Talaveras; espera en Los Talaveras al sur",
      ],
    },
    overall_confidence: "medium",
  },

  /* ═══════════════════════════ Escena ═══════════════════════════ */
  scene: {
    description:
      "Casa de dos pisos (S1) en la vereda norte de Dublé Almeyda con la fachada al sur; vecinas S2 (dos pisos, oriente) y S3 (un piso, poniente). Foco en el 2º piso posterior hacia el oriente, cilindros de gas en el patio, tendido por la vereda norte y grifo en la esquina con Los Talaveras.",
    ground: {
      street_axis_deg: 90,
      notes: "Dublé Almeyda corre Este–Oeste; Los Talaveras cruza Norte–Sur a unos 64 m al oriente. Terreno plano.",
    },
    roads: [
      { id: "R1", name: "Dublé Almeyda", x1: -160, y1: -14, x2: 160, y2: -14, width_m: 9, blocked: false },
      { id: "R2", name: "Los Talaveras", x1: 64, y1: -150, x2: 64, y2: 150, width_m: 8, blocked: false },
    ],
    structures: [
      {
        id: "S1",
        label: "Dublé Almeyda 2847",
        kind: "house_2_story",
        role: "involved",
        x: 0,
        y: 1,
        width_m: 10,
        depth_m: 12,
        floors: 2,
        floor_height_m: 2.6,
        rotation_deg: 180,
        roof: "gable",
        construction: "mixed",
        confidence: "medium",
        notes: "1er piso de albañilería, 2º piso de tabiquería; techo a dos aguas de planchas de zinc.",
      },
      {
        id: "S2",
        label: "Vivienda vecina oriente",
        kind: "house_2_story",
        role: "exposure",
        x: 15,
        y: 0.5,
        width_m: 10,
        depth_m: 11,
        floors: 2,
        floor_height_m: 2.6,
        rotation_deg: 180,
        roof: "gable",
        construction: "unknown",
        confidence: "medium",
        notes: "A sotavento, tras un pasillo angosto; humo sobre su techo y alero (M4).",
      },
      {
        id: "S3",
        label: "Vivienda vecina poniente",
        kind: "house_1_story",
        role: "exposure",
        x: -13,
        y: 0,
        width_m: 9,
        depth_m: 11,
        floors: 1,
        floor_height_m: 2.7,
        rotation_deg: 180,
        roof: "gable",
        construction: "unknown",
        confidence: "low",
        notes: "Un piso, a barlovento; sin humo visible en el material disponible.",
      },
    ],
    fire_zones: [
      {
        id: "F1",
        structure_id: "S1",
        floor: 2,
        side: "rear",
        x: 2.5,
        y: 5.5,
        z: 3.9,
        radius_m: 2.5,
        intensity: "heavy",
        confidence: "high",
        note: "Llamas por la ventana del 2º piso posterior hacia el oriente (M2, M4).",
      },
      {
        id: "F2",
        structure_id: "S1",
        floor: 2,
        side: "roof",
        x: 1.5,
        y: 4,
        z: 5.6,
        radius_m: 3,
        intensity: "smoke_only",
        confidence: "low",
        note: "Posible fuego en el entretecho: humo a presión por la cumbrera (M4).",
      },
    ],
    smoke_plumes: [{ id: "SP1", x: 2, y: 5, z: 8, drift_deg: 45, volume: "heavy", color: "black" }],
    people: [
      {
        id: "P1",
        status: "at_window_or_balcony",
        count: 1,
        structure_id: "S1",
        floor: 2,
        x: -2.5,
        y: -5.2,
        z: 3.9,
        confidence: "medium",
        note: "Vista en la ventana del 2º piso poniente a las 20:42 (M1); no ubicada todavía.",
        evidence: [
          { ref: "M1", frame: 1, note: "Persona golpeando el vidrio de la ventana." },
          { ref: "M1", frame: 2, note: "Sigue en la ventana con más humo." },
          { ref: "C3", frame: -1, note: "Llamado: señora asomada a la ventana del frente." },
        ],
      },
      {
        id: "P2",
        status: "bystander",
        count: 10,
        structure_id: "",
        floor: 0,
        x: 6,
        y: -20,
        z: 0,
        confidence: "medium",
        note: "Vecinos en la vereda sur y parte de la calzada.",
        evidence: [
          { ref: "M1", frame: 3, note: "Vecinos frente a la casa." },
          { ref: "M3", frame: 1, note: "Vecinos en veredas y calzada." },
        ],
      },
    ],
    vehicles: [
      {
        id: "V1",
        kind: "truck",
        state: "upright",
        x: 2,
        y: -15,
        rotation_deg: 270,
        length_m: 9,
        width_m: 2.5,
        entrapment_suspected: false,
        burning: false,
        note: "Carro bomba B-3 frente al domicilio (M4, C9).",
      },
      {
        id: "V2",
        kind: "truck",
        state: "upright",
        x: 16,
        y: -15,
        rotation_deg: 270,
        length_m: 11,
        width_m: 2.5,
        entrapment_suspected: false,
        burning: false,
        note: "Q-8 al oriente del B-3; la mecánica no se levanta por el tendido (C13).",
      },
      {
        id: "V3",
        kind: "truck",
        state: "upright",
        x: 54,
        y: -14,
        rotation_deg: 270,
        length_m: 9,
        width_m: 2.5,
        entrapment_suspected: false,
        burning: false,
        note: "B-1 armado desde el grifo de la esquina (C14).",
      },
    ],
    hazards: [
      { id: "H1", kind: "gas_cylinder", x: 3.5, y: 8.2, z: 0.6, radius_m: 15, severity: "high", note: "Dos o más cilindros de gas bajo la ventana con llamas (M2, M4)." },
      { id: "H2", kind: "power_lines", x: 0, y: -8.5, z: 7.5, radius_m: 5, severity: "medium", note: "Tendido por la vereda norte con empalme a la fachada; corte sin confirmar." },
      { id: "H3", kind: "collapse_risk", x: 2, y: 4, z: 4.5, radius_m: 7, severity: "medium", note: "2º piso de tabiquería con fuego sostenido y posible entretecho comprometido." },
    ],
    access_points: [
      { id: "A1", kind: "hydrant", x: 58.5, y: -8.5, label: "Grifo esquina Los Talaveras", note: "Vereda norponiente de la esquina, a unos 59 m de la casa; en uso por B-1 (C14)." },
      { id: "A2", kind: "door", x: 0, y: -5.2, label: "Puerta principal", note: "Ingreso de la línea de ataque del B-3 (C12)." },
      { id: "A3", kind: "gate", x: 7.5, y: -6, label: "Pasillo lateral oriente", note: "Portón de reja; único acceso a pie al patio posterior." },
      { id: "A4", kind: "window", x: -2.5, y: -5.3, label: "Ventana 2º piso poniente", note: "Persona vista en M1; escala de mano del Q-8 (C13)." },
      { id: "A5", kind: "command_post", x: -8, y: -21, label: "Puesto de mando", note: "Vereda sur, frente al domicilio, a barlovento (C12)." },
      { id: "A6", kind: "staging", x: 64, y: -45, label: "Espera sugerida", note: "Los Talaveras al sur de Dublé Almeyda, para B-5 y SAMU." },
      { id: "A7", kind: "street_entry", x: 58, y: -14, label: "Entrada por Los Talaveras", note: "Acceso de carros a la cuadra; queda un carril por autos estacionados." },
    ],
    cameras: [
      { media_ref: "M1", x: -3, y: -20, z: 1.6, facing_deg: 2, confidence: "medium" },
      { media_ref: "M2", x: 11, y: 12, z: 1.6, facing_deg: 232, confidence: "medium" },
      { media_ref: "M3", x: 70, y: -21, z: 1.6, facing_deg: 287, confidence: "high" },
      { media_ref: "M4", x: 0, y: -60, z: 45, facing_deg: 0, confidence: "high" },
    ],
    annotations: [
      { x: 0, y: -10, z: 0, text: "Lado A — Dublé Almeyda (sur)" },
      { x: -2.5, y: -5.3, z: 5, text: "Persona vista 20:42 (M1)" },
      { x: 3.5, y: 9, z: 2, text: "Cilindros de gas" },
      { x: 0, y: 1, z: 8, text: "Posible 2ª ocupante — ubicación desconocida" },
      { x: 58.5, y: -6, z: 2, text: "Grifo" },
    ],
    uncertainty_notes: [
      "Dimensiones de las casas asumidas según su apariencia en M1 y M4.",
      "Orientación de la fachada inferida de la calle: mira al sur.",
      "Posición del grifo estimada desde M3; puede variar unos metros.",
      "Ubicación del foco inferida de M2 y M4; el interior no se ve.",
      "La segunda ocupante no tiene ubicación conocida y no se dibuja.",
    ],
    confidence: "medium",
  },

  /* ═══════════════════════════ Dron ═══════════════════════════ */
  mission: {
    pattern: "orbit",
    radius_m: 60,
    altitude_m: 45,
    speed_ms: 8,
    home: { x: 0, y: -300 },
    created_at_s: 360,
    started_at_s: 420,
    battery_start_pct: 96,
  },

  /* ═══════════════════════ Línea de tiempo ═══════════════════════ */
  events: [
    {
      at_s: 40,
      kind: "comms_alert",
      severity: "critical",
      title: "Radio: llamados reportan persona en el 2º piso",
      detail: "Central despacha con el antecedente de una persona en el segundo piso (C1).",
      comm_seq: 1,
    },
    {
      at_s: 180,
      kind: "alert",
      severity: "critical",
      title: "Posible persona atrapada — M1: persona en ventana del 2º piso",
      detail: "Se ve una persona golpeando el vidrio de la ventana del 2º piso poniente (M1, fotogramas 1 y 2).",
      media: 0,
    },
    {
      at_s: 195,
      kind: "situation_updated",
      severity: "info",
      title: "Informe de situación actualizado",
      detail: "Persona probable en ventana del 2º piso; humo gris en aumento desde el 2º piso posterior.",
    },
    {
      at_s: 197,
      kind: "scene_updated",
      severity: "info",
      title: "Escena reconstruida",
      detail: "Casa S1 en Dublé Almeyda con persona en ventana del 2º piso poniente y cámara de M1.",
    },
    {
      at_s: 240,
      kind: "comms_alert",
      severity: "warning",
      title: "Radio: dos personas vivirían en el domicilio",
      detail: "Segundo llamado: una señora y su mamá, adulta mayor (C6).",
      comm_seq: 6,
    },
    {
      at_s: 290,
      kind: "alert",
      severity: "warning",
      title: "Cilindros de gas en el patio — M2: bajo la ventana con llamas",
      detail: "Al menos dos cilindros grandes junto al muro posterior reciben calor directo.",
      media: 1,
    },
    {
      at_s: 300,
      kind: "situation_updated",
      severity: "info",
      title: "Informe de situación actualizado",
      detail: "Foco confirmado en video en el 2º piso posterior; peligro alto por cilindros de gas.",
    },
    {
      at_s: 395,
      kind: "alert",
      severity: "notice",
      title: "Tendido eléctrico al frente — M3",
      detail: "Tendido por la vereda norte frente a la fachada; grifo en la esquina con Los Talaveras.",
      media: 2,
    },
    {
      at_s: 405,
      kind: "scene_updated",
      severity: "info",
      title: "Escena actualizada",
      detail: "Se agregan foco posterior, cilindros, tendido eléctrico, grifo y cámaras de M2 y M3.",
    },
    {
      at_s: 458,
      kind: "comms",
      severity: "notice",
      title: "B-3 en el lugar: fuego declarado en el 2º piso posterior",
      detail: "Desde el frente no ven a la persona; estrategia ofensiva, lado principal Dublé Almeyda (C9).",
      comm_seq: 9,
    },
    {
      at_s: 478,
      kind: "comms_alert",
      severity: "warning",
      title: "Solicitud de apoyo: segunda compañía, SAMU, Carabineros y corte de energía",
      detail: "B-3 pide recursos adicionales y corte de energía a Enel (C10).",
      comm_seq: 10,
    },
    {
      at_s: 522,
      kind: "comms",
      severity: "notice",
      title: "Mando establecido — Teniente Rojas (B-3)",
      detail: "Puesto de mando en la vereda sur, frente al domicilio (C12).",
      comm_seq: 12,
    },
    {
      at_s: 625,
      kind: "alert",
      severity: "warning",
      title: "Posible fuego en entretecho y exposición oriente — M4",
      detail: "El dron ve humo a presión por la cumbrera y sobre el techo de la casa oriente; cilindros aún en el patio.",
      media: 3,
      mission: true,
    },
    {
      at_s: 705,
      kind: "comms",
      severity: "notice",
      title: "Mando: búsqueda primaria sin ubicar aún a la persona",
      detail: "Línea atacando el foco; B-5 protegerá la casa oriente a su llegada (C15).",
      comm_seq: 15,
    },
    {
      at_s: 715,
      kind: "situation_updated",
      severity: "info",
      title: "Informe de situación actualizado",
      detail: "Persona probable aún no ubicada, posible entretecho comprometido y exposición oriente.",
    },
    {
      at_s: 716,
      kind: "scene_updated",
      severity: "info",
      title: "Escena actualizada",
      detail: "Se agregan carros en posición, puesto de mando, espera sugerida y posible foco en entretecho.",
    },
  ],
};
