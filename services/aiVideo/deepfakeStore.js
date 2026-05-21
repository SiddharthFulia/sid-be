// Deepfake-job SQLite store. Vault-gated lane that handles:
//   • 'face-swap' — source face → target image (insightface 5090)
//   • 'voice-any' — voice clone of arbitrary voice (skips public attestation;
//                   the Vault gate replaces it)
// Shape mirrors meshStore — one row per request, lazy ALTER columns wherever
// kind-specific fields appear.

import { randomUUID } from 'crypto';
import { db } from './db.js';

export function newDeepfakeJobId() {
  return `df_${Date.now()}_${randomUUID().slice(0, 8)}`;
}

const insertStmt = db.prepare(`INSERT INTO deepfake_jobs (
  jobId, status, kind, model,
  sourceUrl, targetUrl, melodyUrl, prompt, language,
  outputUrl, publicId, bytes, elapsedMs,
  error, workerId, progressMessage,
  createdAt, startedAt, completedAt
) VALUES (
  @jobId, @status, @kind, @model,
  @sourceUrl, @targetUrl, @melodyUrl, @prompt, @language,
  @outputUrl, @publicId, @bytes, @elapsedMs,
  @error, @workerId, @progressMessage,
  @createdAt, @startedAt, @completedAt
)`);

const selectStmt = db.prepare('SELECT * FROM deepfake_jobs WHERE jobId = ?');
const deleteStmt = db.prepare('DELETE FROM deepfake_jobs WHERE jobId = ?');

const COLUMNS = new Set([
  'status', 'kind', 'model',
  'sourceUrl', 'targetUrl', 'melodyUrl', 'prompt', 'language',
  'outputUrl', 'publicId', 'bytes', 'elapsedMs',
  'error', 'workerId', 'progressMessage',
  'startedAt', 'completedAt',
  // Voice-any analysis JSON (added 2026-05-22). Same shape as audio_jobs.
  'analysis',
]);

export function createDeepfakeJob({
  kind, model = null, sourceUrl = null, targetUrl = null,
  melodyUrl = null, prompt = null, language = null,
} = {}) {
  const row = {
    jobId: newDeepfakeJobId(),
    status: 'queued',
    kind,
    model,
    sourceUrl,
    targetUrl,
    melodyUrl,
    prompt,
    language,
    outputUrl: null,
    publicId: null,
    bytes: null,
    elapsedMs: null,
    error: null,
    workerId: null,
    progressMessage: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
  };
  insertStmt.run(row);
  return row;
}

export function getDeepfakeJob(jobId) {
  return selectStmt.get(jobId) || null;
}

export function updateDeepfakeJob(jobId, patch) {
  const existing = selectStmt.get(jobId);
  if (!existing) return null;
  const cols = Object.keys(patch).filter(c => COLUMNS.has(c));
  if (cols.length === 0) return existing;
  const set = cols.map(c => `${c} = @${c}`).join(', ');
  db.prepare(`UPDATE deepfake_jobs SET ${set} WHERE jobId = @jobId`)
    .run({ jobId, ...Object.fromEntries(cols.map(c => [c, patch[c]])) });
  return selectStmt.get(jobId);
}

export function deleteDeepfakeJob(jobId) {
  return deleteStmt.run(jobId).changes > 0;
}

export function listDeepfakeJobs({ status, kind, limit = 24 } = {}) {
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 24, 1), 200);
  const where = [];
  const params = [];
  if (status) { where.push('status = ?'); params.push(status); }
  if (kind)   { where.push('kind = ?');   params.push(kind); }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db.prepare(
    `SELECT * FROM deepfake_jobs ${whereClause} ORDER BY createdAt DESC LIMIT ?`
  ).all(...params, safeLimit);
}

export function getNextQueuedDeepfakeJob() {
  return db.prepare(
    "SELECT * FROM deepfake_jobs WHERE status = 'queued' ORDER BY createdAt ASC LIMIT 1"
  ).get() || null;
}
