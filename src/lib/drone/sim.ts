/**
 * Simulador de vuelo de dron. Función pura y determinista (servidor y cliente).
 *
 * El estado sale SOLO de la misión (estado, orden, último punto, plan) y del instante pedido:
 * misma misión + mismo `nowMs` → mismo resultado. Toda la telemetría que produce es simulada.
 *
 * Fases: planned → launching (ascenso vertical) → en_route (vuelo a la entrada del patrón)
 * → on_station (órbita / punto fijo / barrido) → returning (orden del mando o batería baja)
 * → landed. La orden "abort" detiene todo de inmediato → aborted.
 */
import type {
  DroneMission,
  MissionStatus,
  TelemetryPoint,
  TimelineSeverity,
} from "@/lib/domain";
import {
  bearingDeg,
  destination,
  distanceM,
  normalizeDeg,
  toLatLng,
  toLocal,
  type LatLng,
  type LocalXY,
} from "@/lib/geo";

export interface SimEvent {
  at: string;
  severity: TimelineSeverity;
  title: string;
  detail: string;
}

export interface SimResult {
  points: TelemetryPoint[];
  status: MissionStatus;
  started_at: string | null;
  ended_at: string | null;
  events: SimEvent[];
}

/**
 * Salto máximo de tiempo simulado por llamada. Si pasó más que esto desde el último punto
 * (pestaña oculta, mando cerrado), la simulación estuvo en PAUSA: retoma desde el último estado
 * con un solo paso que termina ahora, sin "teletransportarse" ni ponerse al día a toda velocidad.
 */
export const MAX_STEP_MS = 10_000;
/** Un punto de telemetría cada este tiempo simulado. */
export const SAMPLE_MS = 2_000;
export const CLIMB_RATE_MS = 3;
export const DESCENT_RATE_MS = 2;
/** −1 % cada 20 s en el aire. */
export const BATTERY_DRAIN_PCT_PER_S = 1 / 20;
export const LOW_BATTERY_PCT = 25;

// La batería se publica redondeada a 0,1: "< 25 %" en la lectura ⇔ valor bruto ≤ 24,95.
const LOW_RAW_PCT = LOW_BATTERY_PCT - 0.05;
const EPS_M = 0.05;
const EPS_PCT = 1e-6;
const MAX_ITERATIONS = 1_000;
// Valores por defecto de CreateMissionInputSchema, por si una misión trae datos no finitos.
const DEFAULT_SPEED_MS = 8;
const DEFAULT_ALTITUDE_M = 45;

type FlightStatus = "launching" | "en_route" | "on_station" | "returning";

interface State {
  t: number;
  pos: LocalXY;
  alt: number;
  heading: number;
  speed: number;
  status: FlightStatus | "landed";
  /** Barrido: índice del próximo waypoint. */
  wpIndex: number | null;
}

interface Ctx {
  m: DroneMission;
  center: LatLng;
  home: LocalXY;
  wps: LocalXY[];
  entry: LocalXY;
  speed: number;
  /** Radio de órbita saneado; 0 = se comporta como punto fijo. */
  radius: number;
  altitude: number;
  batteryAt: (t: number) => number;
  /** Instante en que la batería baja del umbral (puede ser anterior al último punto). */
  lowAt: number;
  /** Instante (ms enteros) del último punto emitido: el siguiente debe ser posterior. */
  prevMs: number;
  events: SimEvent[];
}

const iso = (ms: number) => new Date(Math.round(ms)).toISOString();
const round1 = (v: number) => Math.round(v * 10) / 10;
const distXY = (a: LocalXY, b: LocalXY) => Math.hypot(b.x - a.x, b.y - a.y);
const bearingXY = (a: LocalXY, b: LocalXY) =>
  normalizeDeg((Math.atan2(b.x - a.x, b.y - a.y) * 180) / Math.PI);

