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
  'shotModels', 'shotMusic',
  'continuityBible', 'lockedSeed', 'motionStrength', 'heroImageUrl',
  'directorState', 'continuityMode', 'overlapMode', 'realismMode',
  'stepsPerShot', 'shotNegatives',
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
  // shotPrompts / shotJobIds / shotModels / shotMusic stored as JSON
  if (Array.isArray(row.shotPrompts)) row.shotPrompts = JSON.stringify(row.shotPrompts);
  if (Array.isArray(row.shotJobIds))  row.shotJobIds  = JSON.stringify(row.shotJobIds);
  if (Array.isArray(row.shotModels))  row.shotModels  = JSON.stringify(row.shotModels);
  if (Array.isArray(row.shotMusic))   row.shotMusic   = JSON.stringify(row.shotMusic.map(v => v ? 1 : 0));
  insertStmt.run(row);
  return row;
}

function deserialize(row) {
  if (!row) return null;
  return {
    ...row,
    shotPrompts: row.shotPrompts ? safeParse(row.shotPrompts, []) : [],
    shotJobIds:  row.shotJobIds  ? safeParse(row.shotJobIds, [])  : [],
    shotModels:  row.shotModels  ? safeParse(row.shotModels, [])  : [],
    // Per-shot Groq-emitted negatives. Strings; length matches
    // shotPrompts when Groq played ball. Empty/null entries are OK
    // (chain just uses the global base negative for that shot).
    shotNegatives: row.shotNegatives
      ? safeParse(row.shotNegatives, []).map(v => typeof v === 'string' ? v : '')
      : [],
    // shotMusic stored as JSON of 0/1; coerce back to booleans on read
    // so the FE never has to translate (the toggle binds to a boolean).
    shotMusic:   row.shotMusic
      ? safeParse(row.shotMusic, []).map(v => !!v)
      : [],
    // continuityBible is a JSON object, NOT an array. Stored as a
    // string column so the FE can mutate any field without a schema
    // change. Defaults to an empty object so the FE can render its
    // editor cleanly when the project predates this feature.
    continuityBible: row.continuityBible
      ? safeParse(row.continuityBible, {})
      : {},
    // Cinematic Continuity Director state — JSON object with
    // physicalState / cameraState / emotionArc / negativeContinuityRules.
    // Defaults to {} when never populated so the FE can render the
    // editor cleanly on legacy projects.
    directorState: row.directorState
      ? safeParse(row.directorState, {})
      : {},
    // Boolean toggles persisted as 0/1; coerce to JS booleans here.
    continuityMode: row.continuityMode == null ? true  : !!row.continuityMode,
    overlapMode:    row.overlapMode    == null ? false : !!row.overlapMode,
    realismMode:    row.realismMode    == null ? true  : !!row.realismMode,
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
    // continuityBible + directorState are JSON objects; stringify
    // them like the array columns. Plain primitives pass through.
    else if ((c === 'continuityBible' || c === 'directorState') && v && typeof v === 'object') v = JSON.stringify(v);
    // Booleans → 0/1 for SQLite.
    else if ((c === 'continuityMode' || c === 'overlapMode' || c === 'realismMode') && typeof v === 'boolean') v = v ? 1 : 0;
    params[c] = v;
  }
  const set = cols.map(c => `${c} = @${c}`).join(', ');
  db.prepare(`UPDATE cinema_projects SET ${set} WHERE projectId = @projectId`).run(params);
  return deserialize(selectStmt.get(projectId));
}

export function deleteCinemaProject(projectId) {
  return deleteStmt.run(projectId).changes > 0;
}

export function getCinemaProjectsByIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  return db.prepare(`SELECT * FROM cinema_projects WHERE projectId IN (${placeholders})`).all(...ids).map(deserialize);
}

export function deleteCinemaProjects(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return 0;
  const stmt = db.prepare('DELETE FROM cinema_projects WHERE projectId = ?');
  const tx = db.transaction((batch) => {
    let n = 0;
    for (const id of batch) n += stmt.run(id).changes;
    return n;
  });
  return tx(ids);
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
