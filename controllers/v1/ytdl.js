// /api/yt-dl/* — paste a YouTube URL, get back a downloadable MP3/MP4.
//
//   POST   /api/yt-dl               { url, format, quality }
//   GET    /api/yt-dl/status/:id    poll for progress / final URL
//   GET    /api/yt-dl/list?limit=
//   GET    /api/yt-dl/file/:id      streamed download
//   DELETE /api/yt-dl/:id           cancel / remove + delete file
//
// No queue: yt-dlp is spawned inline. Concurrency cap is a soft check
// against the count of 'processing' rows.

import fs from 'fs';
import path from 'path';
import { success, error } from '../../helpers/res_helper.js';
import logger from '../../helpers/logger.js';
import {
  createJob, getJob, listJobs, updateJob, deleteJob,
} from '../../services/ytdl/store.js';
import { isValidYtUrl, scheduleNext } from '../../services/ytdl/runner.js';

const ALLOWED_FORMATS = new Set(['mp3', 'mp4']);
const ALLOWED_AUDIO_Q = new Set(['128', '192', '320']);
const ALLOWED_VIDEO_Q = new Set(['360', '720', '1080', 'best']);

export const postCreate = (req, res) => {
  try {
    const { url, format, quality } = req.body || {};
    if (!isValidYtUrl(url))   return error(res, 'A valid YouTube URL is required', 400);
    if (!ALLOWED_FORMATS.has(format)) return error(res, "format must be 'mp3' or 'mp4'", 400);
    const qSet = format === 'mp3' ? ALLOWED_AUDIO_Q : ALLOWED_VIDEO_Q;
    if (!qSet.has(quality)) return error(res, `quality must be one of ${Array.from(qSet).join(', ')}`, 400);

    // Always insert as 'queued'; the scheduler picks it up immediately
    // if there's a free concurrency slot, otherwise it stays queued
    // until a running job finishes. No 429 — the client can submit as
    // many as they want and the BE serialises.
    const job = createJob({ url: String(url).trim(), format, quality });
    scheduleNext();
    return success(res, { jobId: job.id, status: job.status });
  } catch (err) {
    logger.error('yt-dl postCreate failed', err.message);
    return error(res, err.message);
  }
};

export const getStatus = (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = getJob(id);
  if (!row) return error(res, 'job not found', 404);
  // Don't leak the absolute filesystem path to the client.
  const { filePath: _fp, pid: _pid, ...safe } = row;
  return success(res, safe);
};

export const getList = (req, res) => {
  const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 30));
  const items = listJobs({ limit }).map(({ filePath, pid, ...safe }) => safe);
  return success(res, { items, total: items.length });
};

// Streamed download — Content-Disposition forces the browser to save
// instead of inline-preview. Range header support so a 1GB MP4 resumes
// cleanly if the connection blinks.
//
// PRIVACY: as soon as a FULL (non-range) download finishes streaming
// every byte, we unlink the file from disk and clear filePath on the
// row. The row itself stays so the history list shows it happened, but
// the actual MP3/MP4 is gone. Range requests don't auto-delete (they
// might be partial recovery attempts), but those are uncommon for
// browser-initiated saves. Worst-case fallback: the daily cron deletes
// terminal rows + files older than 48h.
const safelyDeleteFile = (id, filePath) => {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    updateJob(id, { filePath: null });
    logger.info(`yt-dl auto-deleted file after download jobId=${id}`);
  } catch (err) {
    logger.warn(`yt-dl auto-delete failed jobId=${id}: ${err.message}`);
  }
};

export const streamFile = (req, res) => {
  const id  = parseInt(req.params.id, 10);
  const row = getJob(id);
  if (!row)                       return error(res, 'job not found', 404);
  if (row.status !== 'completed') return error(res, `job is ${row.status}`, 400);
  if (!row.filePath || !fs.existsSync(row.filePath)) {
    return error(res, 'file no longer on disk', 410);
  }

  const stat = fs.statSync(row.filePath);
  const fileSize = stat.size;
  const range = req.headers.range;
  // Pretty Content-Disposition: strip the {jobId}- prefix yt-dlp's
  // output template prepends, replace the --restrict-filenames _-_
  // sequence with " - ", remaining _ with spaces, and trim any
  // filesystem-unsafe leftovers. Result for the Rick Astley test
  // case goes from "7-Rick_Astley_-_Never_Gonna_Give_You_Up_Official_Video_4K_Remaster.mp4"
  // to "Rick Astley - Never Gonna Give You Up Official Video 4K Remaster.mp4".
  const prettyName = (() => {
    const raw = row.fileName || `yt-${id}.${row.format}`;
    const noPrefix = raw.replace(new RegExp(`^${id}-`), '');
    return noPrefix
      .replace(/_-_/g, ' - ')
      .replace(/_/g, ' ')
      .replace(/[\/\\:*?"<>|\x00-\x1f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || `yt-${id}.${row.format}`;
  })();
  const ctype = row.format === 'mp3' ? 'audio/mpeg' : 'video/mp4';

  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    const start = m ? parseInt(m[1], 10) : 0;
    const end   = m && m[2] ? Math.min(parseInt(m[2], 10), fileSize - 1) : fileSize - 1;
    if (start >= fileSize) { res.status(416).end(); return; }
    const chunkSize = end - start + 1;
    res.writeHead(206, {
      'Content-Range':   `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges':   'bytes',
      'Content-Length':  chunkSize,
      'Content-Type':    ctype,
      'Content-Disposition': `attachment; filename="${prettyName}"`,
    });
    fs.createReadStream(row.filePath, { start, end }).pipe(res);
    // Range delivery → don't auto-delete; daily cron picks it up later.
  } else {
    res.writeHead(200, {
      'Content-Length':  fileSize,
      'Content-Type':    ctype,
      'Content-Disposition': `attachment; filename="${prettyName}"`,
      'Accept-Ranges':   'bytes',
    });
    const stream = fs.createReadStream(row.filePath);
    let bytesStreamed = 0;
    stream.on('data', (chunk) => { bytesStreamed += chunk.length; });
    // 'finish' fires when the response has flushed its last byte to the
    // client; 'close' covers aborted/socket-killed cases. We only delete
    // on a clean full-byte 'finish'.
    res.once('finish', () => {
      if (bytesStreamed >= fileSize) safelyDeleteFile(id, row.filePath);
    });
    stream.pipe(res);
  }
};

export const removeJob = (req, res) => {
  const id  = parseInt(req.params.id, 10);
  const row = getJob(id);
  if (!row) return error(res, 'job not found', 404);

  // If still processing, kill the spawned yt-dlp first.
  if (row.status === 'processing' && row.pid) {
    try { process.kill(row.pid); } catch {}
  }
  if (row.filePath) {
    try { fs.unlinkSync(row.filePath); } catch {}
  }
  const ok = deleteJob(id);
  return success(res, { ok });
};
