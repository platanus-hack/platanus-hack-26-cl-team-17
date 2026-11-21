import { test } from "node:test";
import assert from "node:assert/strict";
import {
  circularMeanDeg,
  clampDelayMs,
  collectHeading,
  DEFAULT_GEO_TIMEOUT_MS,
  MAX_TIMER_MS,
  WATCHDOG_GRACE_MS,
  GEO_ERROR_MESSAGES,
  GeoError,
  geoErrorCodeFromPositionError,
  getCompassHeading,
  getPosition,
  getPositionFrom,
  headingFromAlpha,
  headingFromOrientation,
  headingFromSample,
  normalizeHeading,
  normalizePermissionState,
  queryGeolocationPermission,
  toGeoError,
  toGeoPosition,
  watchPosition,
  type GeolocationLike,
} from "@/lib/client/geo";

const close = (actual: number | null, expected: number, eps = 1e-6) => {
  assert.ok(actual !== null, `esperaba ${expected}, llegó null`);
  // Distancia angular, para que 359.9999 ≈ 0.
  const d = Math.abs(((actual - expected + 540) % 360) - 180);
  assert.ok(d < eps, `esperaba ≈${expected}, llegó ${actual}`);
};

// ─── Ángulos ───

test("normalizeHeading lleva cualquier ángulo a [0, 360)", () => {
  assert.equal(normalizeHeading(0), 0);
  assert.equal(normalizeHeading(360), 0);
  assert.equal(normalizeHeading(720.5), 0.5);
  assert.equal(normalizeHeading(-90), 270);
  assert.equal(normalizeHeading(-360), 0);
  assert.ok(Object.is(normalizeHeading(-0), 0));
  assert.equal(normalizeHeading(-1e-14), 0);
});

test("headingFromAlpha = (360 - alpha) % 360", () => {
  assert.equal(headingFromAlpha(0), 0);
  assert.equal(headingFromAlpha(90), 270);
  assert.equal(headingFromAlpha(270), 90);
  assert.equal(headingFromAlpha(360), 0);
  assert.equal(headingFromAlpha(359), 1);
});

test("headingFromOrientation: vertical en retrato coincide con headingFromAlpha", () => {
  for (const alpha of [0, 30, 90, 180, 271]) close(headingFromOrientation(alpha, 90, 0), headingFromAlpha(alpha));
});

test("headingFromOrientation: casi plano usa el borde superior", () => {
  close(headingFromOrientation(45, 5, -3), headingFromAlpha(45));
  close(headingFromOrientation(200, 0, 0), headingFromAlpha(200));
});

test("headingFromOrientation: apaisado corrige los 90° que se equivoca alpha solo", () => {
  // alpha 0 y girado a la izquierda (gamma -90): la cámara trasera mira al este.
  close(headingFromOrientation(0, 0, -90), 90);
  close(headingFromOrientation(0, 0, 90), 270);
  close(headingFromOrientation(30, 0, -90), 60);
});

test("circularMeanDeg promedia en el círculo", () => {
  assert.equal(circularMeanDeg([]), null);
  close(circularMeanDeg([350, 10]), 0);
  close(circularMeanDeg([10, 20, 30]), 20);
  close(circularMeanDeg([355, 5, 15]), 5);
  close(circularMeanDeg([90]), 90);
  close(circularMeanDeg([270, 280]), 275);
  assert.equal(circularMeanDeg([0, 180]), null);
});

test("headingFromSample: iOS, Android absoluto y lecturas inválidas", () => {
  const base = { alpha: null, beta: null, gamma: null, absolute: false };
  assert.equal(headingFromSample({ ...base, webkitCompassHeading: 123, webkitCompassAccuracy: 10 }), 123);
  assert.equal(headingFromSample({ ...base, webkitCompassHeading: 123 }), 123);
  assert.equal(headingFromSample({ ...base, webkitCompassHeading: 123, webkitCompassAccuracy: -1 }), null);
  assert.equal(headingFromSample({ ...base, alpha: 90, beta: 90, gamma: 0 }), null, "relativo no sirve");
  close(headingFromSample({ alpha: 90, beta: 90, gamma: 0, absolute: true }), 270);
  assert.equal(headingFromSample({ ...base, absolute: true }), null);
  assert.equal(headingFromSample({ ...base, absolute: true, alpha: Number.NaN }), null);
});

// ─── Errores ───

