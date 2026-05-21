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
  glbUrl, publicId, bytes, elapsedMs,
  error, workerId, logs, progressMessage,
  createdAt, startedAt, completedAt
) VALUES (
  @jobId, @status, @prompt, @model, @steps,
  @glbUrl, @publicId, @bytes, @elapsedMs,
  @error, @workerId, @logs, @progressMessage,
  @createdAt, @startedAt, @completedAt
)`);

const selectStmt = db.prepare('SELECT * FROM mesh_jobs WHERE jobId = ?');
const deleteStmt = db.prepare('DELETE FROM mesh_jobs WHERE jobId = ?');

const COLUMNS = new Set([
  'status', 'prompt', 'model', 'steps',
  'glbUrl', 'publicId', 'bytes', 'elapsedMs',
  'error', 'workerId', 'logs', 'progressMessage',
  'startedAt', 'completedAt',
]);

export function createMeshJob({ prompt, model = 'shap-e', steps = 32 }) {
  const row = {
    jobId: newMeshJobId(),
    status: 'queued',
    prompt,
    model,
    steps,
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

// Paginated list with optional status filter. Mirrors the chat-store shape:
// returns the rows array directly (no pagination envelope) so the FE can
// drop them straight into a grid.
export function listMeshJobs({ status, limit = 24 } = {}) {
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 24, 1), 200);
  if (status) {
    return db.prepare(
      `SELECT * FROM mesh_jobs WHERE status = ? ORDER BY createdAt DESC LIMIT ?`
    ).all(status, safeLimit);
  }
  return db.prepare(
    `SELECT * FROM mesh_jobs ORDER BY createdAt DESC LIMIT ?`
  ).all(safeLimit);
}

// Cheap GC — older completed/failed rows after N days. Call from a cron
// if you want; not wired by default.
export function pruneOldMeshJobs(maxAgeDays = 7) {
  const cutoff = new Date(Date.now() - maxAgeDays * 86400 * 1000).toISOString();
  return db.prepare(
    `DELETE FROM mesh_jobs WHERE status IN ('completed', 'failed') AND createdAt < ?`
  ).run(cutoff).changes;
}
