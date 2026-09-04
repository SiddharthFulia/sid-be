// Base agent contract. Concrete agents export `spec` + `run` — the registry
// in ./index.js validates them against this shape at load time so a broken
// agent fails loud on boot instead of quietly returning garbage at request
// time.
//
// This file exports NO class — that would be premature abstraction. It's
// a spec definition + a couple of validation helpers. Agents just export
// plain functions.

/**
 * @typedef {Object} AgentSpec
 * @property {string} id            machine name; route becomes /api/agents/<id>
 * @property {string} purpose       one-line description shown at /api/agents
 * @property {'vault'|'admin'|'public'} auth
 * @property {object} input         zod-lite: field name → 'string' | 'string?' | 'number' | ...
 * @property {object} output
 */

/**
 * @typedef {Object} AgentContext
 * @property {string} requestId
 * @property {import('../../helpers/logger.js').Logger} logger
 */

/**
 * @callback AgentRun
 * @param {object} input
 * @param {AgentContext} ctx
 * @returns {Promise<object>}
 */

/**
 * @typedef {Object} Agent
 * @property {AgentSpec} spec
 * @property {AgentRun} run
 */

/**
 * Assert an agent module exports the right shape. Throws with a clear
 * message on failure so the registry's catch surfaces it at boot.
 */
export function assertAgentShape(mod, filename) {
  const where = `agent module ${filename}`;
  if (!mod || typeof mod !== 'object') {
    throw new Error(`${where}: no exports`);
  }
  const { spec, run } = mod;
  if (!spec || typeof spec !== 'object') {
    throw new Error(`${where}: missing named export "spec"`);
  }
  if (typeof spec.id !== 'string' || !spec.id.trim()) {
    throw new Error(`${where}: spec.id must be a non-empty string`);
  }
  if (!['vault', 'admin', 'public'].includes(spec.auth)) {
    throw new Error(`${where}: spec.auth must be 'vault' | 'admin' | 'public'`);
  }
  if (typeof run !== 'function') {
    throw new Error(`${where}: missing named export "run" (async function)`);
  }
}

/**
 * Shallow input validation against the spec.input map. Handles the common
 * cases (string / string? / number / number? / object / object?) — enough
 * for our current agents. If we grow to more complex validation, swap in
 * zod here without changing agent code.
 */
export function validateInput(input, schema) {
  const errors = [];
  input = input || {};
  for (const [field, kind] of Object.entries(schema || {})) {
    const optional = kind.endsWith('?');
    const base = optional ? kind.slice(0, -1) : kind;
    const val = input[field];
    if (val == null) {
      if (!optional) errors.push(`${field} is required`);
      continue;
    }
    if (base === 'string' && typeof val !== 'string') errors.push(`${field} must be a string`);
    if (base === 'number' && typeof val !== 'number') errors.push(`${field} must be a number`);
    if (base === 'object' && typeof val !== 'object') errors.push(`${field} must be an object`);
  }
  return errors;
}
