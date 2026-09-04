// Keep-alive queue module.
//
// Why this exists: CloudAMQP / LavinMQ deletes free-tier instances that stay
// idle for 90 days. We already have long-lived work queues (video / image
// / chat / …) but they can idle for weeks if I'm not actively demoing.
//
// The nightly cron in crons/keepAlive.js publishes ONE message to `keep_alive`
// every midnight IST. This consumer pops it, hits a couple of internal HTTP
// endpoints, records the outcome, and acks. The broker sees traffic every
// day → the 90-day timer never expires.
//
// Manual trigger: POST /api/admin/keep-alive/trigger publishes 1 message
// on-demand so the user can watch the flow in real time in the admin panel.
//
// Shape:
//   { reason: 'cron' | 'manual', triggeredAt: <ISO>, requestId: <uuid> }
//
// The consumer keeps the last 20 outcomes in-memory so the admin panel can
// render "last check was 12s ago, hit /api/health + /api/stats, both OK".

import { getChannel } from '../aiVideo/messageQueue.js';
import logger from '../../helpers/logger.js';

export const QUEUE_KEEP_ALIVE = 'keep_alive';
export const EXCHANGE_KEEP_ALIVE_DLX = 'keep_alive.dlx';
export const QUEUE_KEEP_ALIVE_FAILED = 'keep_alive_failed_queue';

// Where the consumer's health probes go. Points at the local server so we
// never open a public request loop. Override with KEEP_ALIVE_BASE if the BE
// runs behind a proxy that rewrites the internal port.
const HEALTH_BASE = process.env.KEEP_ALIVE_BASE || `http://127.0.0.1:${process.env.PORT || 4001}`;
const PROBES = ['/api/health', '/api/stats'];

// In-memory ring buffer of the last N runs. Not persisted — the point is to
// let the admin panel see the LAST few runs, not to build a full audit log.
// If the BE restarts we lose history until the next cron fires.
const HISTORY_MAX = 20;
const history = [];
let consumerStarted = false;
let lastError = null;

function record(entry) {
  history.unshift(entry);
  while (history.length > HISTORY_MAX) history.pop();
}

/**
 * Publish one keep-alive message. Returns true on success.
 * @param {'cron' | 'manual'} reason
 * @param {string} [requestId]  optional caller-supplied id
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
 * Start the consumer. Idempotent — a second call is a no-op. Returns the
 * consumerTag string, or null if the broker isn't wired.
 */
export async function startKeepAliveConsumer() {
  if (consumerStarted) return 'already-started';
  const ch = await getChannel();
  if (!ch) {
    logger.warn('keep-alive consumer skipped — no RabbitMQ channel');
    return null;
  }
  await assertKeepAliveTopology(ch);

  await ch.prefetch(1);
  const { consumerTag } = await ch.consume(QUEUE_KEEP_ALIVE, async (msg) => {
    if (!msg) return;
    let payload = {};
    try {
      payload = JSON.parse(msg.content.toString() || '{}');
    } catch {
      payload = { reason: 'unknown', triggeredAt: null, requestId: 'unparseable' };
    }
    const startedAt = new Date().toISOString();
    const probeResults = await runHealthProbes();
    const finishedAt = new Date().toISOString();
    const allOk = probeResults.every(r => r.ok);

    record({
      requestId:  payload.requestId,
      reason:     payload.reason,
      triggeredAt: payload.triggeredAt,
      startedAt,
      finishedAt,
      probes:     probeResults,
      ok:         allOk,
    });

    logger.info(
      `keep-alive consumed (reason=${payload.reason}, ok=${allOk}, probes=${probeResults.length})`,
    );
    ch.ack(msg);
  }, { noAck: false });

  consumerStarted = true;
  lastError = null;
  logger.info(`keep-alive consumer started (tag=${consumerTag})`);
  return consumerTag;
}

/** Admin dashboard read. */
export function getKeepAliveStatus() {
  return {
    consumerStarted,
    lastError,
    historyCount: history.length,
    history,
  };
}

// ── Internals ───────────────────────────────────────────────────

async function assertKeepAliveTopology(ch) {
  // Same DLX pattern as every other queue in messageQueue.js so a
  // consistently-failing keep-alive can be inspected via the DLQ.
  await ch.assertExchange(EXCHANGE_KEEP_ALIVE_DLX, 'fanout', { durable: true });
  await ch.assertQueue(QUEUE_KEEP_ALIVE_FAILED, { durable: true });
  await ch.bindQueue(QUEUE_KEEP_ALIVE_FAILED, EXCHANGE_KEEP_ALIVE_DLX, '');
  await ch.assertQueue(QUEUE_KEEP_ALIVE, {
    durable: true,
    deadLetterExchange: EXCHANGE_KEEP_ALIVE_DLX,
  });
}

async function runHealthProbes() {
  const results = [];
  for (const p of PROBES) {
    const url = `${HEALTH_BASE}${p}`;
    const started = Date.now();
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      const durationMs = Date.now() - started;
      results.push({
        path:     p,
        status:   res.status,
        ok:       res.ok,
        durationMs,
      });
    } catch (err) {
      lastError = err.message;
      results.push({
        path:     p,
        status:   0,
        ok:       false,
        durationMs: Date.now() - started,
        error:    err.message,
      });
    }
  }
  return results;
}

function cryptoRandomId() {
  return `ka-${Math.random().toString(36).slice(2, 10)}`;
}
