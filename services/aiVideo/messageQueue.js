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
const QUEUE_LIPSYNC = 'lipsync_queue';
const QUEUE_AUDIO   = 'audio_queue';
const QUEUE_CHAT    = 'chat_queue';
export const QUEUE_MESH    = 'mesh_queue';
export const QUEUE_DEEPFAKE = 'deepfake_queue';
export const QUEUE_YT      = 'yt_queue';
const EXCHANGE_DLX = 'video.dlx';
const EXCHANGE_IMAGE_DLX = 'image.dlx';
const EXCHANGE_LIPSYNC_DLX = 'lipsync.dlx';
const EXCHANGE_AUDIO_DLX   = 'audio.dlx';
const EXCHANGE_CHAT_DLX    = 'chat.dlx';
export const EXCHANGE_MESH_DLX = 'mesh.dlx';
export const EXCHANGE_DEEPFAKE_DLX = 'deepfake.dlx';
export const EXCHANGE_YT_DLX       = 'yt.dlx';

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

      // Lip Sync DLX + queue (Tier 3, added 2026-05)
      await channel.assertExchange(EXCHANGE_LIPSYNC_DLX, 'fanout', { durable: true });
      await channel.assertQueue('lipsync_failed_queue', { durable: true });
      await channel.bindQueue('lipsync_failed_queue', EXCHANGE_LIPSYNC_DLX, '');
      await channel.assertQueue(QUEUE_LIPSYNC, { durable: true, deadLetterExchange: EXCHANGE_LIPSYNC_DLX });

      // Audio DLX + queue (Tier 3, added 2026-05)
      await channel.assertExchange(EXCHANGE_AUDIO_DLX, 'fanout', { durable: true });
      await channel.assertQueue('audio_failed_queue', { durable: true });
      await channel.bindQueue('audio_failed_queue', EXCHANGE_AUDIO_DLX, '');
      await channel.assertQueue(QUEUE_AUDIO, { durable: true, deadLetterExchange: EXCHANGE_AUDIO_DLX });

      // Chat DLX + queue (5090 Ollama, added 2026-05-19)
      await channel.assertExchange(EXCHANGE_CHAT_DLX, 'fanout', { durable: true });
      await channel.assertQueue('chat_failed_queue', { durable: true });
      await channel.bindQueue('chat_failed_queue', EXCHANGE_CHAT_DLX, '');
      await channel.assertQueue(QUEUE_CHAT, { durable: true, deadLetterExchange: EXCHANGE_CHAT_DLX });

      // Mesh DLX + queue (text→3D on 5090, added 2026-05-21)
      await channel.assertExchange(EXCHANGE_MESH_DLX, 'fanout', { durable: true });
      await channel.assertQueue('mesh_failed_queue', { durable: true });
      await channel.bindQueue('mesh_failed_queue', EXCHANGE_MESH_DLX, '');
      await channel.assertQueue(QUEUE_MESH, { durable: true, deadLetterExchange: EXCHANGE_MESH_DLX });

      // Deepfake DLX + queue (face-swap + voice-clone-of-anyone, Vault-gated).
      await channel.assertExchange(EXCHANGE_DEEPFAKE_DLX, 'fanout', { durable: true });
      await channel.assertQueue('deepfake_failed_queue', { durable: true });
      await channel.bindQueue('deepfake_failed_queue', EXCHANGE_DEEPFAKE_DLX, '');
      await channel.assertQueue(QUEUE_DEEPFAKE, { durable: true, deadLetterExchange: EXCHANGE_DEEPFAKE_DLX });

      // YouTube downloader DLX + queue (5090 worker lane — residential IP
      // bypasses YouTube's datacenter-IP anti-bot. Online lane is Cobalt,
      // doesn't touch RabbitMQ at all.)
      await channel.assertExchange(EXCHANGE_YT_DLX, 'fanout', { durable: true });
      await channel.assertQueue('yt_failed_queue', { durable: true });
      await channel.bindQueue('yt_failed_queue', EXCHANGE_YT_DLX, '');
      await channel.assertQueue(QUEUE_YT, { durable: true, deadLetterExchange: EXCHANGE_YT_DLX });

      logger.info('RabbitMQ ready — video/image/lipsync/audio/chat/mesh/deepfake/yt queues connected');
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

// Publish a lip-sync trigger. Worker pulls full job row from BE via HTTP.
export async function publishLipsyncJob({ jobId, model }) {
  if (!isConfigured()) return false;
  const body = Buffer.from(JSON.stringify({ jobId, model, enqueuedAt: Date.now() }));
  for (let attempt = 1; attempt <= PUBLISH_MAX_ATTEMPTS; attempt++) {
    const ch = await ensureChannel();
    if (!ch) return false;
    try {
      const ok = ch.sendToQueue(QUEUE_LIPSYNC, body, { persistent: true, contentType: 'application/json' });
      if (ok) return true;
    } catch (err) { channel = null; }
    if (attempt < PUBLISH_MAX_ATTEMPTS) {
      await new Promise(r => setTimeout(r, PUBLISH_RETRY_BASE_MS * Math.pow(2, attempt - 1)));
    }
  }
  logger.error('RabbitMQ lipsync publish failed');
  return false;
}

