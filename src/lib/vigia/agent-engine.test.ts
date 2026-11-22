/**
 * Plan B de Vigía cuando Claude anda lento o caído: tras un fallo, plantillas directo por un
 * rato (sin volver a esperar los tiempos completos), y "Vigía sin IA" desde la mesa.
 */
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { agentEngine, CLAUDE_COOLDOWN_MS, claudeDownUntil, markClaudeDown, REQUEST_MAX_RETRIES, REQUEST_TIMEOUT_MS, turnEngine } from "./agent";

const saved = { key: process.env.ANTHROPIC_API_KEY, mode: process.env.VIGIA_AI };
beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "sk-ant-prueba";
  delete process.env.VIGIA_AI;
  markClaudeDown(null);
});
afterEach(() => {
  markClaudeDown(null);
  if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = saved.key;
  if (saved.mode === undefined) delete process.env.VIGIA_AI;
  else process.env.VIGIA_AI = saved.mode;
});

const NOW = Date.parse("2026-11-21T19:00:00.000Z");

test("con Claude colgado cae a plantillas en ~30 s, no en ~2 min", () => {
  assert.ok(REQUEST_TIMEOUT_MS * (REQUEST_MAX_RETRIES + 1) <= 30_000);
});

test("tras un fallo de Claude, las vueltas siguientes van directo a plantillas y después se vuelve a probar", () => {
  const state = { ai_off: false };
  assert.equal(turnEngine(state, NOW), "claude");
  markClaudeDown(NOW);
  assert.equal(claudeDownUntil(), NOW + CLAUDE_COOLDOWN_MS);
  assert.equal(turnEngine(state, NOW + 5_000), "plantilla");
  assert.equal(turnEngine(state, NOW + CLAUDE_COOLDOWN_MS - 1), "plantilla");
  assert.equal(turnEngine(state, NOW + CLAUDE_COOLDOWN_MS + 1), "claude", "pasada la pausa vuelve a probar");
  // La mesa sigue viendo el motor configurado: la pausa es de este proceso, el aviso va por last_error.
  assert.equal(agentEngine(state), "claude");
  markClaudeDown(null);
  assert.equal(turnEngine(state, NOW + 5_000), "claude", "una vuelta que sale bien lo rehabilita");
});

test("«Vigía sin IA» desde la mesa: plantillas aunque haya llave; sin llave siempre plantillas", () => {
  assert.equal(agentEngine({ ai_off: true }), "plantilla");
  assert.equal(turnEngine({ ai_off: true }, NOW), "plantilla");
  delete process.env.ANTHROPIC_API_KEY;
  assert.equal(agentEngine({ ai_off: false }), "plantilla");
  assert.equal(agentEngine(), "plantilla");
});
