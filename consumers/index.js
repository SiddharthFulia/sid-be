// Standalone RabbitMQ consumer process — entry point.
//
// PM2 runs this file (see ecosystem.config.cjs → `sid-be-consumer`). It
// registers every handler under this folder and dispatches incoming
// messages to the right one based on which queue delivered them.
//
// Architecture recap — three processes:
//   1. server.js      sid-be           API + producer
//   2. consumers/     sid-be-consumer  this process
//   3. worker.py      5090 worker      GPU consumer (at home)
//
// Adding a new BE-owned queue:
//   1. Drop a file next to this one exporting a default object with
//      { queue, dlx, failed, prefetch, handle }
//   2. Add it to the HANDLERS array below
//   3. Push. PM2 picks up the change on the next deploy.
//
// See consumers/keepAlive.js for the reference implementation.

import 'dotenv/config';
import amqplib from 'amqplib';
import logger from '../helpers/logger.js';
import keepAlive from './keepAlive.js';

const HANDLERS = [
  keepAlive,
  // Drop new handlers here.
];

const URL = process.env.RABBITMQ_URL || '';
if (!URL) {
  logger.error('[consumer] RABBITMQ_URL not set — exiting');
  process.exit(1);
}

// Throw this from a handler's `handle` to nack-without-requeue (DLQ).
// Anything else = transient → requeue for retry.
export class PermanentError extends Error {
  constructor(message) { super(message); this.name = 'PermanentError'; }
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

      // Assert every queue's topology up front. Idempotent — safe to run
      // on every boot even if a queue was created by a previous run.
      for (const h of HANDLERS) {
        await channel.assertExchange(h.dlx, 'fanout', { durable: true });
        await channel.assertQueue(h.failed, { durable: true });
        await channel.bindQueue(h.failed, h.dlx, '');
        await channel.assertQueue(h.queue, {
          durable: true,
          deadLetterExchange: h.dlx,
        });
      }
      reconnectAttempt = 0;
      const names = HANDLERS.map((h) => h.queue).join(', ');
      logger.info(`[consumer] connected — ${HANDLERS.length} queue(s): ${names}`);
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
    for (const h of HANDLERS) {
      await channel.prefetch(h.prefetch || 1);
      await channel.consume(h.queue, (msg) => onMessage(h, msg), { noAck: false });
    }
  } catch (err) {
    logger.error(`[consumer] subscribe failed: ${err.message}`);
    setTimeout(subscribeAll, backoff());
  }
}

async function onMessage(handler, msg) {
  if (!msg) return;
  const started = Date.now();
  let payload = {};
  try {
    payload = JSON.parse(msg.content.toString() || '{}');
  } catch {
    logger.warn(`[consumer/${handler.queue}] unparseable — DLQ`);
    try { channel.nack(msg, false, false); } catch {}
    return;
  }

  try {
    await handler.handle(payload);
    try { channel.ack(msg); } catch {}
    logger.info(`[consumer/${handler.queue}] handled id=${payload.requestId || '-'} in ${Date.now() - started}ms`);
  } catch (err) {
    const permanent = err instanceof PermanentError;
    logger.error(`[consumer/${handler.queue}] ${permanent ? 'permanent' : 'transient'} error: ${err.message}`);
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
await new Promise(() => {}); // block forever — shutdown() calls process.exit
