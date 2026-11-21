import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  GeocodeError,
  parseCoordinates,
  parseNominatim,
  parseNominatimReverse,
  reverseGeocode,
  searchAddress,
  shortenDisplayName,
} from "./geocode";

const SAMPLE = [
  {
    place_id: 1,
    lat: "-33.4372",
    lon: "-70.6506",
    category: "place",
    type: "house",
    addresstype: "place",
    display_name:
      "Avenida Libertador Bernardo O'Higgins 1234, Santiago Centro, Santiago, Provincia de Santiago, Región Metropolitana de Santiago, 8320000, Chile",
  },
  {
    place_id: 2,
    lat: "-33.0472",
    lon: "-71.6127",
    category: "highway",
    type: "residential",
    display_name: "Calle Esmeralda, Valparaíso, Región de Valparaíso, 236-0000, Chile",
  },
];

describe("shortenDisplayName", () => {
  it("quita Chile, códigos postales y partes repetidas", () => {
    assert.equal(shortenDisplayName("Santiago, Santiago, 8320000, Chile"), "Santiago");
    assert.equal(shortenDisplayName("Calle 1, Temuco, 478-0000, Chile"), "Calle 1, Temuco");
    assert.equal(shortenDisplayName("Chile"), "Chile");
  });
  it("conserva números de calle (estilo chileno) y no los confunde con códigos postales", () => {
    assert.equal(shortenDisplayName("1234, Avenida Matta, Santiago, Chile"), "Avenida Matta 1234, Santiago");
    assert.equal(shortenDisplayName("Pasaje 5, Rancagua, Chile"), "Pasaje 5, Rancagua");
  });
});

describe("parseNominatim", () => {
  it("convierte resultados válidos", () => {
    const r = parseNominatim(SAMPLE);
    assert.equal(r.length, 2);
    assert.deepEqual(r[0], {
      label:
        "Avenida Libertador Bernardo O'Higgins 1234, Santiago Centro, Santiago, Provincia de Santiago, Región Metropolitana de Santiago",
      lat: -33.4372,
      lng: -70.6506,
      kind: "place",
    });
    assert.equal(r[1].label, "Calle Esmeralda, Valparaíso, Región de Valparaíso");
    assert.equal(r[1].kind, "residential");
    assert.ok(!r.some((x) => x.label.endsWith("Chile")));
  });

  it("descarta entradas incompletas o inválidas", () => {
    const r = parseNominatim([
      null,
      "texto",
      { lat: "-33", display_name: "Sin longitud, Chile" },
      { lat: "abc", lon: "-70", display_name: "Lat inválida" },
      { lat: "-95", lon: "-70", display_name: "Fuera de rango" },
      { lat: "-33", lon: "-70" },
      { lat: "", lon: "-70", display_name: "Lat vacía" },
      { lat: -33.5, lon: -70.5, display_name: "Números, Chile" },
    ]);
    assert.deepEqual(r, [{ label: "Números", lat: -33.5, lng: -70.5, kind: "place" }]);
  });

  it("devuelve [] si no es un arreglo", () => {
    assert.deepEqual(parseNominatim(null), []);
    assert.deepEqual(parseNominatim({ error: "x" }), []);
    assert.deepEqual(parseNominatim("[]"), []);
  });
});

describe("parseNominatimReverse", () => {
  it("lee display_name acortado", () => {
    assert.equal(
      parseNominatimReverse({ display_name: "Avenida Matta 500, Santiago, 8370000, Chile", lat: "-33", lon: "-70" }),
      "Avenida Matta 500, Santiago",
    );
  });
  it("null ante error o forma inesperada", () => {
    assert.equal(parseNominatimReverse({ error: "Unable to geocode" }), null);
    assert.equal(parseNominatimReverse([]), null);
    assert.equal(parseNominatimReverse(null), null);
    assert.equal(parseNominatimReverse({ display_name: 3 }), null);
  });
});

