// Unified log feed for all four lanes (video / image / lipsync / audio).
// Lives in its own table (job_logs) so the main job tables stay small.
//
// Append-only by design — there's no UPDATE path. Old logs grow the table
// but never the per-job row, and the (jobId, lane, ts DESC) index makes
// the only hot query — tail-of-this-job — instant regardless of total size.
//
// FE pattern:
//   • POST /api/<lane>      → job submitted, jobId returned
//   • GET  /api/<lane>/status/:jobId  → full row (polled every ~5s for status)
//   • GET  /api/job-logs/:lane/:jobId?since=<ms>  → just log delta (every 1.5s)
//
// The `since` cursor means each poll only returns new lines, not the whole
// history. The FE keeps the running list locally and appends.

import { db } from './db.js';

const VALID_LANES = new Set(['video', 'image', 'lipsync', 'audio', 'mesh', 'combine', 'deepfake']);

const insertStmt = db.prepare(
  'INSERT INTO job_logs (jobId, lane, ts, msg, cinemaRenderId) VALUES (@jobId, @lane, @ts, @msg, @cinemaRenderId)'
);
const listSinceStmt = db.prepare(
  `SELECT ts, msg FROM job_logs
    WHERE jobId = @jobId AND lane = @lane AND ts > @since
    ORDER BY ts ASC
    LIMIT @limit`
);
const listAllStmt = db.prepare(
  `SELECT ts, msg FROM job_logs
    WHERE jobId = @jobId AND lane = @lane
    ORDER BY ts DESC
    LIMIT @limit`
);
// Unified-by-render query — every log across every shot + the combine
// step in one chronologically-ordered stream. Annotated with jobId
// and lane so the FE can group / colour by shot.
const listByRenderStmt = db.prepare(
  `SELECT jobId, lane, ts, msg FROM job_logs
    WHERE cinemaRenderId = @renderId AND ts > @since
    ORDER BY ts ASC
    LIMIT @limit`
);

// Tiny in-memory cache: jobId → renderId. Populated by tagJobsToRender()
// when the cinema chain queues a shot, consulted by appendLog so worker
// logs land with the right cinemaRenderId WITHOUT a SQL lookup on every
// log write. Cleared on process restart — that's fine; logs written in
// the gap stay untagged, and the chain unblocks once the next shot of
// the render kicks off (which re-populates the cache via tagJobsToRender).
const jobIdToRenderId = new Map();

export function tagJobsToRender(renderId, jobIds = []) {
  if (!renderId || !Array.isArray(jobIds)) return;
  for (const jobId of jobIds) {
    if (jobId) jobIdToRenderId.set(jobId, renderId);
  }
}

export function untagJob(jobId) {
  if (jobId) jobIdToRenderId.delete(jobId);
}

/**
 * Append a single log line. Truncates msg at 300 chars to keep rows small.
 * If the jobId has been tagged with a cinema renderId (via
 * tagJobsToRender), the row is stamped with that renderId so the unified
 * /api/cinema/render/:renderId/logs endpoint can include it. Optional
 * `explicitRenderId` overrides the cache (used by the orchestrator for
 * combine-step logs where the cache might not be populated yet).
 * Returns the inserted row's id.
 */
export function appendLog(jobId, lane, msg, explicitRenderId = null) {
  if (!jobId || !VALID_LANES.has(lane)) return null;
  const line = String(msg || '').slice(0, 300);
  if (!line) return null;
  const cinemaRenderId = explicitRenderId || jobIdToRenderId.get(jobId) || null;
  const info = insertStmt.run({
    jobId, lane, ts: Date.now(), msg: line, cinemaRenderId,
  });
  return info.lastInsertRowid;
}

/**
 * List logs for a job. Two modes:
 *  • since > 0  → only entries newer than that ms epoch, ASC (cursor poll)
 *  • since = 0  → most recent `limit` entries, ASC after reversal (initial load)
 */
export function listLogs({ jobId, lane, sinceTs = 0, limit = 80 } = {}) {
  if (!jobId || !VALID_LANES.has(lane)) return [];
  const safeLimit = Math.min(Math.max(limit, 1), 500);
  if (sinceTs > 0) {
    return listSinceStmt.all({ jobId, lane, since: sinceTs, limit: safeLimit });
  }
  // Initial load — grab last N descending, then flip to chronological order
  return listAllStmt.all({ jobId, lane, limit: safeLimit }).reverse();
}

// Stream of every log written under a cinema renderId, across every
// shot + the combine step, in one ordered timeline. Each row carries
// its own jobId + lane so the FE can colour by shot / step.
export function listLogsByRender({ renderId, sinceTs = 0, limit = 500 } = {}) {
  if (!renderId) return [];
  const safeLimit = Math.min(Math.max(limit, 1), 2000);
  return listByRenderStmt.all({ renderId, since: sinceTs, limit: safeLimit });
}

/** Convenience for status endpoints — returns the last 80 entries. */
export function listRecentLogs(jobId, lane) {
  return listLogs({ jobId, lane, limit: 80 });
}
