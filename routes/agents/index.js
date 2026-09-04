// /api/agents/* — Groq-powered agent registry.
// Auth is per-agent (spec.auth). db-query is vault-gated because it can
// browse sid.db even in read-only mode.

import { Router } from 'express';
import { requireVault } from '../../services/auth/vault.js';
import { getAgents, runAgent } from '../../controllers/agents/index.js';
import { getAgent } from '../../services/agents/index.js';

const router = Router();

// Public list of every registered agent + its input shape.
router.get('/agents', getAgents);

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
