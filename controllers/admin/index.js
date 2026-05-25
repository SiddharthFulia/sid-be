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
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import amqplib from 'amqplib';
import { success, error } from '../../helpers/res_helper.js';
import logger from '../../helpers/logger.js';
import { db } from '../../services/aiVideo/db.js';
import { getAllWorkerStatuses, isWorkerOnline } from '../../services/aiVideo/jobStore.js';

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
// Worker heartbeats live in data/gpu-worker-status.json (written by
// /api/gpu-worker/register + every /next-job poll). We flatten the
// per-role map into a list for the FE and tack on a derived `status`
// (online | stale) from the lastSeenAt age.
export const getWorkers = async (_req, res) => {
  try {
    const map = await getAllWorkerStatuses();
    const rows = Object.entries(map).map(([role, entry]) => ({
      id:         entry?.workerId || role,
      role:       entry?.role || role,
      lastSeenAt: entry?.lastSeenAt || null,
      status:     isWorkerOnline(entry) ? 'online' : 'stale',
      // Helpful extras for the panel — count of loaded Ollama models if reported.
      ollamaModels: Array.isArray(entry?.ollamaModels) ? entry.ollamaModels.length : null,
    }));
    return success(res, { workers: rows });
  } catch (err) {
    logger.error('admin getWorkers failed', err.message);
    return error(res, err.message, 500);
  }
};

// ─── Activity timeseries (per-table daily counts) ───────────────
// Powers the "Visualize" tab on the /settings dashboard. For each
// known table that has a `createdAt` column, runs a GROUP BY date()
// query for the last N days (default 14). Each per-table query is
// wrapped in its own try/catch so a missing table or missing column
// doesn't kill the whole response — we just skip it.
//
//   GET /api/admin/activity?days=14
//
// Returns: { days, series: [{ table, points: [{ day, n }, ...] }, ...] }
export const getActivityTimeseries = async (req, res) => {
  try {
    const rawDays = parseInt(req.query?.days, 10);
    const days = Number.isFinite(rawDays) && rawDays > 0 && rawDays <= 365 ? rawDays : 14;

    // Tables that have a createdAt column (per the brief). cinema_projects,
    // games_players, chat_conversations, chat_jobs are excluded — only the
    // user-activity-bearing tables ship.
    const ACTIVITY_TABLES = [
      'jobs',
      'videos',
      'enhanced_images',
      'lipsync_jobs',
      'audio_jobs',
      'mesh_jobs',
      'deepfake_jobs',
      'chess_games',
      'chess_matches',
      'games_scores',
      'chat_messages',
    ];

    const series = [];
    for (const table of ACTIVITY_TABLES) {
      try {
        const rows = db.prepare(
          `SELECT date(createdAt) AS day, COUNT(*) AS n
           FROM ${table}
           WHERE createdAt >= date('now', '-' || ? || ' days')
           GROUP BY day
           ORDER BY day ASC`,
        ).all(days);
        const points = (rows || []).map(r => ({
          day: String(r.day || ''),
          n:   Number(r.n || 0),
        })).filter(p => p.day);
        series.push({ table, points });
      } catch {
        // Table missing, or createdAt not present — skip silently.
      }
    }
    return success(res, { days, series });
  } catch (err) {
    logger.error('admin getActivityTimeseries failed', err.message);
    return error(res, err.message, 500);
  }
};

// ─── Disk stats ─────────────────────────────────────────────────
// What lives on this filesystem and how much room is left? We expose:
//   1) Filesystem totals via fs.statfs (Node 18.15+). On Windows this can
//      throw — fallback returns null totals so the FE skips the header.
//   2) Per-bucket sizes — walk the well-known data folders and sum file
//      bytes. Buckets are the lanes that actually persist binaries:
//        • sqlite     : data/sid.db (+ -wal / -shm)
//        • combined   : data/combined-videos/  (ffmpeg-concat outputs)
//        • ytdl       : data/yt-downloads/     (yt-dlp / Cobalt downloads)
//        • workersJSON: small status JSONs (tokens, gpu-worker-status)
//   3) Aggregate row counts that map to "what's in the DB" — chess games,
//      meshes, videos, audio, lipsync, deepfake, cinema projects.
//
// Symlinks are not followed (avoid loops). Hidden/dot files are counted.
// Errors on individual entries are ignored so one bad symlink doesn't
// nuke the whole report.
const BUCKET_DEFS = [
  { id: 'combined',    label: 'Combined videos',  rel: 'data/combined-videos',  emoji: '🎬' },
  { id: 'ytdl',        label: 'YouTube downloads', rel: 'data/yt-downloads',    emoji: '📼' },
];

async function walkSize(dirPath) {
  let total = 0, files = 0;
  try {
    const entries = await fsp.readdir(dirPath, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.isSymbolicLink()) continue;
      const full = path.join(dirPath, ent.name);
      if (ent.isDirectory()) {
        const sub = await walkSize(full);
        total += sub.total; files += sub.files;
      } else if (ent.isFile()) {
        try {
          const st = await fsp.stat(full);
          total += st.size; files += 1;
        } catch {}
      }
    }
  } catch {}
  return { total, files };
}

