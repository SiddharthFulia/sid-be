// yt_jobs SQLite helpers. Schema lives in services/aiVideo/db.js.

import { db } from '../aiVideo/db.js';

const ALLOWED_UPDATES = new Set([
  'status', 'progress', 'title', 'duration', 'fileSize',
  'fileName', 'filePath', 'thumbnail', 'error', 'pid', 'completedAt',
  'worker',
]);

export function createJob({ url, format, quality }) {
  const now = new Date().toISOString();
  const res = db.prepare(
    `INSERT INTO yt_jobs (url, format, quality, status, progress, createdAt)
     VALUES (?, ?, ?, 'queued', 0, ?)`
  ).run(url, format, quality, now);
  return getJob(res.lastInsertRowid);
}

export function getJob(id) {
  return db.prepare('SELECT * FROM yt_jobs WHERE id = ?').get(id) || null;
}

// Paginated. Returns { items, total, page, pageSize, pages } — matches
// the contract every other library list endpoint on this BE uses.
// Legacy `limit` arg still honoured (treated as pageSize, page 1).
export function listJobs({ status, page = 1, pageSize, limit } = {}) {
  const requested = pageSize ?? limit ?? 30;
  const pg = Math.max(parseInt(page, 10) || 1, 1);
  const ps = Math.min(Math.max(parseInt(requested, 10) || 30, 1), 1000);
  const offset = (pg - 1) * ps;

  const where = [];
  const params = [];
  if (status && status !== 'all') { where.push('status = ?'); params.push(status); }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const items = db.prepare(
    `SELECT * FROM yt_jobs ${whereClause}
       ORDER BY createdAt DESC LIMIT ? OFFSET ?`
  ).all(...params, ps, offset);

  const totalRow = db.prepare(
    `SELECT COUNT(*) AS n FROM yt_jobs ${whereClause}`
  ).get(...params);
  const total = Number(totalRow?.n || 0);

  return {
    items,
    total,
    page: pg,
    pageSize: ps,
    limit: ps,
    pages: Math.max(1, Math.ceil(total / ps)),
  };
}

export function updateJob(id, patch) {
  const cols = Object.keys(patch).filter(c => ALLOWED_UPDATES.has(c));
  if (!cols.length) return getJob(id);
  const params = { id };
  for (const c of cols) params[c] = patch[c];
  const set = cols.map(c => `${c} = @${c}`).join(', ');
  db.prepare(`UPDATE yt_jobs SET ${set} WHERE id = @id`).run(params);
  return getJob(id);
}

export function deleteJob(id) {
  const r = db.prepare('DELETE FROM yt_jobs WHERE id = ?').run(id);
  return r.changes > 0;
}

// Sweep helpers used by the master cron — terminal rows older than N
// hours get pruned along with their on-disk files.
export function listExpiredJobs(hours = 48) {
  return db.prepare(
    `SELECT * FROM yt_jobs
     WHERE status IN ('completed','failed')
       AND completedAt IS NOT NULL
       AND completedAt < datetime('now', ?)`
  ).all(`-${hours} hours`);
}
