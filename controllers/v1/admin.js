// Vault-gated admin dashboard endpoints. Every handler here sits behind
// requireVault at the route level — only the password-holder can read
// server stats, db stats, queue depths, or worker heartbeats.
//
//   GET  /api/admin/server-stats   — CPU / RAM / load / uptime
//   GET  /api/admin/db-stats       — sqlite file size + per-table row counts
//   GET  /api/admin/queues         — RabbitMQ queue depths via channel.checkQueue
//   GET  /api/admin/workers        — worker_heartbeats table (if it exists)
//   POST /api/admin/queues/purge   — channel.purgeQueue(name) for one whitelisted queue
//
// All RabbitMQ calls open a short-lived connection + channel on demand and
// close them cleanly in a finally — we don't reuse the long-lived publisher
// channel from messageQueue.js so a checkQueue/purge bug can't corrupt the
// production publish lane.

import os from 'os';
import amqplib from 'amqplib';
import { success, error } from '../../helpers/res_helper.js';
import logger from '../../helpers/logger.js';
import { db } from '../../services/aiVideo/db.js';

const KNOWN_TABLES = [
  'jobs',
  'videos',
  'enhanced_images',
  'lipsync_jobs',
  'audio_jobs',
  'cinema_projects',
  'mesh_jobs',
  'deepfake_jobs',
  'chess_games',
  'chess_matches',
  'games_players',
  'games_scores',
  'chat_conversations',
  'chat_messages',
  'chat_jobs',
];

const KNOWN_QUEUES = [
  'video_fast_queue',
  'video_quality_queue',
  'video_failed_queue',
  'image_enhance_queue',
  'image_failed_queue',
  'lipsync_queue',
  'audio_queue',
  'chat_queue',
  'mesh_queue',
  'deepfake_queue',
];

// ─── Server stats ───────────────────────────────────────────────
// All values come from the `os` stdlib — no shelling out. uptime is the
// process uptime (seconds since BE started), not OS uptime, so a PM2
// restart shows up here immediately.
export const getServerStats = async (_req, res) => {
  try {
    const memTotal = os.totalmem();
    const memFree = os.freemem();
    const memUsed = memTotal - memFree;
    const memTotalMB = Math.round(memTotal / (1024 * 1024));
    const memFreeMB = Math.round(memFree / (1024 * 1024));
    const memUsedPercent = memTotal > 0 ? Math.round((memUsed / memTotal) * 1000) / 10 : 0;
    return success(res, {
      uptime: process.uptime(),
      loadAvg: os.loadavg(),
      cpuCount: os.cpus().length,
      memTotalMB,
      memFreeMB,
      memUsedPercent,
      platform: os.platform(),
      arch: os.arch(),
      hostname: os.hostname(),
    });
  } catch (err) {
    logger.error('admin getServerStats failed', err.message);
    return error(res, err.message, 500);
  }
};

// ─── DB stats ───────────────────────────────────────────────────
// PRAGMA page_count * page_size = total sqlite file size on disk. Per-table
// row counts run COUNT(*) for each known table; we wrap each in try/catch
// because some tables may not exist on older DB files (e.g. mesh_jobs was
// added later than chess_games).
export const getDbStats = async (_req, res) => {
  try {
    let sizeBytes = 0;
    try {
      const pageCount = db.pragma('page_count', { simple: true });
      const pageSize = db.pragma('page_size', { simple: true });
      sizeBytes = Number(pageCount) * Number(pageSize);
    } catch (e) {
      logger.warn('admin db page_count/page_size failed', e.message);
    }

    const tables = [];
    for (const name of KNOWN_TABLES) {
      try {
        const row = db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get();
        tables.push({ name, rows: Number(row?.n || 0) });
      } catch {
        // Table doesn't exist on this DB — skip silently.
      }
    }
    return success(res, { sizeBytes, tables });
  } catch (err) {
    logger.error('admin getDbStats failed', err.message);
    return error(res, err.message, 500);
  }
};

// ─── Queue stats (RabbitMQ) ─────────────────────────────────────
// Opens a fresh connection/channel, runs checkQueue for each known queue
// (404s on missing queues are ignored), then closes cleanly. We don't
// reuse messageQueue.js's persistent channel because a checkQueue against
// a non-existent queue puts the channel in an errored state — fine for a
// throwaway channel, fatal for the publisher's.
export const getQueueStats = async (_req, res) => {
  const url = process.env.RABBITMQ_URL || '';
  if (!url) return success(res, { configured: false, queues: [] });

  let connection = null;
  try {
    connection = await amqplib.connect(url, { heartbeat: 15 });
    const queues = [];
    for (const name of KNOWN_QUEUES) {
      // One channel per queue — a checkQueue against a missing queue 404s
      // and kills the channel, so we get a clean one for every probe.
      let ch = null;
      try {
        ch = await connection.createChannel();
        ch.on('error', () => {});
        const info = await ch.checkQueue(name);
        queues.push({ name, messageCount: info.messageCount, consumerCount: info.consumerCount });
      } catch {
        // Queue doesn't exist — skip.
      } finally {
        try { if (ch) await ch.close(); } catch {}
      }
    }
    return success(res, { configured: true, queues });
  } catch (err) {
    logger.error('admin getQueueStats failed', err.message);
    return error(res, err.message, 503);
  } finally {
    try { if (connection) await connection.close(); } catch {}
  }
};

// ─── Worker heartbeats ──────────────────────────────────────────
// Reads the worker_heartbeats table if it exists. Returns [] when the
// table isn't there yet (older DBs / fresh installs) so the FE always
// renders the card cleanly.
export const getWorkers = async (_req, res) => {
  try {
    let rows = [];
    try {
      rows = db.prepare('SELECT * FROM worker_heartbeats ORDER BY lastSeenAt DESC').all();
    } catch {
      rows = [];
    }
    return success(res, { workers: rows });
  } catch (err) {
    logger.error('admin getWorkers failed', err.message);
    return error(res, err.message, 500);
  }
};

// ─── Purge a single queue ───────────────────────────────────────
// Whitelisted queue names only — body { queue }. Returns the count of
// messages discarded so the FE can confirm.
export const postPurgeQueue = async (req, res) => {
  const url = process.env.RABBITMQ_URL || '';
  if (!url) return error(res, 'RabbitMQ not configured', 503);

  const { queue } = req.body || {};
  if (!queue || typeof queue !== 'string') {
    return error(res, 'queue (string) is required', 400);
  }
  if (!KNOWN_QUEUES.includes(queue)) {
    return error(res, `queue must be one of: ${KNOWN_QUEUES.join(', ')}`, 400);
  }

  let connection = null;
  let channel = null;
  try {
    connection = await amqplib.connect(url, { heartbeat: 15 });
    channel = await connection.createChannel();
    channel.on('error', () => {});
    const result = await channel.purgeQueue(queue);
    return success(res, { purged: result.messageCount, queue });
  } catch (err) {
    logger.error('admin postPurgeQueue failed', err.message);
    return error(res, err.message, 503);
  } finally {
    try { if (channel) await channel.close(); } catch {}
    try { if (connection) await connection.close(); } catch {}
  }
};
