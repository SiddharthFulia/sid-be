// combined_videos SQLite helpers. Schema in services/aiVideo/db.js.
//
// Vault propagation: createCombine takes an optional `vault` flag. The
// controller computes it by looking up each source videoId in the
// `videos` table and OR-ing their `vault` fields — if any source is
// vaulted, the combined row is too. Listings then filter on vault to
// match the visibility the caller has been granted.

import { db } from '../aiVideo/db.js';

const UPDATABLE = new Set([
  'status', 'progress', 'strategy', 'outputPath', 'fileSize',
  'error', 'title', 'completedAt', 'vault',
]);

export function createCombine({ sources, title, vault = 0 }) {
  const now = new Date().toISOString();
  const res = db.prepare(
    `INSERT INTO combined_videos (sources, title, status, progress, vault, createdAt)
     VALUES (?, ?, 'queued', 0, ?, ?)`
  ).run(JSON.stringify(sources), title || null, vault ? 1 : 0, now);
  return getCombine(res.lastInsertRowid);
}

export function getCombine(id) {
  const row = db.prepare('SELECT * FROM combined_videos WHERE id = ?').get(id);
  if (!row) return null;
  try { row.sources = JSON.parse(row.sources || '[]'); } catch { row.sources = []; }
  return row;
}

// listCombines now supports:
//   - vault   : 0 → only public rows; 1 → public + vaulted (caller is auth'd)
//   - status  : optional filter ('queued' | 'processing' | 'completed' | 'failed')
//   - page    : 1-based page number
//   - pageSize: rows per page (1..1000)
// Returns { items, total, page, pageSize } — total reflects the same filter.
export function listCombines({ vault = 0, status, page = 1, pageSize = 20 } = {}) {
  const pg = Math.max(1, parseInt(page, 10) || 1);
  const ps = Math.max(1, Math.min(1000, parseInt(pageSize, 10) || 20));
  const offset = (pg - 1) * ps;

  const where = [];
  const params = {};
  if (!vault) { where.push('vault = 0'); }
  if (status) { where.push('status = @status'); params.status = status; }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const items = db.prepare(
    `SELECT id, title, status, progress, strategy, fileSize, error,
            vault, createdAt, completedAt
       FROM combined_videos
       ${whereSql}
       ORDER BY createdAt DESC
       LIMIT @ps OFFSET @offset`
  ).all({ ...params, ps, offset });

  const totalRow = db.prepare(
    `SELECT COUNT(*) AS n FROM combined_videos ${whereSql}`
  ).get(params);

  return { items, total: Number(totalRow?.n || 0), page: pg, pageSize: ps };
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

// Bulk vault toggle — mirror of setVideosVault.
export function setCombinesVault(ids, vault) {
  if (!Array.isArray(ids) || ids.length === 0) return 0;
  const v = vault ? 1 : 0;
  const placeholders = ids.map(() => '?').join(',');
  const stmt = db.prepare(`UPDATE combined_videos SET vault = ? WHERE id IN (${placeholders})`);
  return stmt.run(v, ...ids).changes;
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
