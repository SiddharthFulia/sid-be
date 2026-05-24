// combined_videos SQLite helpers. Schema in services/aiVideo/db.js.

import { db } from '../aiVideo/db.js';

const UPDATABLE = new Set([
  'status', 'progress', 'strategy', 'outputPath', 'fileSize',
  'error', 'title', 'completedAt',
]);

export function createCombine({ sources, title }) {
  const now = new Date().toISOString();
  const res = db.prepare(
    `INSERT INTO combined_videos (sources, title, status, progress, createdAt)
     VALUES (?, ?, 'queued', 0, ?)`
  ).run(JSON.stringify(sources), title || null, now);
  return getCombine(res.lastInsertRowid);
}

export function getCombine(id) {
  const row = db.prepare('SELECT * FROM combined_videos WHERE id = ?').get(id);
  if (!row) return null;
  try { row.sources = JSON.parse(row.sources || '[]'); } catch { row.sources = []; }
  return row;
}

export function listCombines({ limit = 30 } = {}) {
  return db.prepare(
    `SELECT id, title, status, progress, strategy, fileSize, error, createdAt, completedAt
     FROM combined_videos ORDER BY createdAt DESC LIMIT ?`
  ).all(limit);
}

export function updateCombine(id, patch) {
  const cols = Object.keys(patch).filter(c => UPDATABLE.has(c));
  if (!cols.length) return getCombine(id);
  const params = { id };
  for (const c of cols) params[c] = patch[c];
  const set = cols.map(c => `${c} = @${c}`).join(', ');
  db.prepare(`UPDATE combined_videos SET ${set} WHERE id = @id`).run(params);
  return getCombine(id);
}

export function deleteCombine(id) {
  const r = db.prepare('DELETE FROM combined_videos WHERE id = ?').run(id);
  return r.changes > 0;
}

// Sweep helpers — terminal rows + files older than N hours.
export function listExpiredCombines(hours = 48) {
  return db.prepare(
    `SELECT * FROM combined_videos
     WHERE status IN ('completed','failed')
       AND completedAt IS NOT NULL
       AND completedAt < datetime('now', ?)`
  ).all(`-${hours} hours`);
}
