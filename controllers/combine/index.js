// /api/combine/* — multi-video concatenation.
//
//   POST   /api/combine               { sources: [{videoId?|url?, title?}], title? }
//   GET    /api/combine/list?limit=
//   GET    /api/combine/status/:id    polls progress + final state
//   GET    /api/combine/file/:id      streamed download with Content-Disposition
//   DELETE /api/combine/:id           removes row + on-disk file
//
// ffmpeg runs inline as a child process via combineVideos(); for a
// portfolio-scale combine (≤8 clips, ~30s total) the in-process spawn
// is plenty. Heavy multi-renders should later move behind a queue.

import fs from 'fs';
import path from 'path';
import { success, error } from '../../helpers/res_helper.js';
import logger from '../../helpers/logger.js';
import { combineVideos } from '../../services/ffmpeg/combine.js';
import {
  createCombine, getCombine, listCombines, updateCombine, deleteCombine,
} from '../../services/ffmpeg/combineStore.js';
import { appendLog as appendJobLog } from '../../services/aiVideo/logStore.js';
import { db } from '../../services/aiVideo/db.js';

// Resolve a source-spec to a concrete URL the ffmpeg helper can fetch.
// videoId hits the `videos` table for its Cloudinary videoUrl. A bare
// url passes through.
function resolveSource(spec) {
  if (spec?.url) return { url: spec.url, title: spec.title || null };
  if (spec?.videoId) {
    const row = db.prepare('SELECT videoId, videoUrl, prompt FROM videos WHERE videoId = ?').get(spec.videoId);
    if (!row) throw new Error(`videoId ${spec.videoId} not found in library`);
    return { url: row.videoUrl, title: spec.title || row.prompt?.slice(0, 60) || row.videoId };
  }
  throw new Error('source must have { videoId } or { url }');
}

export const postCreate = async (req, res) => {
  try {
    const { sources, title } = req.body || {};
    if (!Array.isArray(sources) || sources.length < 2) {
      return error(res, 'sources must be an array of at least 2 videos', 400);
    }
    if (sources.length > 12) {
      return error(res, 'cap is 12 videos per combine (would take too long inline)', 400);
    }
    // Resolve every source up-front so we 400 early if a videoId is bad.
    let resolved;
    try { resolved = sources.map(resolveSource); }
    catch (err) { return error(res, err.message, 400); }

    const job = createCombine({ sources: resolved, title });

    // Fire-and-forget — controller returns immediately with the jobId;
    // FE polls /status/:id. ffmpeg writes progress/log into the row +
    // job_logs table for the live log feed.
    (async () => {
      updateCombine(job.id, { status: 'processing', progress: 0 });
      try {
        const result = await combineVideos(job.id, resolved.map(r => r.url), {
          onLog: (line) => appendJobLog(job.id, 'combine', line),
          onProgress: (pct) => updateCombine(job.id, { progress: pct }),
        });
        updateCombine(job.id, {
          status:      'completed',
          progress:    100,
          strategy:    result.strategy,
          outputPath:  result.outputPath,
          fileSize:    result.sizeBytes,
          completedAt: new Date().toISOString(),
        });
        appendJobLog(job.id, 'combine', `Combine ${job.id} complete (${(result.sizeBytes / 1024 / 1024).toFixed(1)} MB, ${result.strategy})`);
        logger.info(`combine done jobId=${job.id} size=${result.sizeBytes} strategy=${result.strategy}`);
      } catch (err) {
        updateCombine(job.id, {
          status:      'failed',
          error:       String(err?.message || err).slice(0, 800),
          completedAt: new Date().toISOString(),
        });
        appendJobLog(job.id, 'combine', `Failed: ${err?.message || err}`);
        logger.warn(`combine failed jobId=${job.id}: ${err?.message || err}`);
      }
    })();

    return success(res, { jobId: job.id, status: job.status });
  } catch (err) {
    logger.error('combine postCreate failed', err.message);
    return error(res, err.message);
  }
};

export const getStatus = (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = getCombine(id);
  if (!row) return error(res, 'combine job not found', 404);
  // Don't leak the absolute disk path.
  const { outputPath: _op, ...safe } = row;
  return success(res, safe);
};

export const getList = (req, res) => {
  const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 30));
  return success(res, { items: listCombines({ limit }) });
};

// Auto-delete after first full (non-range) download finishes, matching
// the yt-dl privacy behaviour. Range requests are spared so the daily
// cron can clean them up later.
const safelyDeleteFile = (id, filePath) => {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    updateCombine(id, { outputPath: null });
    logger.info(`combine auto-deleted file after download jobId=${id}`);
  } catch (err) {
    logger.warn(`combine auto-delete failed jobId=${id}: ${err.message}`);
  }
};

export const streamFile = (req, res) => {
  const id  = parseInt(req.params.id, 10);
  const row = getCombine(id);
  if (!row)                        return error(res, 'combine job not found', 404);
  if (row.status !== 'completed')  return error(res, `job is ${row.status}`, 400);
  if (!row.outputPath || !fs.existsSync(row.outputPath)) {
    return error(res, 'file no longer on disk', 410);
  }

  const stat = fs.statSync(row.outputPath);
  const fileSize = stat.size;
  const range = req.headers.range;
  const safeName = `combined-${id}.mp4`;

  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    const start = m ? parseInt(m[1], 10) : 0;
    const end   = m && m[2] ? Math.min(parseInt(m[2], 10), fileSize - 1) : fileSize - 1;
    if (start >= fileSize) { res.status(416).end(); return; }
    res.writeHead(206, {
      'Content-Range':   `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges':   'bytes',
      'Content-Length':  end - start + 1,
      'Content-Type':    'video/mp4',
      'Content-Disposition': `attachment; filename="${safeName}"`,
    });
    fs.createReadStream(row.outputPath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length':  fileSize,
      'Content-Type':    'video/mp4',
      'Content-Disposition': `attachment; filename="${safeName}"`,
      'Accept-Ranges':   'bytes',
    });
    const stream = fs.createReadStream(row.outputPath);
    let bytesStreamed = 0;
    stream.on('data', (c) => { bytesStreamed += c.length; });
    res.once('finish', () => {
      if (bytesStreamed >= fileSize) safelyDeleteFile(id, row.outputPath);
    });
    stream.pipe(res);
  }
};

export const removeJob = (req, res) => {
  const id  = parseInt(req.params.id, 10);
  const row = getCombine(id);
  if (!row) return error(res, 'combine job not found', 404);
  if (row.outputPath) {
    try { fs.unlinkSync(row.outputPath); } catch {}
  }
  const ok = deleteCombine(id);
  return success(res, { ok });
};
