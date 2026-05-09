// RabbitMQ (CloudAMQP/LavinMQ) publisher for video generation jobs.
//
// Design notes:
//  • RabbitMQ delivers the *trigger*; inflight-jobs.json remains the single
//    source of truth for job state. Publishing failures degrade gracefully —
//    workers keep polling /api/gpu-worker/next-job over HTTP as a fallback,
//    so the system stays correct even if the broker is unreachable.
//  • Three queues: fast (5090 Optimized), quality (5090 Beast), failed (DLQ).
//    Both work queues dead-letter to `video.dlx` → `video_failed_queue` so
//    the FE can list permanently-failed jobs from a single place later.
//  • Lazy connection: we connect on first publish, not on BE boot. Boots
//    survive even when the broker is down; the cost shifts to first publish.
//  • One connection per process; one channel per connection. No pooling —
//    publish rate is way under amqplib's single-channel ceiling.

import amqplib from 'amqplib';
import logger from '../../helpers/logger.js';

const RABBITMQ_URL = process.env.RABBITMQ_URL || '';
const QUEUE_FAST = 'video_fast_queue';
const QUEUE_QUALITY = 'video_quality_queue';
const QUEUE_FAILED = 'video_failed_queue';
const QUEUE_IMAGE = 'image_enhance_queue';
const QUEUE_IMAGE_FAILED = 'image_failed_queue';
const EXCHANGE_DLX = 'video.dlx';
const EXCHANGE_IMAGE_DLX = 'image.dlx';

let connection = null;
let channel = null;
let connecting = null;   // promise-of-current-connect, prevents thundering-herd
let shuttingDown = false;   // set true on SIGTERM/SIGINT so reconnects don't fight a clean exit

// Auto-reconnect state. When the connection drops (heartbeat timeout, broker
// restart, network partition), `scheduleReconnect()` retries with exponential
// backoff: 1s → 2s → 4s → 8s → … capped at 30s. The counter resets to 0 on
// every successful connect so transient blips don't permanently slow us down.
let reconnectTimer = null;
let reconnectAttempt = 0;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

// Per-publish retry budget. amqplib's `sendToQueue` is sync once the channel
// is open, so retries here cover network blips at the channel level + the
// "channel was just closed" race when CloudAMQP recycles connections.
const PUBLISH_MAX_ATTEMPTS = 3;
const PUBLISH_RETRY_BASE_MS = 200;

function isConfigured() {
  return !!RABBITMQ_URL;
}

function scheduleReconnect() {
  if (!isConfigured() || shuttingDown) return;
  if (reconnectTimer) return;   // one timer at a time
  const delay = Math.min(
    RECONNECT_BASE_MS * Math.pow(2, reconnectAttempt),
    RECONNECT_MAX_MS,
  );
  reconnectAttempt += 1;
  logger.warn(`RabbitMQ disconnected — reconnect attempt ${reconnectAttempt} in ${delay}ms`);
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    const ch = await ensureChannel();
    if (ch) {
      logger.info(`RabbitMQ reconnected on attempt ${reconnectAttempt}`);
      reconnectAttempt = 0;
    } else {
      scheduleReconnect();   // try again with bigger delay
    }
  }, delay);
}

