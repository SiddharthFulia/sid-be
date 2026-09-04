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
import { listAllQueues } from '../rabbitmq/managementApi.js';
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
 * Reads consumer status. Two sources:
 *   1. Live subscriber count on the queue — from the CloudAMQP mgmt API.
 *      `consumers > 0` means the consumer process is actively subscribed.
 *      This is the ground truth: no dependency on when the last message
 *      happened to be published.
 *   2. Run history — from SQLite, so the API process can see what runs the
 *      consumer process recorded.
 *
 * The mgmt API result is cached 5s inside managementApi.js so this call is
 * cheap even under a 2s poll from the Settings page.
 */
export async function getKeepAliveStatus() {
  const history = listKeepAliveHistory(20);
  let consumerStarted = false;
  let subscriberCount = 0;
  try {
    const { queues } = await listAllQueues();
    const q = (queues || []).find((row) => row.name === QUEUE_KEEP_ALIVE);
    subscriberCount = q?.consumerCount || 0;
    consumerStarted = subscriberCount > 0;
  } catch {
    // If the mgmt API is unreachable, fall back to "did we see a run in
    // the last 5 minutes" — better than nothing, but noisier.
    const lastStartedAt = history[0]?.startedAt || null;
    if (lastStartedAt) {
      const recentMs = Date.now() - new Date(lastStartedAt).getTime();
      consumerStarted = Number.isFinite(recentMs) && recentMs < 5 * 60 * 1000;
    }
  }
  return {
    consumerStarted,
    subscriberCount,
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