function headingOut(h: number): number {
  const r = round1(normalizeDeg(h));
  return r >= 360 ? 0 : r;
}

function homeOf(m: DroneMission): LatLng {
  return { lat: m.home_lat, lng: m.home_lng };
}

/** Punto donde el dron entra al patrón: órbita → punto del círculo más cercano al despegue. */
function entryPoint(m: DroneMission, center: LatLng, wps: LocalXY[], radius: number): LocalXY {
  if (m.pattern === "grid" && wps.length > 0) return wps[0];
  if (m.pattern === "orbit" && radius > 0) {
    const home = homeOf(m);
    const b = distanceM(center, home) < 1 ? 180 : bearingDeg(center, home);
    return toLocal(center, destination(center, b, radius));
  }
  return { x: 0, y: 0 };
}

const finiteOr = (v: number, fallback: number) => (Number.isFinite(v) ? v : fallback);

function event(c: Ctx, t: number, severity: TimelineSeverity, title: string, detail: string): void {
  c.events.push({ at: iso(t), severity, title, detail });
}

function pct(v: number): string {
  return `${Math.round(v)} %`;
}

function onStationTitle(m: DroneMission): string {
  if (m.pattern === "hover") return `Dron ${m.label} en posición — sobre el incidente`;
  if (m.pattern === "grid") return `Dron ${m.label} en posición — iniciando barrido`;
  return `Dron ${m.label} en posición — orbitando a ${Math.round(m.radius_m)} m del incidente`;
}

/** Barrido: deduce el próximo waypoint desde la posición y el rumbo del último punto. */
function deriveGridIndex(pos: LocalXY, heading: number, wps: LocalXY[]): number {
  const n = wps.length;
  const segs = wps.map((a, i) => {
    const b = wps[(i + 1) % n];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const u = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((pos.x - a.x) * dx + (pos.y - a.y) * dy) / len2));
    const d = Math.hypot(pos.x - (a.x + u * dx), pos.y - (a.y + u * dy));
    const turn = Math.abs(((bearingXY(a, b) - heading + 540) % 360) - 180);
    return { next: (i + 1) % n, d, turn };
  });
  const best = Math.min(...segs.map((s) => s.d));
  // Tramos que se cruzan (la diagonal de regreso cruza las pasadas): desempata el rumbo.
  const near = segs.filter((s) => s.d <= best + 1);
  near.sort((a, b) => a.turn - b.turn);
  return near[0].next;
}

function isLow(c: Ctx, t: number): boolean {
  return c.batteryAt(t) <= LOW_RAW_PCT + EPS_PCT;
}

function toReturning(s: State, c: Ctx, severity: TimelineSeverity, title: string, detail: string) {
  s.status = "returning";
  s.wpIndex = null;
  event(c, s.t, severity, title, detail);
}

const isFlying = (s: State) => s.status === "launching" || s.status === "en_route" || s.status === "on_station";

/** Batería bajo el umbral: retorno en el instante exacto en que ocurre. */
function applyBattery(s: State, c: Ctx): void {
  if (!isFlying(s) || !isLow(c, s.t)) return;
  toReturning(
    s,
    c,
    "warning",
    `Dron ${c.m.label} retornando — batería ${Math.floor(c.batteryAt(s.t))} %`,
    `Batería bajo ${LOW_BATTERY_PCT} %: vuelve al punto de despegue, a ${Math.round(distXY(s.pos, c.home))} m.`,
  );
}

/**
 * Órdenes del mando (retornar / reanudar). Se aplican al final del paso, en el instante del tick:
 * la misión no guarda cuándo se dio la orden, y aplicarla al inicio dejaría el evento antes de la
 * orden misma en la línea de tiempo.
 */