// Publish an audio-gen trigger.
export async function publishAudioJob({ jobId, kind, model }) {
  if (!isConfigured()) return false;
  const body = Buffer.from(JSON.stringify({ jobId, kind, model, enqueuedAt: Date.now() }));
  for (let attempt = 1; attempt <= PUBLISH_MAX_ATTEMPTS; attempt++) {
    const ch = await ensureChannel();
    if (!ch) return false;
    try {
      const ok = ch.sendToQueue(QUEUE_AUDIO, body, { persistent: true, contentType: 'application/json' });
      if (ok) return true;
    } catch (err) { channel = null; }
    if (attempt < PUBLISH_MAX_ATTEMPTS) {
      await new Promise(r => setTimeout(r, PUBLISH_RETRY_BASE_MS * Math.pow(2, attempt - 1)));
    }
  }
  logger.error('RabbitMQ audio publish failed');
  return false;
}

// Publish a chat trigger to the 5090's Ollama via worker.
export async function publishChatJob({ jobId, model }) {
  if (!isConfigured()) return false;
  const body = Buffer.from(JSON.stringify({ jobId, model, enqueuedAt: Date.now() }));
  for (let attempt = 1; attempt <= PUBLISH_MAX_ATTEMPTS; attempt++) {
    const ch = await ensureChannel();
    if (!ch) return false;
    try {
      const ok = ch.sendToQueue(QUEUE_CHAT, body, { persistent: true, contentType: 'application/json' });
      if (ok) return true;
    } catch (err) { channel = null; }
    if (attempt < PUBLISH_MAX_ATTEMPTS) {
      await new Promise(r => setTimeout(r, PUBLISH_RETRY_BASE_MS * Math.pow(2, attempt - 1)));
    }
  }
  logger.error('RabbitMQ chat publish failed');
  return false;
}

// Publish a YouTube-download trigger to the 5090 worker. Worker pulls
// the full yt_jobs row via /api/gpu-worker/yt-job/:jobId after this nudge.
export async function publishYtJob({ jobId }) {
  if (!isConfigured()) return false;
  const body = Buffer.from(JSON.stringify({ jobId, enqueuedAt: Date.now() }));
  for (let attempt = 1; attempt <= PUBLISH_MAX_ATTEMPTS; attempt++) {
    const ch = await ensureChannel();
    if (!ch) return false;
    try {
      const ok = ch.sendToQueue(QUEUE_YT, body, { persistent: true, contentType: 'application/json' });
      if (ok) return true;
    } catch (err) { channel = null; }
    if (attempt < PUBLISH_MAX_ATTEMPTS) {
      await new Promise(r => setTimeout(r, PUBLISH_RETRY_BASE_MS * Math.pow(2, attempt - 1)));
    }
  }
  logger.error('RabbitMQ yt publish failed');
  return false;
}

// Publish a text-to-3D mesh trigger. Worker pulls the full mesh_jobs row
// from BE via HTTP after receiving this nudge.
export async function publishMeshJob({ jobId, model }) {
  if (!isConfigured()) return false;
  const body = Buffer.from(JSON.stringify({ jobId, model, enqueuedAt: Date.now() }));
  for (let attempt = 1; attempt <= PUBLISH_MAX_ATTEMPTS; attempt++) {
    const ch = await ensureChannel();
    if (!ch) return false;
    try {
      const ok = ch.sendToQueue(QUEUE_MESH, body, { persistent: true, contentType: 'application/json' });
      if (ok) return true;
    } catch (err) { channel = null; }
    if (attempt < PUBLISH_MAX_ATTEMPTS) {
      await new Promise(r => setTimeout(r, PUBLISH_RETRY_BASE_MS * Math.pow(2, attempt - 1)));
    }
  }
  logger.error('RabbitMQ mesh publish failed');
  return false;
}

// Publish a deepfake trigger. Vault-gated lane; only the password-holder
// reaches this code path. Worker pulls the full deepfake_jobs row via HTTP.
export async function publishDeepfakeJob({ jobId, kind, model }) {
  if (!isConfigured()) return false;
  const body = Buffer.from(JSON.stringify({ jobId, kind, model, enqueuedAt: Date.now() }));
  for (let attempt = 1; attempt <= PUBLISH_MAX_ATTEMPTS; attempt++) {
    const ch = await ensureChannel();
    if (!ch) return false;
    try {
      const ok = ch.sendToQueue(QUEUE_DEEPFAKE, body, { persistent: true, contentType: 'application/json' });
      if (ok) return true;
    } catch (err) { channel = null; }
    if (attempt < PUBLISH_MAX_ATTEMPTS) {
      await new Promise(r => setTimeout(r, PUBLISH_RETRY_BASE_MS * Math.pow(2, attempt - 1)));
    }
  }
  logger.error('RabbitMQ deepfake publish failed');
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
