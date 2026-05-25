// Cinema chain orchestrator — BE-side. Drives a multi-shot Cinema
// render from start to finish without the FE needing to be alive.
//
// Lifecycle:
//   1. FE creates a cinema_render row (POST /api/cinema/:projectId/render).
//   2. FE calls startRender → that posts the FIRST shot via the regular
//      /api/ai-video/generate path (with silentWake) AND PATCHes the
//      render's shotJobIds[0] = <returned jobId>.
//   3. The worker picks up that job, runs it, and finally posts to
//      /api/gpu-worker/job-complete.
//   4. Our hook (postJobComplete in controllers/gpuWorker/index.js) calls
//      `notifyCinemaChainOfCompletion(videoId)` here. That function looks
//      up which cinema_render (if any) is waiting on that videoId and
//      drives the next step:
//        • not last shot → download mp4, ffmpeg-extract last frame,
//          upload to Cloudinary, queue next shot with imageUrl set,
//          PATCH render row.
//        • last shot     → create a combined_videos row, spawn the
//          existing combineVideos() helper, mark render as combining.
//   5. Worker fires again on the new shot → repeat. The combine step
//      runs as a fire-and-forget Promise, just like the /api/combine
//      endpoint does.
//   6. When combine finishes, this module flips the render row to
//      status='completed' + finalDownloadHref = '/api/combine/file/<id>'.
//
// All BE work — no FE required. Browser-driven chain still works as a
// fallback / for the "Resume" button when the user manually clicks it.

import fs from 'fs/promises';
import { spawn } from 'child_process';
import path from 'path';
import os from 'os';

import logger from '../../helpers/logger.js';
import { getCinemaRender, updateCinemaRender } from './cinemaRenderStore.js';
import { getCinemaProject } from './cinemaStore.js';
import { createInflightJob } from './storage.js';
import { getLocalVideo } from './videoStore.js';
import { uploadSourceImage } from './cloudinaryStore.js';
import { publishJob } from './messageQueue.js';
import { appendLog } from './logStore.js';
import { db } from './db.js';
import { createCombine, updateCombine } from '../ffmpeg/combineStore.js';
import { combineVideos } from '../ffmpeg/combine.js';

// Per-mode model + steps + (worker-side) duration / resolution caps.
// Same map the /api/ai-video/generate controller uses — duplicated here
// so the orchestrator doesn't have to import the controller (would be a
// circular dep through routes).
const OPTIMIZED_MODES = {
  preview:  { model: 'ltx-distilled', steps: 8  },
  balanced: { model: 'wan-2.2',       steps: 14 },
  quality:  { model: 'hunyuan',       steps: 16 },
};

const VIDEO_DOWNLOAD_TIMEOUT_MS = 120_000;

// findRenderForCompletedVideo — given a videoId that just finished, look
// up the cinema_render (if any) that's waiting on it. shotJobIds is a
// JSON column; SQLite has no JSON_CONTAINS so we LIKE-match on the
// quoted token. False positives are guarded by re-parsing on the JS
// side (`shotJobIds.includes(videoId)`).
function findRenderForCompletedVideo(videoId) {
  if (!videoId) return null;
  const escapedToken = `%"${videoId.replaceAll('%', '\\%').replaceAll('_', '\\_')}"%`;
  const rows = db.prepare(
    `SELECT renderId, projectId, status, currentShotIndex, shotCount,
            shotJobIds, vault, provider, optimizedMode
       FROM cinema_renders
       WHERE shotJobIds LIKE ? ESCAPE '\\'
         AND status NOT IN ('completed', 'failed', 'cancelled')`
  ).all(escapedToken);
  for (const row of rows) {
    let parsed = [];
    try { parsed = JSON.parse(row.shotJobIds || '[]'); } catch {}
    if (Array.isArray(parsed) && parsed.includes(videoId)) {
      return getCinemaRender(row.renderId);
    }
  }
  return null;
}

