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

const VALID_LANES = new Set(['video', 'image', 'lipsync', 'audio', 'mesh']);

const insertStmt = db.prepare(
  'INSERT INTO job_logs (jobId, lane, ts, msg) VALUES (@jobId, @lane, @ts, @msg)'
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

/**
 * Append a single log line. Truncates msg at 300 chars to keep rows small.
 * Returns the inserted row's id.
 */
export function appendLog(jobId, lane, msg) {
  if (!jobId || !VALID_LANES.has(lane)) return null;
  const line = String(msg || '').slice(0, 300);
  if (!line) return null;
  const info = insertStmt.run({ jobId, lane, ts: Date.now(), msg: line });
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

/** Convenience for status endpoints — returns the last 80 entries. */
export function listRecentLogs(jobId, lane) {
  return listLogs({ jobId, lane, limit: 80 });
}
