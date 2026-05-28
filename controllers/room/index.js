// /api/room/* — AI Room Designer V2 controllers.
//
//   POST   /api/room/analyze            multipart 'video' → synchronous JSON
//   POST   /api/room/render             { jobId, pickedItems } → queues GPU render
//   GET    /api/room/status/:jobId      poll for analyze + render state
//   GET    /api/room/list?limit=        recent jobs (Vault if you want a gallery)
//   DELETE /api/room/:jobId             vault-only
//
// Analyze runs inline on the BE because it only needs ffmpeg, the
// existing Python face service, and Groq — no GPU. End-to-end ~10-15s
// on a 20s source video. Render dispatches to the existing RabbitMQ
// queue (re-using `chat_queue` with a `kind:'room-render'` discriminator)
// so the same worker process picks it up.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import multer from 'multer';
import { success, error } from '../../helpers/res_helper.js';
import logger from '../../helpers/logger.js';
import { analyzeRoom } from '../../services/aiVideo/roomPipeline.js';
import {
  createRoomJob, getRoomJob, getRoomJobParsed, listRoomJobs,
  markAnalyzed, markRenderStart, markFailed, updateProgress,
} from '../../services/aiVideo/roomStore.js';
import { listRecentLogs, appendLog as appendJobLog } from '../../services/aiVideo/logStore.js';
import { uploadVideoBuffer } from '../../services/aiVideo/cloudinaryStore.js';
import { publishRoomJob } from '../../services/aiVideo/messageQueue.js';

const ROOT = process.cwd();
const ROOM_UPLOADS_DIR = path.join(ROOT, 'data', 'room-uploads');
fs.mkdirSync(ROOM_UPLOADS_DIR, { recursive: true });

