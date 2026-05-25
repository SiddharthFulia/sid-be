// Mesh-job SQLite store for the text-to-3D lane (Shap-E on the 5090, with
// room for future models like LGM / TripoSR). Mirrors chatStore.js exactly:
// FE posts prompt + model + steps, BE creates a row, queues it to mesh_queue,
// worker pulls + runs the pipeline + uploads the GLB to Cloudinary + posts
// back the URL. FE polls /api/mesh/status/:jobId until completed.

import { randomUUID } from 'crypto';
import { db } from './db.js';

export function newMeshJobId() {
  return `mesh_${Date.now()}_${randomUUID().slice(0, 8)}`;
}

const insertStmt = db.prepare(`INSERT INTO mesh_jobs (
  jobId, status, prompt, model, steps,
  seed, guidance, negativePrompt,
  meshQuality, textureQuality, textureResolution, polygonTarget,
  imageUrl,
  glbUrl, publicId, bytes, elapsedMs,
  error, workerId, logs, progressMessage,
  createdAt, startedAt, completedAt
) VALUES (
  @jobId, @status, @prompt, @model, @steps,
  @seed, @guidance, @negativePrompt,
  @meshQuality, @textureQuality, @textureResolution, @polygonTarget,
  @imageUrl,
  @glbUrl, @publicId, @bytes, @elapsedMs,
  @error, @workerId, @logs, @progressMessage,
  @createdAt, @startedAt, @completedAt
)`);

// SELECT * is fine for single-row reads UNTIL we started storing the
// generated GLB as a BLOB in this table — a single row could be 100MB+
// of binary and we don't want every status poll to load that. Enumerate
// every column EXCEPT glbBlob; the binary is only fetched on demand via
// getMeshBlob(jobId).
const MESH_COLS_NO_BLOB = `
  jobId, status, prompt, model, steps,
  seed, guidance, negativePrompt,
  meshQuality, textureQuality, textureResolution, polygonTarget,
  imageUrl,
  glbUrl, publicId, bytes, elapsedMs,
  error, workerId, logs, progressMessage,
  createdAt, startedAt, completedAt
`;
const selectStmt = db.prepare(`SELECT ${MESH_COLS_NO_BLOB} FROM mesh_jobs WHERE jobId = ?`);
const deleteStmt = db.prepare('DELETE FROM mesh_jobs WHERE jobId = ?');

const COLUMNS = new Set([
  'status', 'prompt', 'model', 'steps',
  'seed', 'guidance', 'negativePrompt',
  'meshQuality', 'textureQuality', 'textureResolution', 'polygonTarget',
  'imageUrl',
  'glbUrl', 'glbBlob', 'publicId', 'bytes', 'elapsedMs',
  'error', 'workerId', 'logs', 'progressMessage',
  'startedAt', 'completedAt',
]);

// Read just the binary GLB column for streaming. Kept separate from the
// regular getMeshJob() so list/status reads don't pull a 100MB BLOB into
// memory by accident — only /api/mesh/file/:jobId calls this.
const blobSelectStmt = db.prepare('SELECT glbBlob, bytes FROM mesh_jobs WHERE jobId = ?');
export function getMeshBlob(jobId) {
  const row = blobSelectStmt.get(jobId);
  if (!row || !row.glbBlob) return null;
  return { buffer: row.glbBlob, bytes: row.bytes || row.glbBlob.length };
}

export function createMeshJob({
  prompt, model = 'shap-e', steps = 32,
  seed = null, guidance = null, negativePrompt = null,
  meshQuality = null, textureQuality = null,
  textureResolution = null, polygonTarget = null,
  imageUrl = null,
}) {
  const row = {
    jobId: newMeshJobId(),
    status: 'queued',
    prompt,
    model,
    steps,
    seed,
    guidance,
    negativePrompt,
    meshQuality,
    textureQuality,
    textureResolution,
    polygonTarget,
    imageUrl,
    glbUrl: null,
    publicId: null,
    bytes: null,
    elapsedMs: null,
    error: null,
    workerId: null,
    logs: null,
    progressMessage: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
  };
  insertStmt.run(row);
  return row;
}

export function getMeshJob(jobId) {
  return selectStmt.get(jobId) || null;
}

export function updateMeshJob(jobId, patch) {
  const existing = selectStmt.get(jobId);
  if (!existing) return null;
  const cols = Object.keys(patch).filter(c => COLUMNS.has(c));
  if (cols.length === 0) return existing;
  const set = cols.map(c => `${c} = @${c}`).join(', ');
  db.prepare(`UPDATE mesh_jobs SET ${set} WHERE jobId = @jobId`)
    .run({ jobId, ...Object.fromEntries(cols.map(c => [c, patch[c]])) });
  return selectStmt.get(jobId);
}

export function deleteMeshJob(jobId) {
  return deleteStmt.run(jobId).changes > 0;
}

// Paginated list with optional status filter. Returns
// `{ items, total, page, pageSize }` so the FE library can render with
// antd Pagination + total counter. pageSize clamped to [1, 1000] per
// the same convention combine uses.
export function listMeshJobs({ status, page = 1, pageSize = 24, limit } = {}) {
  // Back-compat: callers that pass `limit` instead of `pageSize` still work.
  const requested = pageSize ?? limit ?? 24;
  const pg = Math.max(parseInt(page, 10) || 1, 1);
  const ps = Math.min(Math.max(parseInt(requested, 10) || 24, 1), 1000);
  const offset = (pg - 1) * ps;

  const where = [];
  const params = {};
  if (status) { where.push('status = @status'); params.status = status; }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const items = db.prepare(
    `SELECT ${MESH_COLS_NO_BLOB} FROM mesh_jobs ${whereSql}
       ORDER BY createdAt DESC
       LIMIT @ps OFFSET @offset`
  ).all({ ...params, ps, offset });

  const totalRow = db.prepare(
    `SELECT COUNT(*) AS n FROM mesh_jobs ${whereSql}`
  ).get(params);

  return { items, total: Number(totalRow?.n || 0), page: pg, pageSize: ps };
}

// Cheap GC — older completed/failed rows after N days. Call from a cron
// if you want; not wired by default.
export function pruneOldMeshJobs(maxAgeDays = 7) {
  const cutoff = new Date(Date.now() - maxAgeDays * 86400 * 1000).toISOString();
  return db.prepare(
    `DELETE FROM mesh_jobs WHERE status IN ('completed', 'failed') AND createdAt < ?`
  ).run(cutoff).changes;
}
