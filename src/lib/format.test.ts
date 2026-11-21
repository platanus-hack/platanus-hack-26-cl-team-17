import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_VALUE,
  formatBytes,
  formatClock,
  formatCoord,
  formatDate,
  formatDateTime,
  formatDistance,
  formatDuration,
  formatElapsed,
  formatHeading,
  formatNumber,
  formatPercent,
  pluralize,
  timeAgo,
} from "@/lib/format";

// Las fechas se construyen en hora local, así las pruebas no dependen de la zona horaria del equipo.
const local = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) =>
  new Date(y, mo - 1, d, h, mi, s);

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

test("formatClock: 24 h con y sin segundos", () => {
  const d = local(2026, 11, 21, 14, 5, 9);
  assert.equal(formatClock(d), "14:05:09");
  assert.equal(formatClock(d, { seconds: false }), "14:05");
  assert.equal(formatClock(d.getTime()), "14:05:09");
  assert.equal(formatClock(d.toISOString()), "14:05:09");
  assert.equal(formatClock(local(2026, 1, 1, 0, 0, 0)), "00:00:00");
  assert.equal(formatClock("no es fecha"), EMPTY_VALUE);
});

test("formatDate y formatDateTime: dd-mm-aaaa", () => {
  const d = local(2026, 3, 7, 9, 4, 2);
  assert.equal(formatDate(d), "07-03-2026");
  assert.equal(formatDateTime(d), "07-03-2026 09:04");
  assert.equal(formatDateTime(d, { seconds: true }), "07-03-2026 09:04:02");
  assert.equal(formatDateTime(d.toISOString()), "07-03-2026 09:04");
  assert.equal(formatDate(Number.NaN), EMPTY_VALUE);
  assert.equal(formatDateTime(""), EMPTY_VALUE);
});

test("formatElapsed: HH:MM:SS, horas sobre 99 y negativos", () => {
  const from = local(2026, 11, 21, 10, 0, 0);
  assert.equal(formatElapsed(from, from.getTime() + 12 * MIN + 47 * SEC), "00:12:47");
  assert.equal(formatElapsed(from.toISOString(), from.getTime() + 999), "00:00:00");
  assert.equal(formatElapsed(from, from.getTime() + 123 * HOUR + 4 * MIN + 5 * SEC), "123:04:05");
  assert.equal(formatElapsed(from, from.getTime() - 5 * MIN), "00:00:00");
  assert.equal(formatElapsed(from, new Date(from.getTime() + HOUR)), "01:00:00");
  assert.equal(formatElapsed("x", Date.now()), "--:--:--");
});

test("timeAgo: pasado", () => {
  const now = local(2026, 11, 21, 15, 0, 0);
  const ago = (ms: number) => timeAgo(new Date(now.getTime() - ms), now);
  assert.equal(ago(0), "recién");
  assert.equal(ago(9 * SEC), "recién");
  assert.equal(ago(45 * SEC), "hace 45 s");
  assert.equal(ago(60 * SEC), "hace 1 min");
  assert.equal(ago(12 * MIN + 30 * SEC), "hace 12 min");
  assert.equal(ago(HOUR), "hace 1 h");
  assert.equal(ago(3 * HOUR + 59 * MIN), "hace 3 h");
  assert.equal(timeAgo(local(2026, 11, 20, 9, 0, 0), now), "ayer");
  assert.equal(timeAgo(local(2026, 11, 18, 15, 0, 0), now), "hace 3 días");
  assert.equal(timeAgo(local(2026, 11, 10, 8, 0, 0), now), "10-11-2026");
});

test("timeAgo: ayer usa días calendario", () => {
  // 30 h antes, pero dos días calendario atrás.
  const now = local(2026, 11, 21, 2, 0, 0);
  assert.equal(timeAgo(local(2026, 11, 19, 20, 0, 0), now), "hace 2 días");
  assert.equal(timeAgo(local(2026, 11, 20, 1, 0, 0), now), "ayer");
});

test("timeAgo: futuro y entradas inválidas", () => {
  const now = local(2026, 11, 21, 15, 0, 0);
  const ahead = (ms: number) => timeAgo(new Date(now.getTime() + ms), now);
  assert.equal(ahead(5 * SEC), "recién");
  assert.equal(ahead(30 * SEC), "en 30 s");
  assert.equal(ahead(2 * MIN), "en 2 min");
  assert.equal(ahead(5 * HOUR), "en 5 h");
  assert.equal(ahead(3 * 24 * HOUR), formatDate(now.getTime() + 3 * 24 * HOUR));
  assert.equal(timeAgo("nada", now), EMPTY_VALUE);
  assert.equal(timeAgo(now.toISOString(), now.getTime()), "recién");
});

