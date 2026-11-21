import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LOGIN_FAILURE_WINDOW_MS,
  LOGIN_MAX_FAILURES,
  assertLoginAllowed,
  clearLoginFailures,
  recordLoginFailure,
} from "./login-throttle";

const T0 = 1_000_000;

test("los intentos correctos no cuentan: nunca bloquean", () => {
  const email = "admin@vigia.local";
  for (let i = 0; i < LOGIN_MAX_FAILURES * 3; i++) {
    assertLoginAllowed(email, T0 + i);
    clearLoginFailures(email); // lo que hace la ruta tras un login correcto
  }
});

test("bloquea al llegar al máximo de fallos y solo a ese correo", () => {
  const email = "bloqueo@vigia.local";
  for (let i = 0; i < LOGIN_MAX_FAILURES; i++) {
    assertLoginAllowed(email, T0);
    recordLoginFailure(email, T0);
  }
  assert.throws(() => assertLoginAllowed(email, T0 + 1), { status: 429, code: "rate_limited" });
  assertLoginAllowed("otro@vigia.local", T0 + 1);
});

test("la ventana vence y el contador parte de nuevo", () => {
  const email = "ventana@vigia.local";
  for (let i = 0; i < LOGIN_MAX_FAILURES; i++) recordLoginFailure(email, T0);
  assert.throws(() => assertLoginAllowed(email, T0 + LOGIN_FAILURE_WINDOW_MS - 1), { status: 429 });
  assertLoginAllowed(email, T0 + LOGIN_FAILURE_WINDOW_MS);
  recordLoginFailure(email, T0 + LOGIN_FAILURE_WINDOW_MS);
  assertLoginAllowed(email, T0 + LOGIN_FAILURE_WINDOW_MS + 1);
});

test("un login correcto limpia los fallos acumulados", () => {
  const email = "limpia@vigia.local";
  for (let i = 0; i < LOGIN_MAX_FAILURES - 1; i++) recordLoginFailure(email, T0);
  clearLoginFailures(email);
  for (let i = 0; i < LOGIN_MAX_FAILURES - 1; i++) recordLoginFailure(email, T0);
  assertLoginAllowed(email, T0);
});