function applyOrder(s: State, c: Ctx): void {
  const { m } = c;
  if (isFlying(s)) {
    if (m.command === "recall") {
      toReturning(
        s,
        c,
        "notice",
        `Dron ${m.label} retornando — orden del mando`,
        `Vuelve al punto de despegue, a ${Math.round(distXY(s.pos, c.home))} m. Batería ${pct(c.batteryAt(s.t))}.`,
      );
    }
  } else if (s.status === "returning" && m.command === "continue" && !isLow(c, s.t)) {
    s.status = "en_route";
    event(
      c,
      s.t,
      "notice",
      `Dron ${m.label} reanuda la misión`,
      `Vuelve hacia el incidente. Batería ${pct(c.batteryAt(s.t))}.`,
    );
  }
}

/** Ascenso vertical hasta la altura de la misión. true si la alcanzó dentro del plazo. */
function climb(s: State, c: Ctx, limit: number): boolean {
  const need = c.altitude - s.alt;
  if (need <= EPS_M) {
    s.alt = Math.max(s.alt, c.altitude);
    return true;
  }
  s.speed = CLIMB_RATE_MS;
  const needMs = (need / CLIMB_RATE_MS) * 1000;
  if (s.t + needMs <= limit) {
    s.alt = c.altitude;
    s.t += needMs;
    return true;
  }
  s.alt += (CLIMB_RATE_MS * (limit - s.t)) / 1000;
  s.t = limit;
  return false;
}

/** Vuelo horizontal en línea recta. true si llegó dentro del plazo. */
function flyToward(s: State, target: LocalXY, limit: number, speed: number): boolean {
  const d = distXY(s.pos, target);
  if (d <= EPS_M) {
    s.pos = { ...target };
    return true;
  }
  s.heading = bearingXY(s.pos, target);
  s.speed = speed;
  const needMs = (d / speed) * 1000;
  if (s.t + needMs <= limit) {
    s.pos = { ...target };
    s.t += needMs;
    return true;
  }
  const f = (speed * (limit - s.t)) / 1000 / d;
  s.pos = { x: s.pos.x + (target.x - s.pos.x) * f, y: s.pos.y + (target.y - s.pos.y) * f };
  s.t = limit;
  return false;
}

function stationMove(s: State, c: Ctx, limit: number): void {
  const { m } = c;
  const dtS = (limit - s.t) / 1000;
  if (m.pattern === "orbit" && c.radius > EPS_M) {
    const r = c.radius;
    const cur = Math.hypot(s.pos.x, s.pos.y);
    const theta0 = cur < EPS_M ? Math.atan2(c.entry.x, c.entry.y) : Math.atan2(s.pos.x, s.pos.y);
    // Horario visto desde arriba = rumbo creciente.
    const theta = theta0 + (c.speed / r) * dtS;
    s.pos = { x: r * Math.sin(theta), y: r * Math.cos(theta) };
    s.heading = normalizeDeg((theta * 180) / Math.PI + 180);
    s.speed = c.speed;
  } else if (m.pattern === "grid" && c.wps.length > 1) {
    const n = c.wps.length;
    let idx = s.wpIndex ?? deriveGridIndex(s.pos, s.heading, c.wps);
    let remaining = c.speed * dtS;
    for (let i = 0; i < 4 * n + 4; i++) {
      const target = c.wps[idx];
      const d = distXY(s.pos, target);
      if (d <= remaining + 1e-9) {
        if (d > EPS_M) s.heading = bearingXY(s.pos, target);
        s.pos = { ...target };
        remaining -= d;
        idx = (idx + 1) % n;
        continue;
      }
      if (remaining > 0) {
        s.heading = bearingXY(s.pos, target);
        const f = remaining / d;
        s.pos = { x: s.pos.x + (target.x - s.pos.x) * f, y: s.pos.y + (target.y - s.pos.y) * f };
      }
      break;
    }
    s.wpIndex = idx;
    s.speed = c.speed;
  } else {
    // Punto fijo: quieto sobre el incidente, con la cámara hacia abajo y el mismo rumbo.
    s.speed = 0;
  }
  s.t = limit;
}

