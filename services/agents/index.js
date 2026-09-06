// Agent registry. Each concrete agent registers here so the routes layer
// doesn't need to know about individual files.

import * as dbQuery      from './dbQueryAgent.js';
import * as systemOracle from './systemOracle.js';
import { assertAgentShape } from './baseAgent.js';

const MODULES = [
  ['dbQueryAgent.js',   dbQuery],
  ['systemOracle.js',   systemOracle],
];

const REGISTRY = new Map();

for (const [filename, mod] of MODULES) {
  assertAgentShape(mod, filename);
  REGISTRY.set(mod.spec.id, mod);
}

export function listAgents() {
  return [...REGISTRY.values()].map(m => ({
    id:      m.spec.id,
    purpose: m.spec.purpose,
    auth:    m.spec.auth,
    input:   m.spec.input,
    output:  m.spec.output,
  }));
}

export function getAgent(id) {
  return REGISTRY.get(id) || null;
}
