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
const EXCHANGE_DLX = 'video.dlx';

let connection = null;
let channel = null;
let connecting = null;   // promise-of-current-connect, prevents thundering-herd

function isConfigured() {
  return !!RABBITMQ_URL;
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
        logger.info('RabbitMQ connection closed — will reconnect on next publish');
        connection = null;
        channel = null;
      });

      channel = await connection.createChannel();
      channel.on('error', (err) => logger.error('RabbitMQ channel error', err.message));
      // assertExchange / assertQueue are idempotent: they create on first use,
      // verify on subsequent calls. Safe to run on every BE boot.

      // DLX: failed messages from the work queues fan into video_failed_queue.
      await channel.assertExchange(EXCHANGE_DLX, 'fanout', { durable: true });
      await channel.assertQueue(QUEUE_FAILED, { durable: true });
      await channel.bindQueue(QUEUE_FAILED, EXCHANGE_DLX, '');

      // Work queues with DLX wired up.
      const workQueueOpts = {
        durable: true,
        deadLetterExchange: EXCHANGE_DLX,
      };
      await channel.assertQueue(QUEUE_FAST, workQueueOpts);
      await channel.assertQueue(QUEUE_QUALITY, workQueueOpts);

      logger.info(`RabbitMQ connected — queues: ${QUEUE_FAST}, ${QUEUE_QUALITY}, ${QUEUE_FAILED} (DLQ)`);
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
let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received — closing RabbitMQ connection`);
  await disconnect();
  // Don't call process.exit — let other Express shutdown logic run first.
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
process.on('beforeExit', () => gracefulShutdown('beforeExit'));

// Map a worker role / FE provider to the queue it belongs in.
function queueFor({ provider, role }) {
  if (provider === 'optimized') return QUEUE_FAST;
  if (provider === 'local' || role === 'local') return QUEUE_QUALITY;
  return null;   // 'worker' (Lightning) keeps its existing HTTP-poll path
}

/**
 * Publish a job-trigger message. Best-effort: returns true on success, false
 * if the broker is unconfigured/down. Callers MUST NOT block on this — the
 * inflight-jobs.json record is the durable artifact; publish failure just
 * means workers will pick the job up via the HTTP polling fallback.
 */
export async function publishJob({ provider, role, jobId, videoId }) {
  const target = queueFor({ provider, role });
  if (!target) return false;
  if (!isConfigured()) return false;

  const ch = await ensureChannel();
  if (!ch) return false;

  try {
    const body = Buffer.from(JSON.stringify({
      jobId: jobId || videoId,
      videoId: videoId || jobId,
      provider, role,
      enqueuedAt: Date.now(),
    }));
    const ok = ch.sendToQueue(target, body, {
      persistent: true,
      contentType: 'application/json',
    });
    if (!ok) logger.warn(`RabbitMQ backpressure — sendToQueue(${target}) returned false`);
    return ok;
  } catch (err) {
    logger.error(`RabbitMQ publish to ${target} failed`, err.message);
    // Drop the cached channel so the next publish reconnects.
    channel = null;
    return false;
  }
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