function moveOnce(s: State, c: Ctx, limit: number): void {
  const { m } = c;
  switch (s.status) {
    case "launching": {
      if (climb(s, c, limit)) s.status = "en_route";
      return;
    }
    case "en_route": {
      // Tras reanudar desde el descenso, primero recupera altura.
      if (s.alt < c.altitude - EPS_M) {
        climb(s, c, limit);
        return;
      }
      if (flyToward(s, c.entry, limit, c.speed)) {
        s.status = "on_station";
        s.wpIndex = m.pattern === "grid" && c.wps.length > 1 ? 1 % c.wps.length : null;
        if (m.pattern === "hover") s.speed = 0;
        event(
          c,
          s.t,
          "info",
          onStationTitle(m),
          `Altura ${Math.round(s.alt)} m · batería ${pct(c.batteryAt(s.t))} · telemetría simulada.`,
        );
      }
      return;
    }
    case "on_station": {
      stationMove(s, c, limit);
      return;
    }
    case "returning": {
      if (distXY(s.pos, c.home) > EPS_M) {
        flyToward(s, c.home, limit, c.speed);
        return;
      }
      s.pos = { ...c.home };
      s.speed = DESCENT_RATE_MS;
      const needMs = (Math.max(0, s.alt) / DESCENT_RATE_MS) * 1000;
      if (s.t + needMs <= limit) {
        // ms enteros y siempre después del punto anterior (el aterrizaje emite su propio punto).
        s.t = Math.min(limit, Math.max(c.prevMs + 1, Math.ceil(s.t + needMs)));
        s.alt = 0;
        s.speed = 0;
        s.status = "landed";
        event(
          c,
          s.t,
          "info",
          `Dron ${m.label} aterrizó`,
          `Aterrizaje en el punto de despegue. Batería ${pct(c.batteryAt(s.t))}.`,
        );
        return;
      }
      s.alt -= (DESCENT_RATE_MS * (limit - s.t)) / 1000;
      s.t = limit;
      return;
    }
    case "landed":
      return;
  }
}

function runUntil(s: State, c: Ctx, until: number): void {
  for (let i = 0; i < MAX_ITERATIONS && s.status !== "landed"; i++) {
    applyBattery(s, c);
    if (s.t >= until) return;
    let limit = until;
    if (s.status !== "returning" && c.lowAt > s.t) limit = Math.min(limit, c.lowAt);
    moveOnce(s, c, limit);
  }
  if (s.status !== "landed") s.t = until;
}

function snapshot(s: State, c: Ctx): TelemetryPoint {
  const ll = toLatLng(c.center, s.pos);
  return {
    at: iso(s.t),
    lat: ll.lat,
    lng: ll.lng,
    alt_m: round1(Math.max(0, s.alt)),
    heading_deg: headingOut(s.heading),
    speed_ms: round1(Math.max(0, s.speed)),
    battery_pct: round1(c.batteryAt(s.t)),
  };
}

interface BatteryModel {
  at: (t: number) => number;
  /** Instante en que el valor bruto llega al umbral de batería baja. */
  lowAt: number;
}

const drainPct = (ms: number) => (BATTERY_DRAIN_PCT_PER_S * ms) / 1000;
const anchoredPct = (atTakeoff: number, startedMs: number, t: number) =>
  Math.max(0, atTakeoff - drainPct(t - startedMs));

/**
 * Batería como recta desde el despegue. La lectura guardada está redondeada a 0,1: si se
 * descontara desde ella en cada tick, el redondeo se acumularía con ticks irregulares (2,3 s
 * consumen 0,115 y se guardan como 0,1). Por eso se deduce la carga al despegar, en la misma
 * grilla de 0,1, que reproduce exactamente la lectura; sin despegue conocido, se usa la lectura.
 */