test("geoErrorCodeFromPositionError mapea los códigos del navegador", () => {
  assert.equal(geoErrorCodeFromPositionError(1), "denied");
  assert.equal(geoErrorCodeFromPositionError(1, "User denied Geolocation"), "denied");
  assert.equal(geoErrorCodeFromPositionError(1, "Only secure origins are allowed (see: https://goo.gl/Y0ZkNV)."), "insecure");
  assert.equal(geoErrorCodeFromPositionError(2), "unavailable");
  assert.equal(geoErrorCodeFromPositionError(3), "timeout");
  assert.equal(geoErrorCodeFromPositionError(99), "unavailable");
});

test("toGeoError normaliza y usa mensajes en español", () => {
  const e1 = toGeoError({ code: 1, message: "User denied" });
  assert.ok(e1 instanceof GeoError);
  assert.equal(e1.code, "denied");
  assert.equal(e1.message, "Bloqueaste el acceso a tu ubicación. Puedes activarlo en los ajustes del navegador.");
  assert.equal(toGeoError({ code: 2 }).message, "No pudimos obtener tu ubicación. Revisa que el GPS esté activo.");
  assert.equal(toGeoError({ code: 3 }).message, "Se demoró demasiado en encontrar tu ubicación. Intenta de nuevo.");
  assert.equal(toGeoError(new DOMException("x", "AbortError")).code, "aborted");
  assert.equal(toGeoError(new DOMException("x", "SecurityError")).code, "insecure");
  assert.equal(toGeoError(new Error("raro")).code, "unavailable");
  const same = new GeoError("timeout");
  assert.equal(toGeoError(same), same);
  for (const msg of Object.values(GEO_ERROR_MESSAGES)) assert.ok(msg.length > 10);
});

test("toGeoPosition valida coordenadas", () => {
  assert.deepEqual(toGeoPosition({ latitude: -33.45, longitude: -70.66, accuracy: 12 }), {
    lat: -33.45,
    lng: -70.66,
    accuracy_m: 12,
  });
  assert.equal(toGeoPosition({ latitude: Number.NaN, longitude: 0, accuracy: 1 }), null);
  assert.equal(toGeoPosition({ latitude: 91, longitude: 0, accuracy: 1 }), null);
  assert.equal(toGeoPosition({ latitude: 0, longitude: 0, accuracy: -1 }), null);
});

test("normalizePermissionState", () => {
  assert.equal(normalizePermissionState("granted"), "granted");
  assert.equal(normalizePermissionState("prompt"), "prompt");
  assert.equal(normalizePermissionState("denied"), "denied");
  assert.equal(normalizePermissionState(undefined), "unknown");
});

// ─── Estrategia de getPosition con un Geolocation falso ───

type Outcome =
  | { ok: { latitude: number; longitude: number; accuracy: number } }
  | { err: number }
  | "never";

function fakeGeo(outcomes: Outcome[]): { geo: GeolocationLike; calls: PositionOptions[] } {
  const calls: PositionOptions[] = [];
  const geo: GeolocationLike = {
    getCurrentPosition(success, error, options) {
      calls.push(options ?? {});
      const o = outcomes[calls.length - 1] ?? "never";
      if (o === "never") return;
      setTimeout(() => {
        if ("ok" in o) success({ coords: o.ok, timestamp: Date.now() } as unknown as GeolocationPosition);
        else error?.({ code: o.err, message: "" } as GeolocationPositionError);
      }, 1);
    },
  };
  return { geo, calls };
}
const SCL = { latitude: -33.45, longitude: -70.66, accuracy: 8 };

test("getPositionFrom: éxito al primer intento con alta precisión", async () => {
  const { geo, calls } = fakeGeo([{ ok: SCL }]);
  const pos = await getPositionFrom(geo, { timeoutMs: 500 });
  assert.deepEqual(pos, { lat: -33.45, lng: -70.66, accuracy_m: 8 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].enableHighAccuracy, true);
  assert.equal(calls[0].timeout, 500);
  assert.equal(calls[0].maximumAge, 0);
});

test("getPositionFrom: timeout → un reintento con baja precisión y caché", async () => {
  const { geo, calls } = fakeGeo([{ err: 3 }, { ok: { ...SCL, accuracy: 900 } }]);
  const pos = await getPositionFrom(geo, { timeoutMs: 500 });
  assert.equal(pos.accuracy_m, 900);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].enableHighAccuracy, false);
  assert.ok((calls[1].maximumAge ?? 0) >= 60_000);
});