export const getDiskStats = async (_req, res) => {
  try {
    const ROOT = process.cwd();
    const DATA_DIR = path.join(ROOT, 'data');

    // Filesystem totals.
    let disk = null;
    try {
      const st = await fsp.statfs(DATA_DIR);
      const blockSize = Number(st.bsize || 0);
      const total = Number(st.blocks || 0) * blockSize;
      const free  = Number(st.bavail || st.bfree || 0) * blockSize;
      disk = { totalBytes: total, freeBytes: free, usedBytes: Math.max(0, total - free) };
    } catch (e) {
      logger.warn('admin disk statfs failed', e.message);
    }

    // SQLite — main db plus WAL & SHM if present.
    const sqliteFiles = ['sid.db', 'sid.db-wal', 'sid.db-shm'];
    let sqliteSize = 0, sqliteCount = 0;
    for (const fname of sqliteFiles) {
      try {
        const st = await fsp.stat(path.join(DATA_DIR, fname));
        if (st.isFile()) { sqliteSize += st.size; sqliteCount += 1 }
      } catch {}
    }

    const buckets = [{
      id: 'sqlite', label: 'SQLite database', emoji: '💾',
      path: 'data/sid.db', sizeBytes: sqliteSize, fileCount: sqliteCount,
    }];

    // Walk the binary lanes.
    for (const def of BUCKET_DEFS) {
      const abs = path.join(ROOT, def.rel);
      const w = await walkSize(abs);
      buckets.push({
        id: def.id, label: def.label, emoji: def.emoji,
        path: def.rel, sizeBytes: w.total, fileCount: w.files,
      });
    }

    // Loose JSON state files under data/ (everything not already counted).
    let other = 0, otherCount = 0;
    try {
      const entries = await fsp.readdir(DATA_DIR, { withFileTypes: true });
      const known = new Set(['sid.db', 'sid.db-wal', 'sid.db-shm', 'combined-videos', 'yt-downloads']);
      for (const ent of entries) {
        if (known.has(ent.name)) continue
        const full = path.join(DATA_DIR, ent.name);
        if (ent.isFile()) {
          try { const st = await fsp.stat(full); other += st.size; otherCount += 1 } catch {}
        } else if (ent.isDirectory()) {
          const w = await walkSize(full); other += w.total; otherCount += w.files;
        }
      }
    } catch {}
    buckets.push({
      id: 'other', label: 'State files',  emoji: '📦',
      path: 'data/*.json', sizeBytes: other, fileCount: otherCount,
    });

    // Mesh GLBs live as a BLOB column on `mesh_jobs` (not on Cloudinary,
    // not on disk). Surface their total + count separately so the user
    // sees the cost of the in-DB-storage choice without having to
    // mental-math from the raw sqlite file size.
    try {
      const meshAgg = db.prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(glbBlob)), 0) AS total
           FROM mesh_jobs WHERE glbBlob IS NOT NULL`
      ).get();
      buckets.push({
        id: 'mesh_blobs',
        label: 'Mesh GLB BLOBs',
        emoji: '🧊',
        path: 'mesh_jobs.glbBlob',
        sizeBytes: Number(meshAgg?.total || 0),
        fileCount: Number(meshAgg?.n || 0),
      });
    } catch {
      // Column doesn't exist yet on older DB files — skip silently.
    }

    // Per-domain row counts that the user mentally maps to "size".
    const domainTables = [
      { id: 'chess_games',     label: 'Chess games (PGN)',  table: 'chess_games' },
      { id: 'chess_matches',   label: 'Live chess matches', table: 'chess_matches' },
      { id: 'videos',          label: 'Generated videos',   table: 'videos' },
      { id: 'enhanced_images', label: 'Enhanced images',    table: 'enhanced_images' },
      { id: 'mesh_jobs',       label: 'Mesh jobs',          table: 'mesh_jobs' },
      { id: 'lipsync_jobs',    label: 'Lipsync jobs',       table: 'lipsync_jobs' },
      { id: 'audio_jobs',      label: 'Audio jobs',         table: 'audio_jobs' },
      { id: 'cinema_projects', label: 'Cinema projects',    table: 'cinema_projects' },
      { id: 'deepfake_jobs',   label: 'Deepfake jobs',      table: 'deepfake_jobs' },
      { id: 'chat_messages',   label: 'Chat messages',      table: 'chat_messages' },
    ];
    const domains = [];
    for (const d of domainTables) {
      try {
        const row = db.prepare(`SELECT COUNT(*) AS n FROM ${d.table}`).get();
        domains.push({ ...d, rows: Number(row?.n || 0) });
      } catch {
        // Table missing on older DBs — skip.
      }
    }

    const tracked = buckets.reduce((s, b) => s + b.sizeBytes, 0);
    return success(res, { disk, buckets, trackedBytes: tracked, domains });
  } catch (err) {
    logger.error('admin getDiskStats failed', err.message);
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