function batteryModel(m: DroneMission, last: TelemetryPoint, lastMs: number): BatteryModel {
  const startedMs = m.started_at ? Date.parse(m.started_at) : Number.NaN;
  const known = Number.isFinite(startedMs) && startedMs <= lastMs;
  const reading = last.battery_pct;
  const anchored = (atTakeoff: number): BatteryModel => ({
    at: (t) => anchoredPct(atTakeoff, startedMs, t),
    lowAt: startedMs + ((atTakeoff - LOW_RAW_PCT) / BATTERY_DRAIN_PCT_PER_S) * 1000,
  });
  if (reading === null || !Number.isFinite(reading)) {
    if (known) return anchored(100);
    return { at: () => 100, lowAt: Number.POSITIVE_INFINITY };
  }
  const r = Math.max(0, Math.min(100, reading));
  if (known && r > 0) {
    const guess = round1(r + drainPct(lastMs - startedMs));
    for (const d of [0, -0.1, 0.1]) {
      const cand = round1(guess + d);
      if (round1(anchoredPct(cand, startedMs, lastMs)) === round1(r)) return anchored(cand);
    }
  }
  return {
    at: (t) => Math.max(0, r - drainPct(t - lastMs)),
    lowAt: lastMs + ((r - LOW_RAW_PCT) / BATTERY_DRAIN_PCT_PER_S) * 1000,
  };
}

function takeoff(mission: DroneMission, center: LatLng, nowMs: number): SimResult {
  const home = homeOf(mission);
  const at = iso(nowMs);
  if (mission.command === "recall") {
    return {
      points: [],
      status: "landed",
      started_at: mission.started_at,
      ended_at: at,
      events: [
        {
          at,
          severity: "notice",
          title: `Dron ${mission.label} no despegó — orden del mando`,
          detail: "La orden de retorno llegó antes del despegue; la misión queda cerrada.",
        },
      ],
    };
  }
  const point: TelemetryPoint = {
    at,
    lat: home.lat,
    lng: home.lng,
    alt_m: 0,
    heading_deg: headingOut(distanceM(home, center) < 1 ? 0 : bearingDeg(home, center)),
    speed_ms: 0,
    battery_pct: 100,
  };
  const launching = mission.status === "planned";
  return {
    points: [point],
    status: launching ? "launching" : mission.status,
    started_at: mission.started_at ?? at,
    ended_at: mission.ended_at,
    events: launching
      ? [
          {
            at,
            severity: "info",
            title: `Dron ${mission.label} despegó`,
            detail: `Despegue simulado a ${Math.round(distanceM(home, center))} m del incidente. Batería 100 %.`,
          },
        ]
      : [],
  };
}

