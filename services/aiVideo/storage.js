// Inflight-job store. Same API as the original JSON-backed module — every
// caller (controllers/v1/aiVideo.js, gpuWorker.js) keeps working unchanged.
// Now persisted in SQLite (services/aiVideo/db.js) for proper indexes,
// concurrent reads while a worker streams /job-progress updates, and
// O(log n) status lookups instead of O(n) full-file rewrites.

import { randomUUID } from 'crypto';
import { db, jobToRow, rowToJob } from './db.js';

export function newVideoId() {
  return `vid_${Date.now()}_${randomUUID().slice(0, 8)}`;
}

const insertStmt = db.prepare(`INSERT INTO jobs (
  videoId, provider, originalProvider, status, prompt, model, duration,
  resolution, aspectRatio, steps, style, audio, imageUrl, generateCaption,
  attemptCount, createdAt, startedAt, completedAt, videoUrl, caption, error,
  workerId, estimatedSeconds, progressMessage, progressStep, progressTotal, logs,
  withMusic, musicPrompt
) VALUES (
  @videoId, @provider, @originalProvider, @status, @prompt, @model, @duration,
  @resolution, @aspectRatio, @steps, @style, @audio, @imageUrl, @generateCaption,
  @attemptCount, @createdAt, @startedAt, @completedAt, @videoUrl, @caption, @error,
  @workerId, @estimatedSeconds, @progressMessage, @progressStep, @progressTotal, @logs,
  @withMusic, @musicPrompt
)`);

const selectStmt   = db.prepare('SELECT * FROM jobs WHERE videoId = ?');
const deleteStmt   = db.prepare('DELETE FROM jobs WHERE videoId = ?');
const listAllStmt  = db.prepare('SELECT * FROM jobs ORDER BY createdAt DESC LIMIT 200');
const nextRoleStmt = db.prepare(
  "SELECT * FROM jobs WHERE provider = ? AND status = 'queued' ORDER BY createdAt ASC LIMIT 1"
);

const COLUMN_SET = new Set([
  'videoId', 'provider', 'originalProvider', 'status', 'prompt', 'model',
  'duration', 'resolution', 'aspectRatio', 'steps', 'style', 'audio',
  'imageUrl', 'generateCaption', 'attemptCount', 'createdAt', 'startedAt',
  'completedAt', 'videoUrl', 'caption', 'error', 'workerId',
  'estimatedSeconds', 'progressMessage', 'progressStep', 'progressTotal',
  'logs', 'withMusic', 'musicPrompt', 'vault',
]);

export async function createInflightJob(jobData) {
  const job = {
    videoId: newVideoId(),
    status: 'queued',
    attemptCount: 0,
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    videoUrl: null,
    caption: null,
    error: null,
    workerId: null,
    logs: [],
    ...jobData,
  };
  insertStmt.run(jobToRow(job));
  return job;
}

export async function getInflightJob(videoId) {
  return rowToJob(selectStmt.get(videoId));
}

export async function updateInflightJob(videoId, patch) {
  const existing = rowToJob(selectStmt.get(videoId));
  if (!existing) return null;
  // Build a dynamic UPDATE so we only touch the columns the caller mutated.
  // This keeps `logs` rewrites narrow and lets concurrent /job-progress
  // writers play nicely under WAL.
  const cols = Object.keys(patch).filter(k => COLUMN_SET.has(k));
  if (cols.length === 0) return existing;
  const merged = { ...existing, ...patch };
  const row = jobToRow(merged);
  const set = cols.map(c => `${c} = @${c}`).join(', ');
  const params = { videoId, ...Object.fromEntries(cols.map(c => [c, row[c]])) };
  db.prepare(`UPDATE jobs SET ${set} WHERE videoId = @videoId`).run(params);
  return rowToJob(selectStmt.get(videoId));
}

export async function removeInflightJob(videoId) {
  return deleteStmt.run(videoId).changes > 0;
}

export async function getNextQueuedWorkerJob() {
  return getNextQueuedForRole('worker');
}

export async function getNextQueuedForRole(role) {
  return rowToJob(nextRoleStmt.get(role));
}

export async function listInflightJobs() {
  return listAllStmt.all().map(rowToJob);
}
