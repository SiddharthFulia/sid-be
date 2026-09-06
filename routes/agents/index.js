// /api/agents/* — Groq-powered agent registry.
// Auth is per-agent (spec.auth). db-query + system-oracle are vault-gated
// because they can browse sid.db / expose live server metadata.

import { Router } from 'express';
import { requireVault } from '../../services/auth/vault.js';
import { getAgents, runAgent } from '../../controllers/agents/index.js';
import {
  postSystemOracle,
  postSystemOracleStream,
  getSystemOracleContext,
} from '../../controllers/agents/systemOracle.js';
import { getAgent } from '../../services/agents/index.js';

const router = Router();

// Public list of every registered agent + its input shape.
router.get('/agents', getAgents);

// System Oracle — three dedicated routes for the operational Q&A UX. The
// generic /agents/:id path also serves system-oracle (via the pf-agents
// registry), but the FE prefers the fixed URLs so its EventSource + fetch
// paths stay stable regardless of any future agent renames.
//
// Order matters: register these BEFORE the /agents/:id catch-all so
// '/agents/system' isn't captured as an id of "system".
router.get( '/agents/system/context', requireVault, getSystemOracleContext);
router.post('/agents/system/stream',  requireVault, postSystemOracleStream);
router.post('/agents/system',         requireVault, postSystemOracle);

// Auth middleware picks the right guard per agent at request time.
// If the id is unknown we still let it through so `runAgent` returns a
// clean 404 with `agentId` echoed back.
function authForAgent(req, res, next) {
  const agent = getAgent(String(req.params.id || ''));
  if (!agent) return next();
  if (agent.spec.auth === 'public') return next();
  if (agent.spec.auth === 'vault')  return requireVault(req, res, next);
  // 'admin' falls through to vault too for now — we don't have a separate
  // admin gate. Swap in a stricter middleware when we do.
  return requireVault(req, res, next);
}

router.post('/agents/:id', authForAgent, runAgent);

export default router;
