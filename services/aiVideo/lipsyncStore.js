// SQLite store for the Lip Sync lane (LatentSync + future MuseTalk / LivePortrait).
// Mirrors enhancedImageStore.js shape so the controller code stays consistent.

import { randomUUID } from 'crypto';
import { db } from './db.js';

export function newLipsyncJobId() {
  return `lip_${Date.now()}_${randomUUID().slice(0, 8)}`;
}

const insertStmt = db.prepare(`INSERT INTO lipsync_jobs (
  jobId, status, audioUrl, portraitUrl, outputUrl, prompt, model,
  error, bytes, workerId, durationMs, logs, vault,
  createdAt, startedAt, completedAt
) VALUES (
  @jobId, @status, @audioUrl, @portraitUrl, @outputUrl, @prompt, @model,
  @error, @bytes, @workerId, @durationMs, @logs, @vault,
  @createdAt, @startedAt, @completedAt
)`);

const selectStmt = db.prepare('SELECT * FROM lipsync_jobs WHERE jobId = ?');
const deleteStmt = db.prepare('DELETE FROM lipsync_jobs WHERE jobId = ?');
const nextQueuedStmt = db.prepare(
  "SELECT * FROM lipsync_jobs WHERE status = 'queued' ORDER BY createdAt ASC LIMIT 1"
);

const COLUMNS = new Set([
  'status', 'audioUrl', 'portraitUrl', 'outputUrl', 'prompt', 'model',
  'error', 'bytes', 'workerId', 'durationMs', 'logs', 'vault',
  'startedAt', 'completedAt',
]);

// Routed through the shared job_logs table — see logStore.js. Legacy
// `logs` column on lipsync_jobs is unused for new writes.
import { appendLog as _appendLog } from './logStore.js';
export function appendLipsyncLog(jobId, line) {
  _appendLog(jobId, 'lipsync', line);
  return true;
}

export function createLipsyncJob(data) {
  const row = {
    jobId: newLipsyncJobId(),
    status: 'queued',
    audioUrl: null,
    portraitUrl: null,
    outputUrl: null,
    prompt: null,
    model: 'latentsync',
    error: null,
    bytes: null,
    workerId: null,
    durationMs: null,
    logs: null,
    vault: 0,
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    ...data,
  };
  insertStmt.run(row);
  return row;
}

export function getLipsyncJob(jobId) {
  return selectStmt.get(jobId) || null;
}

export function updateLipsyncJob(jobId, patch) {
  const existing = selectStmt.get(jobId);
  if (!existing) return null;
  const cols = Object.keys(patch).filter(c => COLUMNS.has(c));
  if (cols.length === 0) return existing;
  const set = cols.map(c => `${c} = @${c}`).join(', ');
  db.prepare(`UPDATE lipsync_jobs SET ${set} WHERE jobId = @jobId`)
    .run({ jobId, ...Object.fromEntries(cols.map(c => [c, patch[c]])) });
  return selectStmt.get(jobId);
}

export function deleteLipsyncJob(jobId) {
  return deleteStmt.run(jobId).changes > 0;
}

export function getNextQueuedLipsyncJob() {
  return nextQueuedStmt.get() || null;
}

// Paginated list with status + vault filter.
export function listLipsyncJobs({ status, vault, page = 1, limit = 24 } = {}) {
  const offset = (Math.max(page, 1) - 1) * limit;
  const where = [];
  const params = { limit, offset };
  if (status) { where.push('status = @status'); params.status = status; }
  if (vault === 0 || vault === 1) { where.push('vault = @vault'); params.vault = vault; }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const items = db.prepare(
    `SELECT * FROM lipsync_jobs ${whereClause} ORDER BY createdAt DESC LIMIT @limit OFFSET @offset`
  ).all(params);
  const total = db.prepare(
    `SELECT COUNT(*) AS n FROM lipsync_jobs ${whereClause}`
  ).get(params).n;
  return { items, total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) };
}
