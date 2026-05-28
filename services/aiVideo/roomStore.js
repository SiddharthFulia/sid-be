// Room Designer DB layer — CRUD for the `room_jobs` table created in
// db.js. Mirrors meshStore.js / deepfakeStore.js in shape so the rest
// of the BE (controllers, polling, logs) feels identical.
//
// All writes serialize updatedAt via ISO strings so the row stays
// portable if/when we migrate to Postgres.

import { db } from './db.js';
import logger from '../../helpers/logger.js';

export function createRoomJob({
  jobId,
  sourceVideoUrl = null,
  sourcePublicId = null,
}) {
  const now = new Date().toISOString();
  try {
    db.prepare(`
      INSERT INTO room_jobs (jobId, status, sourceVideoUrl, sourcePublicId, createdAt)
      VALUES (?, 'analyzing', ?, ?, ?)
    `).run(jobId, sourceVideoUrl, sourcePublicId, now);
    return { jobId, status: 'analyzing', createdAt: now };
  } catch (err) {
    logger.error(`[roomStore.create] ${err.message}`);
    throw err;
  }
}

export function getRoomJob(jobId) {
  return db.prepare('SELECT * FROM room_jobs WHERE jobId = ?').get(jobId) || null;
}

export function listRoomJobs({ limit = 24 } = {}) {
  return db.prepare(`
    SELECT jobId, status, sourceVideoUrl, mp4Url, analysisJson, createdAt, renderCompletedAt
    FROM room_jobs
    ORDER BY createdAt DESC
    LIMIT ?
  `).all(limit);
}

// Mark the analysis phase complete. analysisJson is the full JSON
// blob the Groq critique returned (or our enrichment of it).
export function markAnalyzed(jobId, { analysisJson, keyframeUrls }) {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE room_jobs
    SET status='analyzed', analysisJson=?, keyframeUrls=?, analyzedAt=?
    WHERE jobId=?
  `).run(
    typeof analysisJson === 'string' ? analysisJson : JSON.stringify(analysisJson),
    typeof keyframeUrls === 'string' ? keyframeUrls : JSON.stringify(keyframeUrls || []),
    now, jobId
  );
}

// Kick off the render phase. Stores the picked items + flips state
// to 'rendering' so the FE poll knows to wait for the worker.
export function markRenderStart(jobId, pickedItems) {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE room_jobs
    SET status='rendering', pickedItemsJson=?, renderStartedAt=?, progressMessage=?
    WHERE jobId=?
  `).run(
    JSON.stringify(pickedItems || []),
    now,
    'Queued for the GPU worker',
    jobId
  );
}

// Worker calls back here when the MP4 is up on Cloudinary.
export function markRenderComplete(jobId, { mp4Url, mp4PublicId, elapsedMs }) {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE room_jobs
    SET status='completed', mp4Url=?, mp4PublicId=?, elapsedMs=?, renderCompletedAt=?,
        progressMessage='Render complete'
    WHERE jobId=?
  `).run(mp4Url, mp4PublicId || null, elapsedMs || null, now, jobId);
}

export function markFailed(jobId, errMsg) {
  db.prepare(`UPDATE room_jobs SET status='failed', error=? WHERE jobId=?`)
    .run(String(errMsg).slice(0, 800), jobId);
}

export function updateProgress(jobId, message, workerId = null) {
  db.prepare(`UPDATE room_jobs SET progressMessage=?, workerId=COALESCE(?, workerId) WHERE jobId=?`)
    .run(String(message).slice(0, 240), workerId, jobId);
}

export function deleteRoomJob(jobId) {
  db.prepare('DELETE FROM room_jobs WHERE jobId = ?').run(jobId);
}

// Parsed convenience getter — returns the row with analysisJson +
// pickedItemsJson + keyframeUrls already JSON.parsed so the
// controller and the worker don't both have to do it.
export function getRoomJobParsed(jobId) {
  const row = getRoomJob(jobId);
  if (!row) return null;
  const safeParse = (s, fallback) => {
    if (!s) return fallback;
    try { return JSON.parse(s); } catch (_) { return fallback; }
  };
  return {
    ...row,
    analysis: safeParse(row.analysisJson, null),
    keyframeUrls: safeParse(row.keyframeUrls, []),
    pickedItems: safeParse(row.pickedItemsJson, []),
  };
}
