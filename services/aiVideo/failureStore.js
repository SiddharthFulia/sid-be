// Permanent-failure audit log. Every time a worker NACKs a job without
// requeue (Cloudinary upload broken, ComfyUI workflow rejected, etc.), the
// gpuWorker controller writes one row here. The FE reads /api/ai-video/failures
// to show a Failures tab so the user can see "what jobs died and why" without
// scrolling through completed videos.
//
// Decoupled from the `jobs` table so we keep the history even after the
// underlying job is cleaned up (e.g. by a future TTL job-eviction cron).

import { db } from './db.js';

const insertStmt = db.prepare(`INSERT INTO failures (
  videoId, originalProvider, workerRole, prompt, model, aspectRatio,
  resolution, duration, steps, imageUrl, error, attemptCount, workerId,
  failedAt, createdAt, durationMs, vault
) VALUES (
  @videoId, @originalProvider, @workerRole, @prompt, @model, @aspectRatio,
  @resolution, @duration, @steps, @imageUrl, @error, @attemptCount, @workerId,
  @failedAt, @createdAt, @durationMs, @vault
)`);

const listStmt = db.prepare(
  'SELECT * FROM failures ORDER BY failedAt DESC LIMIT @limit OFFSET @offset'
);
const listPublicStmt = db.prepare(
  'SELECT * FROM failures WHERE vault = 0 ORDER BY failedAt DESC LIMIT @limit OFFSET @offset'
);
const listByProviderStmt = db.prepare(
  'SELECT * FROM failures WHERE originalProvider = @provider ORDER BY failedAt DESC LIMIT @limit OFFSET @offset'
);
const listByProviderPublicStmt = db.prepare(
  'SELECT * FROM failures WHERE originalProvider = @provider AND vault = 0 ORDER BY failedAt DESC LIMIT @limit OFFSET @offset'
);
const countStmt = db.prepare('SELECT COUNT(*) AS n FROM failures');
const countPublicStmt = db.prepare('SELECT COUNT(*) AS n FROM failures WHERE vault = 0');
const countByProviderStmt = db.prepare(
  'SELECT COUNT(*) AS n FROM failures WHERE originalProvider = ?'
);
const countByProviderPublicStmt = db.prepare(
  'SELECT COUNT(*) AS n FROM failures WHERE originalProvider = ? AND vault = 0'
);
const deleteStmt = db.prepare('DELETE FROM failures WHERE id = ?');
const deleteByVideoStmt = db.prepare('DELETE FROM failures WHERE videoId = ?');

export function recordFailure({ job, error, workerId }) {
  if (!job?.videoId) return;
  const failedAt = new Date().toISOString();
  const created = job.createdAt ? new Date(job.createdAt).getTime() : null;
  insertStmt.run({
    videoId: job.videoId,
    originalProvider: job.originalProvider || job.provider || null,
    workerRole: job.provider || null,
    prompt: job.prompt ?? null,
    model: job.model ?? null,
    aspectRatio: job.aspectRatio ?? null,
    resolution: job.resolution ?? null,
    duration: job.duration ?? null,
    steps: job.steps ?? null,
    imageUrl: job.imageUrl ?? null,
    error: String(error || 'unknown error').slice(0, 4000),
    attemptCount: (job.attemptCount || 0) + 1,
    workerId: workerId || job.workerId || null,
    failedAt,
    createdAt: job.createdAt || null,
    durationMs: created ? Date.now() - created : null,
    vault: job.vault ? 1 : 0,
  });
}

export function listFailures({ provider, page = 1, limit = 20, vault = false } = {}) {
  const offset = (Math.max(page, 1) - 1) * limit;
  // `vault` here means "caller is authenticated and may see vault items".
  // When false, public-only stmts hide vault rows from anonymous visitors.
  if (provider) {
    const stmt = vault ? listByProviderStmt : listByProviderPublicStmt;
    const cnt  = vault ? countByProviderStmt : countByProviderPublicStmt;
    return {
      items: stmt.all({ provider, limit, offset }),
      total: cnt.get(provider).n,
      page,
      limit,
    };
  }
  const stmt = vault ? listStmt : listPublicStmt;
  const cnt  = vault ? countStmt : countPublicStmt;
  return {
    items: stmt.all({ limit, offset }),
    total: cnt.get().n,
    page,
    limit,
  };
}

export function deleteFailure(id) {
  return deleteStmt.run(id).changes > 0;
}

export function deleteFailuresByVideo(videoId) {
  return deleteByVideoStmt.run(videoId).changes;
}
