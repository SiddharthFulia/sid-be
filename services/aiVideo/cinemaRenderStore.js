// cinema_renders SQLite helpers — one row per "render this project"
// attempt. Drives the resumable /cinema/render/:renderId page. The FE
// orchestrator owns the actual chain (per-shot generateVideo +
// frame-extract + combine); this store is the durable source of truth
// for where the chain currently is so a refresh / cross-device visit
// can pick up the live view.

import { randomUUID } from 'crypto';
import { db } from './db.js';

export function newRenderId() {
  return `cr_${Date.now()}_${randomUUID().slice(0, 8)}`;
}

const insertStmt = db.prepare(`INSERT INTO cinema_renders (
  renderId, projectId, status, phase, currentShotIndex, shotCount,
  shotJobIds, combineJobId, finalDownloadHref, error, vault,
  createdAt, updatedAt, completedAt
) VALUES (
  @renderId, @projectId, @status, @phase, @currentShotIndex, @shotCount,
  @shotJobIds, @combineJobId, @finalDownloadHref, @error, @vault,
  @createdAt, @updatedAt, @completedAt
)`);

const selectStmt = db.prepare('SELECT * FROM cinema_renders WHERE renderId = ?');
const deleteStmt = db.prepare('DELETE FROM cinema_renders WHERE renderId = ?');

const UPDATABLE = new Set([
  'status', 'phase', 'currentShotIndex',
  'shotJobIds', 'combineJobId', 'finalDownloadHref',
  'error', 'completedAt',
]);

function deserialize(row) {
  if (!row) return null;
  let shotJobIds = [];
  try { shotJobIds = row.shotJobIds ? JSON.parse(row.shotJobIds) : []; } catch {}
  if (!Array.isArray(shotJobIds)) shotJobIds = [];
  return { ...row, shotJobIds };
}

export function createCinemaRender({ projectId, shotCount, vault = 0 }) {
  const now = new Date().toISOString();
  const row = {
    renderId: newRenderId(),
    projectId,
    status: 'queued',
    phase: 'idle',
    currentShotIndex: 0,
    shotCount,
    shotJobIds: JSON.stringify(Array(shotCount).fill(null)),
    combineJobId: null,
    finalDownloadHref: null,
    error: null,
    vault: vault ? 1 : 0,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };
  insertStmt.run(row);
  return deserialize(selectStmt.get(row.renderId));
}

export function getCinemaRender(renderId) {
  return deserialize(selectStmt.get(renderId));
}

export function updateCinemaRender(renderId, patch) {
  const existing = selectStmt.get(renderId);
  if (!existing) return null;
  const cols = Object.keys(patch).filter(c => UPDATABLE.has(c));
  if (cols.length === 0) return deserialize(existing);
  const params = { renderId, updatedAt: new Date().toISOString() };
  for (const c of cols) {
    // shotJobIds arrives as an array — stash as JSON.
    if (c === 'shotJobIds' && Array.isArray(patch[c])) {
      params[c] = JSON.stringify(patch[c]);
    } else {
      params[c] = patch[c];
    }
  }
  const set = [...cols.map(c => `${c} = @${c}`), 'updatedAt = @updatedAt'].join(', ');
  db.prepare(`UPDATE cinema_renders SET ${set} WHERE renderId = @renderId`).run(params);
  return deserialize(selectStmt.get(renderId));
}

export function deleteCinemaRender(renderId) {
  return deleteStmt.run(renderId).changes > 0;
}

// Paginated list — returns { items, total, page, pageSize, pages }. Per
// the universal pagination contract.
export function listCinemaRenders({ projectId, status, page = 1, pageSize = 24, vault = 0 } = {}) {
  const pg = Math.max(parseInt(page, 10) || 1, 1);
  const ps = Math.min(Math.max(parseInt(pageSize, 10) || 24, 1), 1000);
  const offset = (pg - 1) * ps;

  const where = [];
  const params = {};
  if (!vault) { where.push('vault = 0'); }
  if (projectId) { where.push('projectId = @projectId'); params.projectId = projectId; }
  if (status && status !== 'all') { where.push('status = @status'); params.status = status; }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const items = db.prepare(
    `SELECT * FROM cinema_renders ${whereSql}
       ORDER BY createdAt DESC
       LIMIT @ps OFFSET @offset`
  ).all({ ...params, ps, offset }).map(deserialize);

  const totalRow = db.prepare(
    `SELECT COUNT(*) AS n FROM cinema_renders ${whereSql}`
  ).get(params);
  const total = Number(totalRow?.n || 0);

  return { items, total, page: pg, pageSize: ps, pages: Math.max(1, Math.ceil(total / ps)) };
}