// multer.diskStorage so a large video doesn't sit in RAM. The file
// is read by ffmpeg directly off disk, then deleted in a finally{}.
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, ROOM_UPLOADS_DIR),
  filename:    (_req, file, cb) => {
    const id  = crypto.randomBytes(6).toString('hex');
    const ext = path.extname(file.originalname || '.mp4') || '.mp4';
    cb(null, `room_${id}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 120 * 1024 * 1024 },   // 120 MB
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype?.startsWith('video/')) return cb(new Error('video/* only'), false);
    cb(null, true);
  },
});
export const roomUploadMiddleware = upload.single('video');

// ── POST /api/room/analyze ─────────────────────────────────────
export const postAnalyzeRoom = async (req, res) => {
  if (!req.file) return error(res, 'Upload a video field named "video"', 400);
  const localPath = req.file.path;
  const clientJobId = String(req.body?.jobId || '').trim();
  const isSafe      = /^room_[a-z0-9_]{4,60}$/i.test(clientJobId);
  const jobId       = isSafe ? clientJobId : `room_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

  // Create the row IMMEDIATELY so the FE can begin polling for logs
  // the moment we return the 200. We then kick the pipeline into the
  // background — the response goes back in <100 ms and the FE drives
  // progress visibility from /status/:jobId.
  try {
    createRoomJob({ jobId, sourceVideoUrl: null, sourcePublicId: null });
    appendJobLog(jobId, 'room', 'Upload received · starting pipeline…');
    updateProgress(jobId, 'Upload received · starting pipeline…');
  } catch (e) {
    return error(res, `Could not create job row: ${e.message}`, 500);
  }

  // Background pipeline. setImmediate (vs. raw promise) defers to the
  // next event-loop tick so the HTTP response definitely lands first.
  setImmediate(() => runAnalyzeInBackground({ jobId, localPath, req }));

  return success(res, { jobId, status: 'analyzing', queued: true });
};

// Off-request handler. Owns its own try/finally so a crash in any
// stage gets caught and translated to a failed row.
async function runAnalyzeInBackground({ jobId, localPath, req }) {
  let cloudinaryUrl = null, cloudinaryPublicId = null;
  try {
    // Best-effort Cloudinary upload of the source — needed by the
    // worker render step (it streams from sourceVideoUrl). If
    // Cloudinary is down we still finish analyze but the FE will
    // block the render button server-side with a 412.
    try {
      appendJobLog(jobId, 'room', 'Uploading source video to Cloudinary…');
      updateProgress(jobId, 'Uploading source video to Cloudinary…');
      const buf = fs.readFileSync(localPath);
      const up = await uploadVideoBuffer(buf, jobId, {
        kind: 'room-source',
        originalName: req.file?.originalname || 'room.mp4',
      });
      cloudinaryUrl      = up?.secure_url || up?.url || null;
      cloudinaryPublicId = up?.public_id || null;
      if (cloudinaryUrl) {
        // Patch the row with the URL the worker will use.
        const { db } = await import('../../services/aiVideo/db.js');
        db.prepare('UPDATE room_jobs SET sourceVideoUrl=?, sourcePublicId=? WHERE jobId=?')
          .run(cloudinaryUrl, cloudinaryPublicId, jobId);
      }
    } catch (cdErr) {
      appendJobLog(jobId, 'room', `Cloudinary upload skipped: ${cdErr.message}`);
      logger.warn(`[room/analyze] cloudinary skipped: ${cdErr.message}`);
    }

    // Pipeline with intermediate progress lines.
    const { analysis, keyframeCount, elapsedMs } = await analyzeRoom(localPath, { jobId });
    markAnalyzed(jobId, { analysisJson: analysis, keyframeUrls: [] });
    appendJobLog(jobId, 'room', `Analysis ready · ${keyframeCount} keyframes · ${elapsedMs}ms`);
    updateProgress(jobId, 'Ready · pick items to render');
    logger.info(`[room/analyze] ${jobId} done in ${elapsedMs}ms`);
  } catch (err) {
    logger.error(`[room/analyze] ${jobId} failed: ${err.message}`);
    try {
      appendJobLog(jobId, 'room', `FAILED: ${err.message}`);
      markFailed(jobId, err.message);
    } catch (_) {}
  } finally {
    try { fs.unlinkSync(localPath); } catch (_) {}
  }
}

// ── POST /api/room/render ──────────────────────────────────────
// Picks up an existing analyzed job and dispatches the heavy
// compositing step to the worker. Returns immediately with the
// existing jobId — the FE polls /status/:jobId until mp4Url lands.
export const postRenderRoom = async (req, res) => {
  const { jobId, pickedItems } = req.body || {};
  if (!jobId) return error(res, 'jobId required', 400);
  if (!Array.isArray(pickedItems) || pickedItems.length === 0) {
    return error(res, 'pickedItems must be a non-empty array', 400);
  }

  const row = getRoomJob(jobId);
  if (!row)                       return error(res, 'jobId not found', 404);
  if (row.status === 'rendering') return error(res, 'Render already in flight', 409);
  if (!row.sourceVideoUrl) {
    return error(res, 'Source video not on Cloudinary — re-upload required', 412);
  }

  markRenderStart(jobId, pickedItems);

  // Dispatch via the dedicated room_queue. Body only carries jobId —
  // worker re-fetches the full row via /api/room/status/:jobId so
  // payload growth doesn't bump every consumer. If the broker is
  // down, the worker's HTTP fallback finds queued rows by status.
  publishRoomJob({ jobId, kind: 'room-render' })
    .catch((err) => logger.warn(`[room/render] publish skipped: ${err.message}`));

  return success(res, { jobId, status: 'rendering', queued: true });
};

// ── GET /api/room/status/:jobId ────────────────────────────────
// Returns row state + the most recent log lines from the shared
// job_logs table so the FE can render a live transcript during
// both analyze and render. Last 80 lines is plenty — the FE just
// renders the tail anyway.
export const getRoomStatus = (req, res) => {
  const row = getRoomJobParsed(req.params.jobId);
  if (!row) return error(res, 'Not found', 404);
  const logs = listRecentLogs(req.params.jobId, 'room') || [];
  return success(res, {
    jobId:           row.jobId,
    status:          row.status,
    analysis:        row.analysis,
    pickedItems:     row.pickedItems,
    mp4Url:          row.mp4Url || null,
    sourceVideoUrl:  row.sourceVideoUrl || null,
    progressMessage: row.progressMessage || null,
    error:           row.error || null,
    createdAt:       row.createdAt,
    analyzedAt:      row.analyzedAt,
    renderCompletedAt: row.renderCompletedAt,
    logs:            logs.slice(-80),
  });
};

// ── GET /api/room/list ─────────────────────────────────────────
export const getRoomList = (req, res) => {
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 24));
  const rows = listRoomJobs({ limit }).map((r) => ({
    ...r,
    analysis: safeJSON(r.analysisJson),
  }));
  return success(res, { items: rows });
};

function safeJSON(s) { if (!s) return null; try { return JSON.parse(s); } catch (_) { return null; } }
