// Keep-alive publisher + status reader for the API process.
//
// The consumer used to live here too, embedded in the API process. It moved
// to `consumers/keepAlive.js` (a standalone PM2 process) so a hung probe
// can't hold up an HTTP request. See `consumers/README.md` for rationale.
//
// This module now only handles:
//   1. Publishing keep_alive messages (called by the nightly cron and by
//      POST /api/admin/keep-alive/trigger)
//   2. Reading the consumer's run history from SQLite (for the admin
//      GET /api/admin/keep-alive/status endpoint)

import { getChannel } from '../aiVideo/messageQueue.js';
import { listKeepAliveHistory } from './history.js';
import logger from '../../helpers/logger.js';

export const QUEUE_KEEP_ALIVE = 'keep_alive';
export const EXCHANGE_KEEP_ALIVE_DLX = 'keep_alive.dlx';
export const QUEUE_KEEP_ALIVE_FAILED = 'keep_alive_failed_queue';

/**
 * Publish one keep-alive message. Returns true on success. Asserts the
 * queue topology on first publish — safe to call before the consumer has
 * booted.
 */
export async function publishKeepAliveJob(reason = 'cron', requestId = null) {
  const ch = await getChannel();
  if (!ch) {
    logger.warn('keep-alive publish skipped — no RabbitMQ channel');
    return false;
  }
  await assertKeepAliveTopology(ch);

  const body = {
    reason,
    triggeredAt: new Date().toISOString(),
    requestId:   requestId || cryptoRandomId(),
  };
  try {
    const ok = ch.sendToQueue(QUEUE_KEEP_ALIVE, Buffer.from(JSON.stringify(body)), {
      persistent: true,
      contentType: 'application/json',
    });
    if (!ok) {
      logger.warn('keep-alive publish returned backpressure');
      return false;
    }
    logger.info(`keep-alive published (reason=${reason}, id=${body.requestId})`);
    return true;
  } catch (err) {
    logger.error(`keep-alive publish failed: ${err.message}`);
    return false;
  }
}

/**
 * Reads consumer status from SQLite. The API process and the consumer
 * process share `data/sid.db` (WAL mode → concurrent reads/writes are safe).
 *
 * `consumerStarted` is now inferred from history: if we saw a run within the
 * last 2 minutes we assume the consumer is up. For a stricter check the
 * consumer process would need a heartbeat table — overkill for a nightly
 * job that's manually triggerable.
 */
export function getKeepAliveStatus() {
  const history = listKeepAliveHistory(20);
  const lastStartedAt = history[0]?.startedAt || null;
  const recentMs = lastStartedAt ? Date.now() - new Date(lastStartedAt).getTime() : Infinity;
  const consumerStarted = Number.isFinite(recentMs) && recentMs < 2 * 60 * 1000;
  return {
    consumerStarted,
    lastError: null,
    historyCount: history.length,
    history,
  };
}

// ── Internals ───────────────────────────────────────────────────

async function assertKeepAliveTopology(ch) {
  await ch.assertExchange(EXCHANGE_KEEP_ALIVE_DLX, 'fanout', { durable: true });
  await ch.assertQueue(QUEUE_KEEP_ALIVE_FAILED, { durable: true });
  await ch.bindQueue(QUEUE_KEEP_ALIVE_FAILED, EXCHANGE_KEEP_ALIVE_DLX, '');
  await ch.assertQueue(QUEUE_KEEP_ALIVE, {
    durable: true,
    deadLetterExchange: EXCHANGE_KEEP_ALIVE_DLX,
  });
}

function cryptoRandomId() {
  return `ka-${Math.random().toString(36).slice(2, 10)}`;
}
