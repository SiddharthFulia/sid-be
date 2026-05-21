// SQLite store for the Audio Studio lane (MusicGen + Stable Audio Open + Bark).
// Same shape as lipsyncStore — keeps the controller code uniform.

import { randomUUID } from 'crypto';
import { db } from './db.js';

export function newAudioJobId() {
  return `aud_${Date.now()}_${randomUUID().slice(0, 8)}`;
}

const insertStmt = db.prepare(`INSERT INTO audio_jobs (
  jobId, status, kind, model, prompt, duration, voice,
  outputUrl, bytes, error, workerId, logs, vault,
  createdAt, startedAt, completedAt
) VALUES (
  @jobId, @status, @kind, @model, @prompt, @duration, @voice,
  @outputUrl, @bytes, @error, @workerId, @logs, @vault,
  @createdAt, @startedAt, @completedAt
)`);

const selectStmt = db.prepare('SELECT * FROM audio_jobs WHERE jobId = ?');
const deleteStmt = db.prepare('DELETE FROM audio_jobs WHERE jobId = ?');
const nextQueuedStmt = db.prepare(
  "SELECT * FROM audio_jobs WHERE status = 'queued' ORDER BY createdAt ASC LIMIT 1"
);

const COLUMNS = new Set([
  'status', 'kind', 'model', 'prompt', 'duration', 'voice',
  'outputUrl', 'bytes', 'error', 'workerId', 'logs', 'vault',
  'startedAt', 'completedAt',
  // STT-specific columns (added 2026-05-19). transcript holds the text
  // result for kind=stt jobs; sourceUrl holds the Cloudinary URL of the
  // uploaded audio so the worker can fetch + transcribe.
  'transcript', 'sourceUrl',
  // Source-separation result (added 2026-05-19). JSON string with the
  // four stem URLs + optional lyrics. Only used when kind='separate'.
  'stems',
  // Voice-clone analysis JSON (added 2026-05-22). Stats on input ref clip,
  // cleaned ref, output WAV, words/sec, chunk count. Rendered as the
  // comparison card on the audio detail / library cards.
  'analysis',
]);

// Routed through the shared job_logs table — see logStore.js.
import { appendLog as _appendLog } from './logStore.js';
export function appendAudioLog(jobId, line) {
  _appendLog(jobId, 'audio', line);
  return true;
}

export function createAudioJob(data) {
  const row = {
    jobId: newAudioJobId(),
    status: 'queued',
    kind: 'music',
    model: 'musicgen',
    prompt: '',
    duration: 10,
    voice: null,
    outputUrl: null,
    bytes: null,
    error: null,
    workerId: null,
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

export function getAudioJob(jobId) {
  return selectStmt.get(jobId) || null;
}

export function updateAudioJob(jobId, patch) {
  const existing = selectStmt.get(jobId);
  if (!existing) return null;
  const cols = Object.keys(patch).filter(c => COLUMNS.has(c));
  if (cols.length === 0) return existing;
  const set = cols.map(c => `${c} = @${c}`).join(', ');
  db.prepare(`UPDATE audio_jobs SET ${set} WHERE jobId = @jobId`)
    .run({ jobId, ...Object.fromEntries(cols.map(c => [c, patch[c]])) });
  return selectStmt.get(jobId);
}

export function deleteAudioJob(jobId) {
  return deleteStmt.run(jobId).changes > 0;
}

export function getAudioJobsByIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  return db.prepare(`SELECT * FROM audio_jobs WHERE jobId IN (${placeholders})`).all(...ids);
}

export function deleteAudioJobs(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return 0;
  const stmt = db.prepare('DELETE FROM audio_jobs WHERE jobId = ?');
  const tx = db.transaction((batch) => {
    let n = 0;
    for (const id of batch) n += stmt.run(id).changes;
    return n;
  });
  return tx(ids);
}

export function getNextQueuedAudioJob() {
  return nextQueuedStmt.get() || null;
}

export function listAudioJobs({ status, kind, vault, page = 1, limit = 24 } = {}) {
  const offset = (Math.max(page, 1) - 1) * limit;
  const where = [];
  const params = { limit, offset };
  if (status) { where.push('status = @status'); params.status = status; }
  if (kind)   { where.push('kind = @kind');     params.kind = kind; }
  if (vault === 0 || vault === 1) { where.push('vault = @vault'); params.vault = vault; }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const items = db.prepare(
    `SELECT * FROM audio_jobs ${whereClause} ORDER BY createdAt DESC LIMIT @limit OFFSET @offset`
  ).all(params);
  const total = db.prepare(
    `SELECT COUNT(*) AS n FROM audio_jobs ${whereClause}`
  ).get(params).n;
  return { items, total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) };
}