describe("parseCoordinates", () => {
  it("acepta formatos comunes", () => {
    assert.deepEqual(parseCoordinates("-33.4489, -70.6693"), { lat: -33.4489, lng: -70.6693 });
    assert.deepEqual(parseCoordinates("-33,4489 -70,6693"), { lat: -33.4489, lng: -70.6693 });
    assert.deepEqual(parseCoordinates("-33.4489,-70.6693"), { lat: -33.4489, lng: -70.6693 });
  });
  it("corrige el orden invertido si así cae en Chile", () => {
    assert.deepEqual(parseCoordinates("-70.6693, -33.4489"), { lat: -33.4489, lng: -70.6693 });
  });
  it("rechaza texto inválido", () => {
    assert.equal(parseCoordinates(""), null);
    assert.equal(parseCoordinates("-33.4"), null);
    assert.equal(parseCoordinates("1 2 3"), null);
    assert.equal(parseCoordinates("-120, 10"), null);
  });
});

describe("searchAddress / reverseGeocode con fetch simulado", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function mockFetch(handler: (url: URL) => Response | Promise<Response>): URL[] {
    const calls: URL[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      calls.push(url);
      return handler(url);
    }) as typeof fetch;
    return calls;
  }

  it("arma la URL con los parámetros correctos", async () => {
    const calls = mockFetch(() => Response.json(SAMPLE));
    const r = await searchAddress("  Alameda 1234  ");
    assert.equal(r.length, 2);
    assert.equal(calls.length, 1);
    const u = calls[0];
    assert.equal(u.origin + u.pathname, "https://nominatim.openstreetmap.org/search");
    assert.equal(u.searchParams.get("format"), "jsonv2");
    assert.equal(u.searchParams.get("countrycodes"), "cl");
    assert.equal(u.searchParams.get("limit"), "5");
    assert.equal(u.searchParams.get("accept-language"), "es");
    assert.equal(u.searchParams.get("q"), "Alameda 1234");
  });

  it("respeta limit y recorta resultados", async () => {
    const calls = mockFetch(() => Response.json(SAMPLE));
    const r = await searchAddress("Alameda", { limit: 1 });
    assert.equal(calls[0].searchParams.get("limit"), "1");
    assert.equal(r.length, 1);
  });

  it("consulta corta → [] sin llamar a fetch", async () => {
    const calls = mockFetch(() => Response.json(SAMPLE));
    assert.deepEqual(await searchAddress("ab"), []);
    assert.deepEqual(await searchAddress("   a  "), []);
    assert.equal(calls.length, 0);
  });

  it("HTTP 500 → GeocodeError con mensaje en español", async () => {
    mockFetch(() => new Response("boom", { status: 500 }));
    await assert.rejects(searchAddress("Alameda"), (err: unknown) => {
      assert.ok(err instanceof GeocodeError);
      assert.equal(err.message, "No se pudo buscar la dirección. Fíjala a mano en el mapa.");
      return true;
    });
  });

  it("falla de red → GeocodeError", async () => {
    mockFetch(() => {
      throw new TypeError("Failed to fetch");
    });
    await assert.rejects(searchAddress("Alameda"), GeocodeError);
  });

  it("AbortError pasa tal cual", async () => {
    mockFetch(() => {
      throw new DOMException("Aborted", "AbortError");
    });
    await assert.rejects(searchAddress("Alameda"), (err: unknown) => {
      assert.ok(!(err instanceof GeocodeError));
      assert.equal((err as Error).name, "AbortError");
      return true;
    });
  });

  it("reverseGeocode arma la URL y lee la dirección", async () => {
    const calls = mockFetch(() => Response.json({ display_name: "Avenida Matta 500, Santiago, 8370000, Chile" }));
    assert.equal(await reverseGeocode(-33.45, -70.65), "Avenida Matta 500, Santiago");
    const u = calls[0];
    assert.equal(u.pathname, "/reverse");
    assert.equal(u.searchParams.get("format"), "jsonv2");
    assert.equal(u.searchParams.get("lat"), "-33.45");
    assert.equal(u.searchParams.get("lon"), "-70.65");
    assert.equal(u.searchParams.get("zoom"), "18");
    assert.equal(u.searchParams.get("accept-language"), "es");
  });

  it("reverseGeocode: sin resultado → null; HTTP 503 → GeocodeError", async () => {
    mockFetch(() => Response.json({ error: "Unable to geocode" }));
    assert.equal(await reverseGeocode(-33.45, -70.65), null);
    mockFetch(() => new Response("", { status: 503 }));
    await assert.rejects(reverseGeocode(-33.45, -70.65), GeocodeError);
  });
});
