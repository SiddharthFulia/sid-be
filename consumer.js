// Standalone RabbitMQ consumer process.
//
// The whole architecture in three processes:
//   1. server.js  (this repo, PM2 name: sid-be)              — API + producer
//   2. consumer.js (this file, PM2 name: sid-be-consumer)    — this file
//   3. worker.py  (E:\Siddharth\local-gpu-worker at home)    — 5090 GPU
//
// sid-be publishes to RabbitMQ; this process consumes the queues that need
// BE-side handling (currently just `keep_alive`); worker.py at home handles
// GPU-bound queues (video/image/mesh/chat/etc.) via HTTP polling.
//
// Adding a new BE-owned queue = add one entry to HANDLERS + assert the
// topology in main(). Same file, same process. If BE consumers ever get
// big enough to want per-queue isolation, this file splits — for now,
// one process is plenty.

import 'dotenv/config';
import amqplib from 'amqplib';
import logger from './helpers/logger.js';
import { recordKeepAliveRun } from './services/keepAlive/history.js';

const URL = process.env.RABBITMQ_URL || '';
const PORT = process.env.PORT || 4001;
const HEALTH_BASE = process.env.KEEP_ALIVE_BASE || `http://127.0.0.1:${PORT}`;

if (!URL) {
  logger.error('[consumer] RABBITMQ_URL not set — exiting');
  process.exit(1);
}

// ── Handlers per queue ─────────────────────────────────────────
// One entry per queue this process consumes. Add a new object here to
// pick up a new queue. Each handler is async → the base loop below acks
// on success, DLQs on PermanentError, requeues on anything else.

class PermanentError extends Error { constructor(m) { super(m); this.name = 'PermanentError'; } }

const HANDLERS = {
  keep_alive: {
    dlx:    'keep_alive.dlx',
    failed: 'keep_alive_failed_queue',
    prefetch: 1,
    handle: async (payload) => {
      const startedAt = new Date().toISOString();
      const probes = await runHealthProbes();
      const finishedAt = new Date().toISOString();
      recordKeepAliveRun({
        requestId:   payload.requestId || `ka-${Date.now()}`,
        reason:      payload.reason || 'unknown',
        triggeredAt: payload.triggeredAt || null,
        startedAt,
        finishedAt,
        probes,
        ok:          probes.every((p) => p.ok),
      });
    },
  },
  // Example (leave commented until we actually build it):
  // notifications: {
  //   dlx: 'notifications.dlx',
  //   failed: 'notifications_failed_queue',
  //   prefetch: 5,
  //   handle: async (payload) => { ... },
  // },
};

async function runHealthProbes() {
  const paths = ['/api/health', '/api/stats'];
  const out = [];
  for (const p of paths) {
    const started = Date.now();
    try {
      const res = await fetch(`${HEALTH_BASE}${p}`, {
        headers: { accept: 'application/json' },
        signal:  AbortSignal.timeout(8000),
      });
      out.push({ path: p, status: res.status, ok: res.ok, durationMs: Date.now() - started });
    } catch (err) {
      out.push({ path: p, status: 0, ok: false, durationMs: Date.now() - started, error: err.message });
    }
  }
  return out;
}

// ── Connection lifecycle ───────────────────────────────────────

let connection = null;
let channel = null;
let shuttingDown = false;
let reconnectAttempt = 0;

const backoff = () => Math.min(1000 * 2 ** reconnectAttempt, 30_000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  while (!shuttingDown) {
    try {
      connection = await amqplib.connect(URL, { heartbeat: 30 });
      connection.on('error', (err) => logger.error(`[consumer] connection error: ${err.message}`));
      connection.on('close', () => {
        if (shuttingDown) return;
        logger.warn('[consumer] connection closed — reconnecting');
        reconnectAttempt = Math.min(reconnectAttempt + 1, 10);
        setTimeout(subscribeAll, backoff());
      });

      channel = await connection.createChannel();
      channel.on('error', (err) => logger.error(`[consumer] channel error: ${err.message}`));

      // Assert every queue + its DLX. Idempotent — safe on every boot.
      for (const [name, spec] of Object.entries(HANDLERS)) {
        await channel.assertExchange(spec.dlx, 'fanout', { durable: true });
        await channel.assertQueue(spec.failed, { durable: true });
        await channel.bindQueue(spec.failed, spec.dlx, '');
        await channel.assertQueue(name, {
          durable: true,
          deadLetterExchange: spec.dlx,
        });
      }
      reconnectAttempt = 0;
      logger.info(`[consumer] connected — ${Object.keys(HANDLERS).length} queue(s): ${Object.keys(HANDLERS).join(', ')}`);
      return;
    } catch (err) {
      logger.warn(`[consumer] connect failed: ${err.message} — retrying in ${backoff()}ms`);
      await sleep(backoff());
      reconnectAttempt = Math.min(reconnectAttempt + 1, 10);
    }
  }
}

async function subscribeAll() {
  if (shuttingDown) return;
  try {
    await connect();
    for (const [name, spec] of Object.entries(HANDLERS)) {
      await channel.prefetch(spec.prefetch || 1);
      await channel.consume(name, (msg) => onMessage(name, spec, msg), { noAck: false });
    }
  } catch (err) {
    logger.error(`[consumer] subscribe failed: ${err.message}`);
    setTimeout(subscribeAll, backoff());
  }
}

async function onMessage(queueName, spec, msg) {
  if (!msg) return;
  const started = Date.now();
  let payload = {};
  try {
    payload = JSON.parse(msg.content.toString() || '{}');
  } catch {
    logger.warn(`[consumer/${queueName}] unparseable — DLQ`);
    try { channel.nack(msg, false, false); } catch {}
    return;
  }

  try {
    await spec.handle(payload);
    try { channel.ack(msg); } catch {}
    logger.info(`[consumer/${queueName}] handled id=${payload.requestId || '-'} in ${Date.now() - started}ms`);
  } catch (err) {
    const permanent = err instanceof PermanentError;
    logger.error(`[consumer/${queueName}] ${permanent ? 'permanent' : 'transient'} error: ${err.message}`);
    try { channel.nack(msg, false, !permanent); } catch {}
  }
}

// ── Shutdown ───────────────────────────────────────────────────

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`[consumer] ${signal} — draining`);
  try { if (channel)    await channel.close(); }    catch {}
  try { if (connection) await connection.close(); } catch {}
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ── Go ────────────────────────────────────────────────────────

logger.info('[consumer] boot');
await subscribeAll();
// Keep the loop alive — shutdown() calls process.exit which is the only exit.
await new Promise(() => {});
