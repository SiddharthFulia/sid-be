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
import { getCinemaProject, updateCinemaProject } from './cinemaStore.js';
import { createInflightJob, getInflightJob } from './storage.js';
import { getLocalVideo } from './videoStore.js';
import { uploadSourceImage } from './cloudinaryStore.js';
import { publishJob } from './messageQueue.js';
import { appendLog, tagJobsToRender } from './logStore.js';
import { db } from './db.js';
import { createCombine, updateCombine } from '../ffmpeg/combineStore.js';
import {
  compileContinuityPrompt,
  calculateContinuityRisk,
  extractAndChooseContinuityFrame,
  CONTINUITY_MODEL_DEFAULTS,
} from './cinematicContinuityDirector.js';
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
            shotJobIds, vault, provider, optimizedMode, beastModel
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
async function queueNextShot({ render, project, shotIndex, frameUrl, frameTime }) {
  // ─── Idempotency guard (§16) ─────────────────────────────────────
  // Skip if this slot already has an active inflight job. Old behaviour
  // would happily re-publish, leading to two workers picking up the
  // same shot. The render row is the source of truth; if its
  // shotJobIds[shotIndex] is set, look up that job — if it's still
  // queued/processing, bail with a log line; if it's completed/failed
  // we proceed (so a manual "Render again" works as a real retry).
  const existingJobId = Array.isArray(render.shotJobIds) ? render.shotJobIds[shotIndex] : null;
  if (existingJobId) {
    const existing = await getInflightJob(existingJobId);
    if (existing && (existing.status === 'queued' || existing.status === 'processing')) {
      appendLog(existingJobId, 'video',
        `SHOT ${String(shotIndex + 1).padStart(2, '0')} skipped duplicate enqueue: already ${existing.status}`,
        render.renderId);
      logger.info(`Cinema duplicate enqueue skipped renderId=${render.renderId} shot=${shotIndex} existingJobId=${existingJobId} status=${existing.status}`);
      return existing;   // tell the caller this slot is already handled
    }
  }

  const provider = render.provider     || 'optimized';
  const mode     = render.optimizedMode || 'balanced';
  const overrides = OPTIMIZED_MODES[mode] || OPTIMIZED_MODES.balanced;

  // role='local' is what the worker polls for. originalProvider
  // preserves the FE-facing label.
  const role = (provider === 'optimized' || provider === 'local') ? 'local'
             : provider === 'zsky' ? 'worker'
             : 'local';

  // Render-level model. Beast lane reads render.beastModel; optimized
  // gets its model from the mode picker (mapped via OPTIMIZED_MODES);
  // ZSky always uses its provider default.
  const effectiveModel = provider === 'local'
    ? (render.beastModel && render.beastModel.trim() ? render.beastModel.trim() : 'wan-2.2')
    : overrides.model;

  const perShotMusic = Array.isArray(project.shotMusic) ? !!project.shotMusic[shotIndex] : false;
  const action       = (project.shotPrompts[shotIndex] || '').trim();

  // ─── Compile the FULL continuity prompt via the director (§69) ───
  // Builds bible + physical state + camera state + continuation
  // language + action + realism layer. Also returns a sanitized
  // action (drift words stripped), a negative prompt, and a
  // compact log summary.
  const previousShot = shotIndex > 0 ? {
    action: project.shotPrompts[shotIndex - 1] || '',
  } : null;
  const continuityMode = project.continuityMode !== false;   // default ON
  const realismMode    = project.realismMode    !== false;   // default ON

  let composedPrompt;
  let negativePrompt = null;
  let compactSummary = '';
  let removedDriftWords = [];

  if (continuityMode) {
    const compiled = compileContinuityPrompt({
      bible: project.continuityBible || {},
      directorState: project.directorState || {},
      shot: { action },
      previousShot,
      shotIndex,
      totalShots: project.shotCount || (Array.isArray(project.shotPrompts) ? project.shotPrompts.length : 0),
      realismMode,
    });
    composedPrompt    = compiled?.positivePrompt    || action;
    negativePrompt    = compiled?.negativePrompt    || null;
    compactSummary    = compiled?.compactLogSummary || '';
    removedDriftWords = Array.isArray(compiled?.removedDrift) ? compiled.removedDrift : [];
  } else {
    // Legacy path — just bible-prefix the action. Kept so users who
    // opt out of the director still get a working render.
    const fields = ['subject', 'wardrobe', 'environment', 'lighting', 'camera', 'palette'];
    const bibleLine = fields
      .map(k => (project.continuityBible?.[k] || '').trim())
      .filter(Boolean).map(v => `same ${v}`).join(', ');
    composedPrompt = bibleLine ? `${bibleLine}. ${action}` : action;
  }

  // Locked seed — same noise init across every shot.
  const lockedSeed = Number.isFinite(project.lockedSeed) ? project.lockedSeed : null;

  // Motion strength — clamped to [0.1, 1.0]. When continuityMode is on
  // and the model has a continuity-default lower than the user's
  // value, we soft-clamp to the safer default and emit a warning.
  let motionStrength = Number.isFinite(project.motionStrength)
    ? Math.max(0.1, Math.min(1.0, project.motionStrength))
    : 0.6;
  if (continuityMode) {
    const modelDef = CONTINUITY_MODEL_DEFAULTS[effectiveModel];
    if (modelDef && motionStrength > modelDef.motionStrength + 0.15) {
      const orig = motionStrength;
      motionStrength = modelDef.motionStrength;
      appendLog(render.renderId, 'video',
        `[director] motionStrength softened ${orig} → ${motionStrength} (${effectiveModel} default)`,
        render.renderId);
    }
  }

  // Hero image for shot 0, previous-shot continuity frame for the rest.
  const isFirstShot = shotIndex === 0;
  const startImageUrl = frameUrl
    || (isFirstShot && project.heroImageUrl ? project.heroImageUrl : '');

  // Pre-flight continuity risk score — landed in the logs so the user
  // can see why a shot might drift even before it renders.
  const risk = calculateContinuityRisk({
    bible: project.continuityBible || {},
    directorState: project.directorState || {},
    action,
    model: effectiveModel,
    motionStrength,
    durationPerShot: project.durationPerShot || 5,
    hasHeroImage: !!project.heroImageUrl,
    shotIndex,
  });

  const job = await createInflightJob({
    provider: role,
    originalProvider: provider,
    prompt: composedPrompt,
    model: effectiveModel,
    duration: project.durationPerShot || 5,
    resolution: project.resolution    || '720p',
    aspectRatio: project.aspectRatio  || '16:9',
    steps: overrides.steps,
    style: 'cinematic',
    audio: true,
    imageUrl: startImageUrl,
    generateCaption: false,
    withMusic: perShotMusic,
    musicPrompt: perShotMusic ? action : '',
    seed: lockedSeed,
    motionStrength,
    negativePrompt,
    continuityFrameTime: Number.isFinite(frameTime) ? frameTime : null,
    vault: render.vault ? 1 : 0,
  });

  // Director log line. Lands in the unified-by-render stream so the
  // user sees what the director did per shot.
  appendLog(job.videoId, 'video',
    `[director] ${compactSummary || `shot ${shotIndex + 1}`} · ` +
    `model=${effectiveModel} · seed=${lockedSeed} · motion=${motionStrength} · ` +
    `source=${isFirstShot ? (project.heroImageUrl ? 'hero_image' : 't2v') : `continuity_frame_-${(frameTime ?? 0.4).toFixed(2)}s`} · ` +
    `risk=${risk.score} ${risk.level}`,
    render.renderId);
  if (Array.isArray(removedDriftWords) && removedDriftWords.length) {
    appendLog(job.videoId, 'video',
      `[director] drift sanitized — removed: ${removedDriftWords.join(', ')}`,
      render.renderId);
  }
  const riskWarnings = Array.isArray(risk?.warnings) ? risk.warnings : [];
  if (riskWarnings.length) {
    for (const w of riskWarnings.slice(0, 3)) {
      appendLog(job.videoId, 'video', `[director] ⚠ ${w}`, render.renderId);
    }
  }

  publishJob({ provider, role, jobId: job.videoId, videoId: job.videoId })
    .catch((err) => logger.warn(`Cinema chain publish skipped: ${err.message}`));

  // Tag the new shot's jobId with the parent renderId so every log
  // line written by the worker (or by the postJobProgress controller)
  // lands in job_logs.cinemaRenderId. The unified
  // /api/cinema/render/:renderId/logs endpoint reads from there.
  tagJobsToRender(render.renderId, [job.videoId]);

  return job;
}

