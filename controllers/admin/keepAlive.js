// Admin controller for the keep-alive queue.
//
//  · POST /api/admin/keep-alive/trigger  — publish one message right now
//  · GET  /api/admin/keep-alive/status   — read the last N consumed runs

import { randomUUID } from 'crypto';
import {
  publishKeepAliveJob,
  getKeepAliveStatus,
} from '../../services/keepAlive/index.js';

export async function postTriggerKeepAlive(req, res) {
  const requestId = randomUUID();
  const ok = await publishKeepAliveJob('manual', requestId);
  if (!ok) {
    return res.status(503).json({
      requestId,
      published: false,
      error: 'Broker unreachable — RABBITMQ_URL not configured or connection down.',
    });
  }
  return res.status(202).json({
    requestId,
    published: true,
    hint: 'Watch GET /api/admin/keep-alive/status — the message lands in history within ~1s.',
  });
}

export async function getKeepAliveStatusHandler(req, res) {
  return res.json(await getKeepAliveStatus());
}