async function ensureChannel() {
  if (channel) return channel;
  if (!isConfigured()) return null;
  if (connecting) return connecting;

  connecting = (async () => {
    try {
      connection = await amqplib.connect(RABBITMQ_URL, { heartbeat: 30 });
      connection.on('error', (err) => logger.error('RabbitMQ connection error', err.message));
      connection.on('close', () => {
        // Heartbeat timeout, broker restart, or remote close. Clear our
        // cached refs and schedule a reconnect with backoff. Skipped if
        // we're already shutting down (graceful exit cleanup runs once).
        connection = null;
        channel = null;
        if (!shuttingDown) {
          logger.warn('RabbitMQ connection closed unexpectedly');
          scheduleReconnect();
        }
      });

      channel = await connection.createChannel();
      channel.on('error', (err) => logger.error('RabbitMQ channel error', err.message));
      // assertExchange / assertQueue are idempotent: they create on first use,
      // verify on subsequent calls. Safe to run on every BE boot.

      // Video DLX
      await channel.assertExchange(EXCHANGE_DLX, 'fanout', { durable: true });
      await channel.assertQueue(QUEUE_FAILED, { durable: true });
      await channel.bindQueue(QUEUE_FAILED, EXCHANGE_DLX, '');
      // Image DLX (separate so the FE Failures tab can show image vs video distinctly)
      await channel.assertExchange(EXCHANGE_IMAGE_DLX, 'fanout', { durable: true });
      await channel.assertQueue(QUEUE_IMAGE_FAILED, { durable: true });
      await channel.bindQueue(QUEUE_IMAGE_FAILED, EXCHANGE_IMAGE_DLX, '');

      // Video work queues
      await channel.assertQueue(QUEUE_FAST,    { durable: true, deadLetterExchange: EXCHANGE_DLX });
      await channel.assertQueue(QUEUE_QUALITY, { durable: true, deadLetterExchange: EXCHANGE_DLX });
      // Image work queue (single queue, type/engine fields on the message dispatch)
      await channel.assertQueue(QUEUE_IMAGE,   { durable: true, deadLetterExchange: EXCHANGE_IMAGE_DLX });

      logger.info('RabbitMQ ready — both video queues connected');
      return channel;
    } catch (err) {
      logger.error('RabbitMQ connect failed (workers will fall back to HTTP polling)', err.message);
      connection = null;
      channel = null;
      return null;
    } finally {
      connecting = null;
    }
  })();
  return connecting;
}

/**
 * Close channel + connection cleanly. Called from the SIGTERM/SIGINT handlers
 * registered below so PM2 restarts don't leak connections (CloudAMQP free
 * tier caps at 40 connections — leaks would lock us out within a day).
 */
export async function disconnect() {
  try {
    if (channel) {
      await channel.close();
      channel = null;
    }
  } catch (err) {
    logger.warn(`RabbitMQ channel close error (ignoring): ${err.message}`);
  }
  try {
    if (connection) {
      await connection.close();
      connection = null;
    }
  } catch (err) {
    logger.warn(`RabbitMQ connection close error (ignoring): ${err.message}`);
  }
}

// Register shutdown hooks once at module load. Two SIGINT/SIGTERM during
// the same shutdown should not double-close (idempotent — `connection`
// and `channel` are nulled out by disconnect()).
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  logger.info(`${signal} received — closing RabbitMQ connection`);
  await disconnect();
  // Don't call process.exit — let other Express shutdown logic run first.
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
process.on('beforeExit', () => gracefulShutdown('beforeExit'));

// ── Eager connect on module load ──────────────────────────────────────
// `ensureChannel()` is normally lazy — first publish opens the connection.
// We kick it off at boot so the user sees a clear "RabbitMQ ready" log line
// alongside "Server running on port 4001" instead of waiting for the first
// job. Fire-and-forget; failures already log + the BE keeps running because
// the worker's HTTP polling path still works without the broker.
if (isConfigured()) {
  ensureChannel()
    // ensureChannel() already logs "RabbitMQ ready — both video queues connected"
    // on success. We just swallow the promise here; warnings are logged inside.
    .then(() => {})
    .catch(() => {});
} else {
  logger.info('RabbitMQ disabled (RABBITMQ_URL not set) — workers will use HTTP polling');
}

// Map a worker role / FE provider to the queue it belongs in.
function queueFor({ provider, role }) {
  if (provider === 'optimized') return QUEUE_FAST;
  if (provider === 'local' || role === 'local') return QUEUE_QUALITY;
  return null;   // 'worker' (Lightning) keeps its existing HTTP-poll path
}