// extractLastFrameToDataUrl — download the completed mp4, run ffmpeg
// to grab the very last frame, return it as a base64 data: URL ready
// for cloudinaryStore.uploadSourceImage(). Cleans up its temp dir
// in a finally block so a failure mid-way doesn't leak files.
async function extractLastFrameToDataUrl(videoUrl) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cinema-frame-'));
  const mp4Path  = path.join(tempRoot, 'in.mp4');
  const framePath = path.join(tempRoot, 'last.jpg');
  try {
    // Download the mp4. AbortSignal.timeout keeps a flaky CDN from
    // hanging the orchestrator forever.
    const response = await fetch(videoUrl, { signal: AbortSignal.timeout(VIDEO_DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`HTTP ${response.status} downloading mp4`);
    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(mp4Path, buffer);

    // ffmpeg: grab the very last frame.
    //   -sseof -0.1   seek to 100ms before EOF (skips potential black tail)
    //   -update 1     overwrite the single output image each frame
    //   -q:v 2        high quality JPEG
    await new Promise((resolve, reject) => {
      const proc = spawn('ffmpeg', [
        '-y',
        '-sseof', '-0.1',
        '-i', mp4Path,
        '-update', '1',
        '-q:v', '2',
        framePath,
      ]);
      proc.on('error', reject);
      proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`)));
    });

    const frameBuffer = await fs.readFile(framePath);
    return `data:image/jpeg;base64,${frameBuffer.toString('base64')}`;
  } finally {
    fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

// queueNextShot — create the inflight job + publish to RabbitMQ. Mirrors
// what controllers/aiVideo's handleAsyncWorker does, minus the Express
// request/response plumbing. Returns the created job row.
async function queueNextShot({ render, project, shotIndex, frameUrl }) {
  const provider = render.provider     || 'optimized';
  const mode     = render.optimizedMode || 'balanced';
  const overrides = OPTIMIZED_MODES[mode] || OPTIMIZED_MODES.balanced;

  // role='local' is what the worker polls for. originalProvider
  // preserves the FE-facing label.
  const role = (provider === 'optimized' || provider === 'local') ? 'local'
             : provider === 'zsky' ? 'worker'
             : 'local';

  const job = await createInflightJob({
    provider: role,
    originalProvider: provider,
    prompt: project.shotPrompts[shotIndex],
    model: overrides.model,
    duration: project.durationPerShot || 5,
    resolution: project.resolution    || '720p',
    aspectRatio: project.aspectRatio  || '16:9',
    steps: overrides.steps,
    style: 'cinematic',
    audio: true,
    imageUrl: frameUrl || '',
    generateCaption: false,
    withMusic: false,
    musicPrompt: '',
    vault: render.vault ? 1 : 0,
  });

  publishJob({ provider, role, jobId: job.videoId, videoId: job.videoId })
    .catch((err) => logger.warn(`Cinema chain publish skipped: ${err.message}`));

  return job;
}

// runCombineAsync — spawn the existing combineVideos helper exactly the
// way controllers/combine does. Updates the combined_videos row + the
// cinema_renders row to completed when the ffmpeg pass finishes.
async function runCombineAsync({ render, project, combineId, sourceUrls }) {
  try {
    const result = await combineVideos(combineId, sourceUrls, {
      onLog:      (line) => appendLog(combineId, 'combine', line),
      onProgress: (pct)  => updateCombine(combineId, { progress: pct }),
    });
    updateCombine(combineId, {
      status:      'completed',
      progress:    100,
      strategy:    result.strategy,
      outputPath:  result.outputPath,
      fileSize:    result.sizeBytes,
      title:       `Cinema · ${(project.masterPrompt || project.projectId).slice(0, 60)}`,
      completedAt: new Date().toISOString(),
    });
    updateCinemaRender(render.renderId, {
      status: 'completed',
      phase:  'done',
      finalDownloadHref: `/api/combine/file/${combineId}`,
      completedAt: new Date().toISOString(),
    });
    appendLog(combineId, 'combine', `Cinema render ${render.renderId} complete · ${(result.sizeBytes / 1024 / 1024).toFixed(1)} MB`);
    logger.info(`Cinema render ${render.renderId} complete → /api/combine/file/${combineId}`);
  } catch (err) {
    const message = err?.message || String(err);
    updateCombine(combineId, {
      status: 'failed',
      error:  message.slice(0, 800),
      completedAt: new Date().toISOString(),
    });
    updateCinemaRender(render.renderId, {
      status: 'failed',
      phase:  'failed',
      error:  `Combine: ${message}`,
      completedAt: new Date().toISOString(),
    });
    appendLog(combineId, 'combine', `Failed: ${message}`);
    logger.error(`Cinema combine failed for render ${render.renderId}: ${message}`);
  }
}

// triggerCombine — last shot just finished. Create a combined_videos
// row + spawn the ffmpeg pass. Vault flag inherits from the render
// (which in turn inherited from the parent project on the FE side).
async function triggerCombine(render, project) {
  const videoIds = render.shotJobIds.filter(Boolean);
  if (videoIds.length < 2) {
    updateCinemaRender(render.renderId, {
      status: 'failed',
      error:  `Combine needs ≥2 source videos; got ${videoIds.length}`,
      completedAt: new Date().toISOString(),
    });
    return;
  }
  // Resolve each videoId to its Cloudinary URL via the videos table.
  const sources = [];
  for (const videoId of videoIds) {
    const row = getLocalVideo(videoId);
    if (!row?.videoUrl) {
      updateCinemaRender(render.renderId, {
        status: 'failed',
        error:  `Could not resolve videoUrl for ${videoId}`,
        completedAt: new Date().toISOString(),
      });
      return;
    }
    sources.push({ url: row.videoUrl, title: `Shot ${sources.length + 1}` });
  }

  updateCinemaRender(render.renderId, { phase: 'combining', status: 'combining' });

  const title = `Cinema · ${(project.masterPrompt || project.projectId).slice(0, 60)}`;
  const combine = createCombine({
    sources,
    title,
    vault: render.vault ? 1 : 0,
  });
  updateCinemaRender(render.renderId, { combineJobId: combine.id });
  updateCombine(combine.id, { status: 'processing', progress: 0 });

  // Fire-and-forget — combine runs in the background; the worker
  // callback returns immediately and the render row gets updated when
  // ffmpeg finishes.
  runCombineAsync({ render, project, combineId: combine.id, sourceUrls: sources.map(s => s.url) })
    .catch(err => logger.error(`Cinema chain combine error: ${err?.message || err}`));
}

// advanceFromShotCompletion — called when a video in some cinema_render
// just finished. Drives the next step (extract → upload → queue next
// shot, OR trigger combine on the last one). Errors flip the render
// to failed with a useful message.
async function advanceFromShotCompletion(render, completedShotIndex, completedJobId) {
  const project = getCinemaProject(render.projectId);
  if (!project) {
    updateCinemaRender(render.renderId, {
      status: 'failed',
      error:  `Parent project ${render.projectId} not found`,
      completedAt: new Date().toISOString(),
    });
    return;
  }

  const isLast = completedShotIndex === render.shotCount - 1;
  if (isLast) {
    await triggerCombine(render, project);
    return;
  }

  try {
    const completedVideo = getLocalVideo(completedJobId);
    if (!completedVideo?.videoUrl) {
      throw new Error(`Could not resolve videoUrl for completed shot ${completedShotIndex + 1}`);
    }

    updateCinemaRender(render.renderId, { phase: 'extracting' });
    const frameDataUrl = await extractLastFrameToDataUrl(completedVideo.videoUrl);

    updateCinemaRender(render.renderId, { phase: 'uploading' });
    const uploadResult = await uploadSourceImage(frameDataUrl);
    const frameUrl = uploadResult?.url;
    if (!frameUrl) throw new Error('Cloudinary upload returned no URL');

    const nextShotIndex = completedShotIndex + 1;
    updateCinemaRender(render.renderId, {
      phase: 'rendering',
      status: 'rendering',
      currentShotIndex: nextShotIndex,
    });

    const nextJob = await queueNextShot({
      render,
      project,
      shotIndex: nextShotIndex,
      frameUrl,
    });

    const nextJobIds = [...render.shotJobIds];
    nextJobIds[nextShotIndex] = nextJob.videoId;
    updateCinemaRender(render.renderId, { shotJobIds: nextJobIds });

    logger.info(`Cinema chain advanced ${render.renderId}: shot ${nextShotIndex + 1}/${render.shotCount} queued as ${nextJob.videoId}`);
  } catch (err) {
    const message = err?.message || String(err);
    updateCinemaRender(render.renderId, {
      status: 'failed',
      error:  message.slice(0, 800),
      completedAt: new Date().toISOString(),
    });
    logger.error(`Cinema chain advance failed for render ${render.renderId}: ${message}`);
  }
}

// Public entry — called from the worker callback. Async, fire-and-forget
// from the caller's perspective (the worker doesn't wait on the chain
// to advance; it just acks the completion and moves to the next job).
export function notifyCinemaChainOfCompletion(completedJobId) {
  if (!completedJobId) return;
  const render = findRenderForCompletedVideo(completedJobId);
  if (!render) return;
  // Defer to next tick so the calling controller can finish its own
  // updates (recordVideo + removeInflightJob) before we start chasing
  // them — eliminates a race where advanceFromShotCompletion reads a
  // stale videos table.
  setImmediate(() => {
    const completedShotIndex = render.shotJobIds.indexOf(completedJobId);
    if (completedShotIndex === -1) return;
    advanceFromShotCompletion(render, completedShotIndex, completedJobId).catch(err =>
      logger.error(`Cinema chain unhandled error: ${err?.message || err}`)
    );
  });
}

// notifyCinemaChainOfFailure — called when a shot fails terminally
// (worker exhausted retries). Flips the render to failed so the page
// shows the error + offers Resume.
export function notifyCinemaChainOfFailure(failedJobId, errorMessage) {
  if (!failedJobId) return;
  const render = findRenderForCompletedVideo(failedJobId);
  if (!render) return;
  updateCinemaRender(render.renderId, {
    status: 'failed',
    error:  `Shot ${(render.shotJobIds.indexOf(failedJobId) + 1)} failed: ${errorMessage || 'unknown'}`,
    completedAt: new Date().toISOString(),
  });
  logger.warn(`Cinema chain ${render.renderId} failed at shot job ${failedJobId}: ${errorMessage}`);
}
