// SQLite store for Cinema mode — multi-shot orchestration on top of the
// video lane. A project owns N shot prompts and N child video jobIds;
// completion = all shots rendered + ffmpeg stitched.

import { randomUUID } from 'crypto';
import { db } from './db.js';

export function newCinemaProjectId() {
  return `cin_${Date.now()}_${randomUUID().slice(0, 8)}`;
}

const insertStmt = db.prepare(`INSERT INTO cinema_projects (
  projectId, status, masterPrompt, shotCount, shotPrompts, shotJobIds,
  outputUrl, error, durationPerShot, aspectRatio, resolution, vault,
  createdAt, completedAt
) VALUES (
  @projectId, @status, @masterPrompt, @shotCount, @shotPrompts, @shotJobIds,
  @outputUrl, @error, @durationPerShot, @aspectRatio, @resolution, @vault,
  @createdAt, @completedAt
)`);

const selectStmt = db.prepare('SELECT * FROM cinema_projects WHERE projectId = ?');
const deleteStmt = db.prepare('DELETE FROM cinema_projects WHERE projectId = ?');

const COLUMNS = new Set([
  'status', 'masterPrompt', 'shotCount', 'shotPrompts', 'shotJobIds',
  'outputUrl', 'error', 'durationPerShot', 'aspectRatio', 'resolution', 'vault',
  'completedAt',
]);

export function createCinemaProject(data) {
  const row = {
    projectId: newCinemaProjectId(),
    status: 'planning',
    masterPrompt: '',
    shotCount: 4,
    shotPrompts: null,
    shotJobIds: null,
    outputUrl: null,
    error: null,
    durationPerShot: 5,
    aspectRatio: '16:9',
    resolution: '720p',
    vault: 0,
    createdAt: new Date().toISOString(),
    completedAt: null,
    ...data,
  };
  // shotPrompts / shotJobIds are stored as JSON strings if arrays
  if (Array.isArray(row.shotPrompts)) row.shotPrompts = JSON.stringify(row.shotPrompts);
  if (Array.isArray(row.shotJobIds)) row.shotJobIds = JSON.stringify(row.shotJobIds);
  insertStmt.run(row);
  return row;
}

function deserialize(row) {
  if (!row) return null;
  return {
    ...row,
    shotPrompts: row.shotPrompts ? safeParse(row.shotPrompts, []) : [],
    shotJobIds:  row.shotJobIds  ? safeParse(row.shotJobIds, [])  : [],
  };
}

function safeParse(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

export function getCinemaProject(projectId) {
  return deserialize(selectStmt.get(projectId));
}

export function updateCinemaProject(projectId, patch) {
  const existing = selectStmt.get(projectId);
  if (!existing) return null;
  const cols = Object.keys(patch).filter(c => COLUMNS.has(c));
  if (cols.length === 0) return deserialize(existing);
  const params = { projectId };
  for (const c of cols) {
    let v = patch[c];
    if (Array.isArray(v)) v = JSON.stringify(v);
    params[c] = v;
  }
  const set = cols.map(c => `${c} = @${c}`).join(', ');
  db.prepare(`UPDATE cinema_projects SET ${set} WHERE projectId = @projectId`).run(params);
  return deserialize(selectStmt.get(projectId));
}

export function deleteCinemaProject(projectId) {
  return deleteStmt.run(projectId).changes > 0;
}

export function listCinemaProjects({ status, vault, page = 1, limit = 24 } = {}) {
  const offset = (Math.max(page, 1) - 1) * limit;
  const where = [];
  const params = { limit, offset };
  if (status) { where.push('status = @status'); params.status = status; }
  if (vault === 0 || vault === 1) { where.push('vault = @vault'); params.vault = vault; }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.prepare(
    `SELECT * FROM cinema_projects ${whereClause} ORDER BY createdAt DESC LIMIT @limit OFFSET @offset`
  ).all(params);
  const total = db.prepare(
    `SELECT COUNT(*) AS n FROM cinema_projects ${whereClause}`
  ).get(params).n;
  return { items: rows.map(deserialize), total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) };
}
