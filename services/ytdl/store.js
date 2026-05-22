// yt_jobs SQLite helpers. Schema lives in services/aiVideo/db.js.

import { db } from '../aiVideo/db.js';

const ALLOWED_UPDATES = new Set([
  'status', 'progress', 'title', 'duration', 'fileSize',
  'fileName', 'filePath', 'thumbnail', 'error', 'pid', 'completedAt',
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

export function listJobs({ limit = 30 } = {}) {
  return db.prepare(
    `SELECT * FROM yt_jobs ORDER BY createdAt DESC LIMIT ?`
  ).all(limit);
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