test("formatDistance", () => {
  assert.equal(formatDistance(85), "85 m");
  assert.equal(formatDistance(84.6), "85 m");
  assert.equal(formatDistance(0), "0 m");
  assert.equal(formatDistance(999.4), "999 m");
  assert.equal(formatDistance(999.6), "1,0 km");
  assert.equal(formatDistance(1234), "1,2 km");
  assert.equal(formatDistance(9960), "10 km");
  assert.equal(formatDistance(12_400), "12 km");
  assert.equal(formatDistance(152_700), "153 km");
  assert.equal(formatDistance(-3), "0 m");
  assert.equal(formatDistance(null), EMPTY_VALUE);
  assert.equal(formatDistance(undefined), EMPTY_VALUE);
  assert.equal(formatDistance(Number.NaN), EMPTY_VALUE);
});

test("formatDuration", () => {
  assert.equal(formatDuration(0), "0 s");
  assert.equal(formatDuration(45), "45 s");
  assert.equal(formatDuration(59.6), "1 min 00 s");
  assert.equal(formatDuration(65), "1 min 05 s");
  assert.equal(formatDuration(3599), "59 min 59 s");
  assert.equal(formatDuration(3720), "1 h 02 min");
  assert.equal(formatDuration(3600 * 26 + 60 * 7 + 30), "26 h 07 min");
  assert.equal(formatDuration(-4), "0 s");
  assert.equal(formatDuration(null), EMPTY_VALUE);
  assert.equal(formatDuration(Number.POSITIVE_INFINITY), EMPTY_VALUE);
});

test("formatBytes: base 1024 con coma decimal", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1024), "1 KB");
  assert.equal(formatBytes(1536), "1,5 KB");
  assert.equal(formatBytes(12.3 * 1024 * 1024), "12,3 MB");
  assert.equal(formatBytes(1.02 * 1024 ** 3), "1,02 GB");
  assert.equal(formatBytes(1024 * 1024 - 1), "1 MB");
  assert.equal(formatBytes(250 * 1024 * 1024), "250 MB");
  assert.equal(formatBytes(null), EMPTY_VALUE);
  assert.equal(formatBytes(-1), EMPTY_VALUE);
});

test("formatCoord: punto decimal, copiable a mapas", () => {
  assert.equal(formatCoord(-33.4489, -70.6693), "-33.44890, -70.66930");
  assert.equal(formatCoord(-33.4489, -70.6693, 3), "-33.449, -70.669");
  assert.equal(formatCoord(Number.NaN, 1), EMPTY_VALUE);
});

test("formatNumber y formatPercent (es-CL)", () => {
  assert.equal(formatNumber(12345.6, 1), "12.345,6");
  assert.equal(formatNumber(12345.67), "12.346");
  assert.equal(formatNumber(0.5, 2), "0,50");
  assert.equal(formatNumber(Number.NaN), EMPTY_VALUE);
  assert.equal(formatPercent(0.63), "63 %");
  assert.equal(formatPercent(0.6349, 1), "63,5 %");
  assert.equal(formatPercent(1), "100 %");
  assert.equal(formatPercent(Number.NaN), EMPTY_VALUE);
});

test("pluralize", () => {
  assert.equal(pluralize(1, "video"), "1 video");
  assert.equal(pluralize(3, "video"), "3 videos");
  assert.equal(pluralize(0, "video"), "0 videos");
  assert.equal(pluralize(2, "dron", "drones"), "2 drones");
  assert.equal(pluralize(1, "dron", "drones"), "1 dron");
  assert.equal(pluralize(12000, "fotograma"), "12.000 fotogramas");
  assert.equal(pluralize(1.5, "hora"), "1,5 horas");
});

test("formatHeading: 8 rumbos en español", () => {
  assert.equal(formatHeading(0), "0° N");
  assert.equal(formatHeading(45), "45° NE");
  assert.equal(formatHeading(90), "90° E");
  assert.equal(formatHeading(200), "200° S");
  assert.equal(formatHeading(225), "225° SO");
  assert.equal(formatHeading(270), "270° O");
  assert.equal(formatHeading(316), "316° NO");
  assert.equal(formatHeading(359.6), "0° N");
  assert.equal(formatHeading(360), "0° N");
  assert.equal(formatHeading(725), "5° N");
  assert.equal(formatHeading(-1), EMPTY_VALUE);
  assert.equal(formatHeading(null), EMPTY_VALUE);
  assert.equal(formatHeading(undefined), EMPTY_VALUE);
});