export function advance(mission: DroneMission, center: LatLng, nowMs: number): SimResult {
  const unchanged: SimResult = {
    points: [],
    status: mission.status,
    started_at: mission.started_at,
    ended_at: mission.ended_at,
    events: [],
  };
  const status = mission.status;
  if (status === "landed" || status === "aborted") return unchanged;

  if (mission.command === "abort") {
    const last = mission.last;
    // Con un reloj atrasado, la misión no puede cerrarse antes de su último punto.
    const lastAt = last ? Date.parse(last.at) : Number.NaN;
    const at = iso(Number.isFinite(lastAt) ? Math.max(nowMs, lastAt) : nowMs);
    return {
      points: [],
      status: "aborted",
      started_at: mission.started_at,
      ended_at: at,
      events: [
        {
          at,
          severity: "warning",
          title: `Dron ${mission.label} abortado por el mando`,
          detail: last
            ? `Vuelo detenido de inmediato a ${Math.round(distanceM(center, last))} m del incidente y ${Math.round(last.alt_m)} m de altura.`
            : "La misión se canceló antes del despegue.",
        },
      ],
    };
  }

  const last = mission.last;
  if (!last) return takeoff(mission, center, nowMs);

  const lastAtMs = Date.parse(last.at);
  const gap = nowMs - lastAtMs;
  if (!Number.isFinite(gap) || gap < 1) return unchanged;
  // Pausa: el último estado se toma como si fuera de hace un paso. Así la traza no queda horas
  // atrás ("sin señal") y la batería no se descuenta por el tiempo en que nadie miraba.
  const lastMs = gap > MAX_STEP_MS ? Math.floor(nowMs) - SAMPLE_MS : lastAtMs;
  // ms enteros: un `nowMs` fraccionario no puede producir un punto con el mismo instante que el último.
  const dt = Math.floor(Math.min(nowMs - lastMs, MAX_STEP_MS));
  if (!Number.isFinite(dt) || dt < 1) return unchanged;

  const wps = mission.waypoints.map((w) => toLocal(center, w));
  const radius = Math.max(0, finiteOr(mission.radius_m, 0));
  const battery = batteryModel(mission, last, lastMs);
  const c: Ctx = {
    m: mission,
    center,
    home: toLocal(center, homeOf(mission)),
    wps,
    entry: entryPoint(mission, center, wps, radius),
    speed: Math.max(0.1, finiteOr(mission.speed_ms, DEFAULT_SPEED_MS)),
    radius,
    altitude: Math.max(0, finiteOr(mission.altitude_m, DEFAULT_ALTITUDE_M)),
    batteryAt: battery.at,
    lowAt: battery.lowAt,
    prevMs: lastMs,
    events: [],
  };

  let startedAt = mission.started_at;
  const s: State = {
    t: lastMs,
    pos: toLocal(center, last),
    alt: last.alt_m,
    heading: last.heading_deg,
    speed: last.speed_ms ?? 0,
    status: status === "planned" ? "launching" : status,
    wpIndex: null,
  };
  if (status === "planned") {
    startedAt = startedAt ?? iso(lastMs);
    event(c, lastMs, "info", `Dron ${mission.label} despegó`, "Despegue simulado. Telemetría generada.");
  }

  const endMs = lastMs + dt;
  const points: TelemetryPoint[] = [];
  for (let k = 1; ; k++) {
    const ts = Math.min(lastMs + k * SAMPLE_MS, endMs);
    runUntil(s, c, ts);
    points.push(snapshot(s, c));
    c.prevMs = s.t;
    if (s.status === "landed" || ts >= endMs) break;
  }
  if (s.status !== "landed") applyOrder(s, c);

  return {
    points,
    status: s.status,
    started_at: startedAt,
    ended_at: s.status === "landed" ? iso(s.t) : mission.ended_at,
    events: c.events,
  };
}

/**
 * Segundos (simulados) que le faltan a una misión simulada para quedar en posición, avanzando
 * en pasos de SAMPLE_MS como lo haría el tick. 0 si ya está en posición; null si no llegará
 * (terminada, retornando, abortada) o si tarda más de `maxS`.
 */
export function secondsUntilOnStation(mission: DroneMission, center: LatLng, nowMs: number, maxS = 120): number | null {
  if (mission.status === "on_station") return 0;
  if (mission.status !== "planned" && mission.status !== "launching" && mission.status !== "en_route") return null;
  if (mission.command !== "continue") return null;
  let m = mission;
  // Desde el último punto (o desde ahora si aún no despega), sin pausas.
  const startMs = m.last ? Date.parse(m.last.at) : nowMs;
  if (!Number.isFinite(startMs)) return null;
  for (let t = startMs + (m.last ? SAMPLE_MS : 0); t <= startMs + maxS * 1000; t += SAMPLE_MS) {
    const r = advance(m, center, t);
    if (r.status === "on_station") return Math.max(0, (t - nowMs) / 1000);
    if (r.status !== "launching" && r.status !== "en_route" && r.status !== "planned") return null;
    const last = r.points.length > 0 ? r.points[r.points.length - 1] : m.last;
    m = { ...m, status: r.status, started_at: r.started_at, ended_at: r.ended_at, last };
  }
  return null;
}