// runCombineAsync — spawn the existing combineVideos helper exactly the
// way controllers/combine does. Updates the combined_videos row + the
// cinema_renders row to completed when the ffmpeg pass finishes.
async function runCombineAsync({ render, project, combineId, sourceUrls }) {
  try {
    const result = await combineVideos(combineId, sourceUrls, {
      // Explicit renderId on every combine log so the unified stream
      // catches them even if the cache hasn't seen this combineId yet.
      onLog:      (line) => appendLog(String(combineId), 'combine', line, render.renderId),
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
    // Also flip the parent cinema_projects row so it shows up in the
    // Cinema Library (StudioLibrary queries cinema_projects with
    // status=completed). Without this, finished renders stay invisible
    // even though disk-stats counts them.
    updateCinemaProject(project.projectId, {
      status: 'completed',
      outputUrl: `/api/combine/file/${combineId}`,
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
    updateCinemaProject(project.projectId, {
      status: 'failed',
      error:  `Combine: ${message}`.slice(0, 800),
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
  // Tag the combine's id under lane='combine' so its ffmpeg log lines
  // show up in the unified-by-render stream too.
  tagJobsToRender(render.renderId, [String(combine.id)]);

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
    // ─── Multi-frame continuity extraction (§7) ──────────────────────
    // Old behaviour grabbed the literal last frame, which is often
    // the worst frame (model-tail mutation, motion blur). New: pull
    // 5 candidates spread across the last 1s, pick the one nearest
    // -0.4s (chooseContinuityFrame). Future scorer can swap in
    // blur-detection without changing the chain.
    let frameDataUrl;
    let frameTime = null;
    try {
      // Director module accepts a local path or URL; we need a path
      // so we download once + run ffprobe + ffmpeg against it.
      const tmpMp4Dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cinema-mp4-'));
      const localMp4 = path.join(tmpMp4Dir, 'in.mp4');
      try {
        const resp = await fetch(completedVideo.videoUrl, { signal: AbortSignal.timeout(VIDEO_DOWNLOAD_TIMEOUT_MS) });
        if (!resp.ok) throw new Error(`HTTP ${resp.status} downloading mp4 for frame extract`);
        const buf = Buffer.from(await resp.arrayBuffer());
        await fs.writeFile(localMp4, buf);
        const chosen = await extractAndChooseContinuityFrame(localMp4);
        if (chosen?.dataUrl) {
          frameDataUrl = chosen.dataUrl;
          frameTime = chosen.time;
          appendLog(completedJobId, 'video',
            `[director] continuity frame chosen at -${(chosen.time ?? 0.4).toFixed(2)}s (of ${chosen.candidateCount} candidates)`,
            render.renderId);
        }
      } finally {
        fs.rm(tmpMp4Dir, { recursive: true, force: true }).catch(() => {});
      }
    } catch (extractErr) {
      logger.warn(`Multi-frame extract failed renderId=${render.renderId}: ${extractErr.message} — falling back to legacy last-frame`);
      appendLog(render.renderId, 'video',
        `[director] multi-frame extract failed (${extractErr.message}); using legacy last-frame`,
        render.renderId);
    }
    // Fallback: legacy single-last-frame path if the new helper
    // returned nothing usable.
    if (!frameDataUrl) {
      frameDataUrl = await extractLastFrameToDataUrl(completedVideo.videoUrl);
    }

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
      frameTime,
    });

    const nextJobIds = [...render.shotJobIds];
    nextJobIds[nextShotIndex] = nextJob.videoId;
    updateCinemaRender(render.renderId, { shotJobIds: nextJobIds });

    logger.info(`Cinema chain advanced ${render.renderId}: shot ${nextShotIndex + 1}/${render.shotCount} queued as ${nextJob.videoId}`);
  } catch (err) {
    const message = err?.message || String(err);
    const stack   = err?.stack ? err.stack.split('\n').slice(0, 6).join('\n  ') : 'no stack';
    updateCinemaRender(render.renderId, {
      status: 'failed',
      error:  message.slice(0, 800),
      completedAt: new Date().toISOString(),
    });
    appendLog(render.renderId, 'video',
      `[director] advance failed: ${message}`,
      render.renderId);
    logger.error(`Cinema chain advance failed for render ${render.renderId}: ${message}\n  ${stack}`);
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