/** Publish an image-enhance trigger. Returns true on success, false otherwise. */
export async function publishImageJob({ imageId, type, engine, presetId }) {
  if (!isConfigured()) return false;
  const body = Buffer.from(JSON.stringify({
    imageId, type, engine, presetId,
    enqueuedAt: Date.now(),
  }));
  let lastErr = null;
  for (let attempt = 1; attempt <= PUBLISH_MAX_ATTEMPTS; attempt++) {
    const ch = await ensureChannel();
    if (!ch) { lastErr = 'broker unavailable'; break; }
    try {
      const ok = ch.sendToQueue(QUEUE_IMAGE, body, {
        persistent: true,
        contentType: 'application/json',
      });
      if (ok) {
        if (attempt > 1) logger.info(`RabbitMQ image publish recovered on attempt ${attempt}`);
        return true;
      }
      lastErr = 'backpressure';
    } catch (err) {
      lastErr = err.message;
      channel = null;
    }
    if (attempt < PUBLISH_MAX_ATTEMPTS) {
      await new Promise(r => setTimeout(r, PUBLISH_RETRY_BASE_MS * Math.pow(2, attempt - 1)));
    }
  }
  logger.error(`RabbitMQ image publish failed after ${PUBLISH_MAX_ATTEMPTS} attempts: ${lastErr}`);
  return false;
}

/**
 * Publish a job-trigger message. Retries up to 3 times with exponential
 * backoff (200ms → 400ms → 800ms) before giving up. Each attempt re-checks
 * the channel — if the connection just died mid-flight, ensureChannel()
 * reconnects on the next attempt.
 *
 * Best-effort overall: returns true on success, false on permanent failure
 * (broker unconfigured / down for >1.4s). Callers MUST NOT block on this —
 * the SQLite job row is the durable artifact; publish failure just means
 * the worker picks the job up via HTTP polling instead of an instant push.
 */
export async function publishJob({ provider, role, jobId, videoId }) {
  const target = queueFor({ provider, role });
  if (!target) return false;
  if (!isConfigured()) return false;

  const body = Buffer.from(JSON.stringify({
    jobId: jobId || videoId,
    videoId: videoId || jobId,
    provider, role,
    enqueuedAt: Date.now(),
  }));

  let lastErr = null;
  for (let attempt = 1; attempt <= PUBLISH_MAX_ATTEMPTS; attempt++) {
    const ch = await ensureChannel();
    if (!ch) {
      // Broker is hard-down. No point retrying tighter — the auto-reconnect
      // loop is already running in the background; HTTP polling covers us.
      lastErr = 'broker unavailable';
      break;
    }
    try {
      const ok = ch.sendToQueue(target, body, {
        persistent: true,
        contentType: 'application/json',
      });
      if (ok) {
        if (attempt > 1) logger.info(`RabbitMQ publish recovered on attempt ${attempt}`);
        return true;
      }
      // sendToQueue returns false when amqplib's internal write buffer is
      // full — wait briefly and the next attempt will re-check.
      lastErr = 'backpressure (sendToQueue returned false)';
    } catch (err) {
      lastErr = err.message;
      // Channel is poisoned; null it so ensureChannel() reconnects next loop.
      channel = null;
    }
    if (attempt < PUBLISH_MAX_ATTEMPTS) {
      const wait = PUBLISH_RETRY_BASE_MS * Math.pow(2, attempt - 1);
      logger.warn(`RabbitMQ publish attempt ${attempt} failed (${lastErr}) — retrying in ${wait}ms`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  logger.error(`RabbitMQ publish to ${target} failed after ${PUBLISH_MAX_ATTEMPTS} attempts: ${lastErr}`);
  return false;
}

/**
 * Best-effort: returns the count of jobs sitting in `video_failed_queue`.
 * Used by the FE library tab to show a "failed" badge without consuming
 * the messages.
 */
export async function getFailedCount() {
  const ch = await ensureChannel();
  if (!ch) return 0;
  try {
    const info = await ch.checkQueue(QUEUE_FAILED);
    return info.messageCount || 0;
  } catch {
    return 0;
  }
}

export { QUEUE_FAST, QUEUE_QUALITY, QUEUE_FAILED };