test("getPositionFrom: dos timeouts → GeoError timeout (sin tercer intento)", async () => {
  const { geo, calls } = fakeGeo([{ err: 3 }, { err: 3 }, { ok: SCL }]);
  await assert.rejects(getPositionFrom(geo, { timeoutMs: 500 }), (e: unknown) => {
    assert.ok(e instanceof GeoError);
    assert.equal(e.code, "timeout");
    return true;
  });
  assert.equal(calls.length, 2);
});

test("getPositionFrom: permiso denegado no reintenta", async () => {
  const { geo, calls } = fakeGeo([{ err: 1 }, { ok: SCL }]);
  await assert.rejects(getPositionFrom(geo), (e: unknown) => e instanceof GeoError && e.code === "denied");
  assert.equal(calls.length, 1);
});

test("getPositionFrom: sin alta precisión no hay respaldo", async () => {
  const { geo, calls } = fakeGeo([{ err: 3 }, { ok: SCL }]);
  await assert.rejects(getPositionFrom(geo, { highAccuracy: false }), (e: unknown) => e instanceof GeoError && e.code === "timeout");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].enableHighAccuracy, false);
});

test("getPositionFrom: abortar rechaza con aborted aunque el navegador no responda", async () => {
  const { geo } = fakeGeo(["never"]);
  const ctrl = new AbortController();
  const p = getPositionFrom(geo, { signal: ctrl.signal });
  setTimeout(() => ctrl.abort(), 5);
  await assert.rejects(p, (e: unknown) => e instanceof GeoError && e.code === "aborted");
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(getPositionFrom(geo, { signal: pre.signal }), (e: unknown) => e instanceof GeoError && e.code === "aborted");
});

test("getPositionFrom: coordenadas inválidas → unavailable, luego respaldo", async () => {
  const { geo, calls } = fakeGeo([{ ok: { latitude: Number.NaN, longitude: 0, accuracy: 5 } }, { ok: SCL }]);
  const pos = await getPositionFrom(geo);
  assert.equal(pos.lat, -33.45);
  assert.equal(calls.length, 2);
});

test("clampDelayMs: NaN → valor por defecto; Infinity y enormes → tope de setTimeout", () => {
  assert.equal(clampDelayMs(undefined, 1500), 1500);
  assert.equal(clampDelayMs(Number.NaN, 1500), 1500);
  assert.equal(clampDelayMs(Number.POSITIVE_INFINITY, 1500), MAX_TIMER_MS);
  assert.equal(clampDelayMs(1e12, 0), MAX_TIMER_MS);
  assert.equal(clampDelayMs(-5, 0, 1), 1);
  assert.equal(clampDelayMs(700, 0), 700);
});

test("getPositionFrom: timeoutMs Infinity no dispara el vigilante de inmediato", async () => {
  const { geo, calls } = fakeGeo([{ ok: SCL }]);
  const pos = await getPositionFrom(geo, { timeoutMs: Number.POSITIVE_INFINITY, maximumAgeMs: Number.NaN });
  assert.equal(pos.lat, -33.45);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].timeout, MAX_TIMER_MS);
  assert.equal(calls[0].maximumAge, 0);
});

test("getPositionFrom: timeoutMs NaN usa el valor por defecto (no 0)", async () => {
  const { geo, calls } = fakeGeo([{ ok: SCL }]);
  await getPositionFrom(geo, { timeoutMs: Number.NaN });
  assert.equal(calls[0].timeout, DEFAULT_GEO_TIMEOUT_MS);
});

test("getPositionFrom: si el navegador nunca responde, el vigilante corta y hay un solo respaldo", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { geo, calls } = fakeGeo(["never", "never"]);
  const p = getPositionFrom(geo, { timeoutMs: 1000 });
  let settled = false;
  p.catch(() => {}).finally(() => {
    settled = true;
  });
  const flush = () => new Promise<void>((r) => setImmediate(r));
  t.mock.timers.tick(1000 + WATCHDOG_GRACE_MS - 1);
  await flush();
  assert.equal(calls.length, 1, "aún no se rinde");
  t.mock.timers.tick(1);
  await flush();
  assert.equal(calls.length, 2, "reintento con baja precisión");
  assert.equal(calls[1].enableHighAccuracy, false);
  assert.equal(settled, false);
  t.mock.timers.tick(1000 + WATCHDOG_GRACE_MS);
  await assert.rejects(p, (e: unknown) => e instanceof GeoError && e.code === "timeout");
  assert.equal(calls.length, 2);
});

// ─── Sin navegador (SSR/node) ───

