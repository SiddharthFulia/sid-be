// HTTP handlers for /api/agents/*. Kept thin — validate + dispatch, all
// domain logic lives in services/agents/.

import { randomUUID } from 'crypto';
import { getAgent, listAgents } from '../../services/agents/index.js';
import { validateInput } from '../../services/agents/baseAgent.js';
import logger from '../../helpers/logger.js';

export function getAgents(req, res) {
  return res.json({ agents: listAgents() });
}

export async function runAgent(req, res) {
  const id = String(req.params.id || '').trim();
  const agent = getAgent(id);
  if (!agent) {
    return res.status(404).json({ error: `Unknown agent: ${id}` });
  }

  const errors = validateInput(req.body, agent.spec.input);
  if (errors.length) {
    return res.status(400).json({ error: 'invalid input', details: errors });
  }

  const requestId = randomUUID();
  const ctx = { requestId, logger };
  try {
    const started = Date.now();
    const result = await agent.run(req.body, ctx);
    return res.json({
      requestId,
      agentId: id,
      durationMs: Date.now() - started,
      result,
    });
  } catch (err) {
    const status = err.status || 500;
    logger.error(`agent ${id} failed`, { requestId, error: err.message });
    return res.status(status).json({
      requestId,
      agentId: id,
      error: err.message || 'Agent failed',
      raw: err.raw,
    });
  }
}