test("en node: getPosition rechaza unsupported, watch avisa y la brújula da null", async () => {
  await assert.rejects(getPosition(), (e: unknown) => e instanceof GeoError && e.code === "unsupported");
  const errors: string[] = [];
  const stop = watchPosition(
    () => assert.fail("no debería llegar posición"),
    (e) => errors.push(e.code),
  );
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(errors, ["unsupported"]);
  stop();
  const stopped: string[] = [];
  watchPosition(() => {}, (e) => stopped.push(e.code))();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(stopped, [], "detener antes de la microtarea silencia el error");
  assert.equal(await getCompassHeading(), null);
  assert.equal(await queryGeolocationPermission(), null);
});

// ─── collectHeading con un EventTarget de node ───

function orientationEvent(type: string, fields: Record<string, unknown>): Event {
  return Object.assign(new Event(type), fields);
}

test("collectHeading promedia las primeras lecturas válidas y quita los listeners", async () => {
  const target = new EventTarget();
  const p = collectHeading(target, ["deviceorientation", "deviceorientationabsolute"], { samples: 3, timeoutMs: 1000 });
  target.dispatchEvent(orientationEvent("deviceorientation", { alpha: 10, beta: 90, gamma: 0, absolute: false }));
  target.dispatchEvent(orientationEvent("deviceorientationabsolute", { alpha: 10, beta: 90, gamma: 0, absolute: true })); // 350
  target.dispatchEvent(orientationEvent("deviceorientationabsolute", { alpha: 350, beta: 90, gamma: 0, absolute: true })); // 10
  target.dispatchEvent(orientationEvent("deviceorientation", { alpha: 0, beta: 0, gamma: 0, absolute: false, webkitCompassHeading: 0 }));
  close(await p, 0);
  // Ya no escucha: otro evento no hace nada (no debe lanzar ni cambiar nada).
  target.dispatchEvent(orientationEvent("deviceorientationabsolute", { alpha: 90, beta: 90, gamma: 0, absolute: true }));
});

test("collectHeading: timeout sin lecturas → null; con una lectura → esa", async () => {
  assert.equal(await collectHeading(new EventTarget(), ["deviceorientation"], { timeoutMs: 10 }), null);
  const target = new EventTarget();
  const p = collectHeading(target, ["deviceorientation"], { timeoutMs: 20, samples: 5 });
  target.dispatchEvent(orientationEvent("deviceorientation", { alpha: null, beta: null, gamma: null, absolute: false, webkitCompassHeading: 77 }));
  close(await p, 77);
});

test("collectHeading: samples NaN usa el valor por defecto y responde antes del plazo", async () => {
  const target = new EventTarget();
  const p = collectHeading(target, ["deviceorientation"], { timeoutMs: 60_000, samples: Number.NaN });
  for (const h of [10, 20, 30]) {
    target.dispatchEvent(orientationEvent("deviceorientation", { alpha: null, beta: null, gamma: null, absolute: false, webkitCompassHeading: h }));
  }
  close(await p, 20);
});

test("collectHeading: quita exactamente los listeners que puso (lecturas, timeout y abort)", async () => {
  class CountingTarget extends EventTarget {
    active = 0;
    override addEventListener(...args: Parameters<EventTarget["addEventListener"]>) {
      this.active++;
      super.addEventListener(...args);
    }
    override removeEventListener(...args: Parameters<EventTarget["removeEventListener"]>) {
      this.active--;
      super.removeEventListener(...args);
    }
  }
  const types = ["deviceorientation", "deviceorientationabsolute"];
  const a = new CountingTarget();
  const pa = collectHeading(a, types, { samples: 1, timeoutMs: 1000 });
  assert.equal(a.active, 2);
  a.dispatchEvent(orientationEvent("deviceorientation", { alpha: null, beta: null, gamma: null, absolute: false, webkitCompassHeading: 5 }));
  await pa;
  assert.equal(a.active, 0);
  const b = new CountingTarget();
  await collectHeading(b, types, { timeoutMs: 5 });
  assert.equal(b.active, 0);
  const c = new CountingTarget();
  const ctrl = new AbortController();
  const pc = collectHeading(c, types, { timeoutMs: 1000, signal: ctrl.signal });
  ctrl.abort();
  await pc;
  assert.equal(c.active, 0);
});

test("collectHeading: abort → null", async () => {
  const target = new EventTarget();
  const ctrl = new AbortController();
  const p = collectHeading(target, ["deviceorientation"], { timeoutMs: 1000, signal: ctrl.signal });
  target.dispatchEvent(orientationEvent("deviceorientation", { alpha: null, beta: null, gamma: null, absolute: false, webkitCompassHeading: 77 }));
  ctrl.abort();
  assert.equal(await p, null);
});
