import { success, error } from '../../helpers/res_helper.js';
import { generateZskyVideo } from '../../services/aiVideo/zsky.js';
import { generateGroqCaption } from '../../services/aiVideo/caption.js';
import {
  newVideoId, createInflightJob, getInflightJob, listInflightJobs, removeInflightJob,
} from '../../services/aiVideo/storage.js';
import {
  uploadVideoBuffer, listVideos, getVideo, deleteVideo,
  getLatestVideo, isCloudinaryConfigured, uploadSourceImage,
} from '../../services/aiVideo/cloudinaryStore.js';
import { getWorkerStatus, isWorkerOnline } from '../../services/aiVideo/jobStore.js';
import { tryWakeWorker } from '../../services/aiVideo/wakeWorker.js';
import { tokenInfo as zskyTokenInfo, isConfigured as zskyConfigured } from '../../services/aiVideo/zskyAuth.js';
import logger from '../../helpers/logger.js';
import { publishJob } from '../../services/aiVideo/messageQueue.js';
import { listFailures } from '../../services/aiVideo/failureStore.js';
import { enhanceImageGemini } from '../../services/gemini.js';
import { generateMusicViaHF } from '../../services/aiVideo/musicGen.js';

const ALIASES = {
  gpu: 'worker', comfyui: 'worker',
  pc: 'local', '5090': 'local', beast: 'local',
  // 'optimized' is a NEW provider — same physical worker (5090), but the worker
  // applies aggressive speed defaults based on req.body.mode (preview/balanced/quality).
  turbo: 'optimized', fast: 'optimized', '5090opt': 'optimized',
};
const VALID = new Set(['zsky', 'worker', 'local', 'optimized']);

// Mode → (model, steps, resolution, durationCap) overrides for the optimized provider.
// Keeps the 5090 Beast card's existing behaviour untouched; this only kicks in
// when provider === 'optimized'.
const OPTIMIZED_MODES = {
  preview:  { model: 'ltx-distilled', steps: 8,  resolution: '720p', duration: 2 },
  balanced: { model: 'wan-2.2',       steps: 14, resolution: '720p', duration: 5 },
  // Hunyuan is the heaviest model we ship — 30 steps × ~78s/step on the 5090
  // would mean a 40-minute job. 16 steps gives nearly identical quality and
  // lands around 20-22 min until SageAttention/TeaCache come back online.
  quality:  { model: 'hunyuan',       steps: 16, resolution: '720p', duration: 5 },
};

function normalizeProvider(raw) {
  const p = (raw || 'zsky').toLowerCase();
  return ALIASES[p] || p;
}

// ───────────────────────────────────────────────────────────
export const postGenerateVideo = async (req, res) => {
  try {
    const {
      prompt,
      provider: rawProvider = 'zsky',
      model,
      duration = 5,
      resolution = '720p',
      aspectRatio = '9:16',
      steps = 30,
      style = 'cinematic',
      audio = true,
      imageUrl = '',
      generateCaption = true,
      mode,           // 'preview' | 'balanced' | 'quality' — only meaningful for the optimized provider
      withMusic = false,           // 5090 lanes only: have MusicGen produce a backing track
      musicPrompt = '',            // optional override; falls back to the video prompt if empty
    } = req.body || {};

    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      return error(res, 'Prompt is required', 400);
    }
    const provider = normalizeProvider(rawProvider);
    if (!VALID.has(provider)) return error(res, 'Invalid provider. Use "zsky" or "worker"', 400);

    if (!isCloudinaryConfigured()) {
      return error(res, 'Cloudinary not configured on server', 503);
    }

    let opts = { prompt: prompt.trim(), model, duration, resolution, aspectRatio, steps, style, audio, imageUrl, generateCaption, mode, withMusic, musicPrompt };

    // For the 'optimized' provider, apply mode-based speed defaults BEFORE dispatch.
    // The user can still override via explicit fields, but blank fields get the mode's recommendation.
    if (provider === 'optimized') {
      const overrides = OPTIMIZED_MODES[(mode || 'balanced').toLowerCase()] || OPTIMIZED_MODES.balanced;
      // Mode is the SOLE source of truth for the optimized lane. The FE always
      // sends defaults (steps=30, resolution=720p) so we can't tell whether the
      // user touched the slider — and if they're on this lane, they wanted the
      // mode's tuning, not their stale slider state. Force every knob.
      opts = {
        ...opts,
        model: overrides.model,
        steps: overrides.steps,
        resolution: overrides.resolution,
        duration: overrides.duration,
      };
    }

    if (provider === 'zsky') return handleZsky(req, res, opts);
    if (provider === 'local') return handleAsyncWorker(req, res, opts, 'local', 'local');
    if (provider === 'optimized') return handleAsyncWorker(req, res, opts, 'local', 'optimized');   // same physical worker
    return handleAsyncWorker(req, res, opts, 'worker', 'worker');
  } catch (err) {
    logger.error('AI video generate failed', err.message);
    return error(res, err.message, 500);
  }
};

// ─── ZSky: synchronous → Cloudinary ───────────────────────
async function handleZsky(req, res, opts) {
  const start = Date.now();
  logger.info(`ZSKY REQ | "${opts.prompt.slice(0, 60)}"`);

  let result;
  try {
    result = await generateZskyVideo(opts.prompt, opts);
  } catch (err) {
    logger.error('ZSky failed', err.message);
    if (err.contentPolicy) return error(res, err.message, 400);
    if (/rate limit|too many/i.test(err.message)) return error(res, err.message, 429);
    return error(res, err.message, 502);
  }

  if (!result.buffer) {
    return error(res, 'ZSky returned no video buffer', 502);
  }

  const videoId = newVideoId();
  const caption = opts.generateCaption
    ? await generateGroqCaption(opts.prompt).catch(() => null)
    : null;

  const meta = {
    prompt: opts.prompt,
    provider: 'zsky',
    duration: opts.duration,
    resolution: opts.resolution,
    aspectRatio: opts.aspectRatio,
    style: opts.style,
    audio: opts.audio,
    caption,
    model: result.model || opts.style,
    createdAt: new Date().toISOString(),
  };

  let upload;
  try {
    // Trim the ZSky watermark by clipping to the user's requested duration.
    // ZSky outputs ~2s longer than requested with a watermark in the tail.
    upload = await uploadVideoBuffer(result.buffer, videoId, meta, {
      trimToSeconds: opts.duration,
    });
  } catch (err) {
    logger.error('Cloudinary upload failed', err.message);
    return error(res, `Cloudinary upload failed: ${err.message}`, 502);
  }

  const elapsedMs = Date.now() - start;
  logger.info(`ZSKY RES | ${videoId} | ${elapsedMs}ms`);
  return success(res, {
    success: true,
    videoId,
    status: 'completed',
    provider: 'zsky',
    videoUrl: upload.secure_url,
    publicId: upload.public_id,
    bytes: upload.bytes,
    durationSec: upload.duration,
    elapsedMs,
    ...meta,
  });
}

// ─── Generic hosted-sync handler (Luma; pattern-ready for Fal/Replicate later) ───
async function handleHostedSync(req, res, opts, providerName, generateFn) {
  const start = Date.now();
  logger.info(`${providerName.toUpperCase()} REQ | "${opts.prompt.slice(0, 60)}"`);

  let result;
  try {
    result = await generateFn(opts.prompt, opts);
  } catch (err) {
    logger.error(`${providerName} failed`, err.message);
    if (err.contentPolicy) return error(res, err.message, 400);
    if (/rate limit|too many/i.test(err.message)) return error(res, err.message, 429);
    if (/credits exhausted|invalid|revoked|not configured/i.test(err.message)) return error(res, err.message, 503);
    return error(res, err.message, 502);
  }

  if (!result.buffer) return error(res, `${providerName} returned no video buffer`, 502);

  const videoId = newVideoId();
  const caption = opts.generateCaption
    ? await generateGroqCaption(opts.prompt).catch(() => null)
    : null;

  const meta = {
    prompt: opts.prompt,
    provider: providerName,
    duration: opts.duration,
    resolution: opts.resolution,
    aspectRatio: opts.aspectRatio,
    style: opts.style,
    audio: opts.audio,
    caption,
    model: result.model || opts.style,
    createdAt: new Date().toISOString(),
  };

  let upload;
  try {
    upload = await uploadVideoBuffer(result.buffer, videoId, meta);
  } catch (err) {
    logger.error('Cloudinary upload failed', err.message);
    return error(res, `Cloudinary upload failed: ${err.message}`, 502);
  }

  const elapsedMs = Date.now() - start;
  logger.info(`${providerName.toUpperCase()} RES | ${videoId} | ${elapsedMs}ms`);
  return success(res, {
    success: true,
    videoId,
    status: 'completed',
    provider: providerName,
    videoUrl: upload.secure_url,
    publicId: upload.public_id,
    bytes: upload.bytes,
    durationSec: upload.duration,
    elapsedMs,
    ...meta,
  });
}

// ─── Worker: async, queue + Telegram + polling ────────────
async function handleAsyncWorker(req, res, opts, role, originalProvider) {
  // originalProvider preserves the FE-facing label ('optimized' | 'local')
  // so the Library and Cloudinary tags can distinguish 5090 Optimized vs
  // 5090 Beast even though both run on the same physical worker (role='local').
  const tagProvider = originalProvider || role;
  const job = await createInflightJob({
    provider: role,           // workers index by role; don't break that
    originalProvider: tagProvider,   // FE label, persisted on the job
    prompt: opts.prompt,
    model: opts.model || 'ltx-video',
    duration: opts.duration,
    resolution: opts.resolution,
    aspectRatio: opts.aspectRatio,
    steps: opts.steps || 30,
    style: opts.style,
    audio: opts.audio,
    imageUrl: opts.imageUrl || '',
    generateCaption: opts.generateCaption,
    // MusicGen flags — only the 5090 worker honours these (Lightning + ZSky
    // ignore them today). worker.py reads job.withMusic + job.musicPrompt.
    withMusic: !!opts.withMusic,
    musicPrompt: (opts.musicPrompt || '').slice(0, 400),
  });

  const ws = await getWorkerStatus(role);
  const online = isWorkerOnline(ws);
  if (!online) {
    tryWakeWorker({ jobId: job.videoId, prompt: opts.prompt, role }).catch(() => {});
  }

  // Best-effort: publish a trigger to RabbitMQ so the worker picks the job
  // up instantly. If the broker is down or unconfigured, the worker's HTTP
  // polling fallback delivers the same job within POLL_INTERVAL seconds —
  // correctness doesn't depend on the broker being up.
  publishJob({ provider: tagProvider, role, jobId: job.videoId, videoId: job.videoId })
    .catch((err) => logger.warn(`RabbitMQ publish skipped: ${err.message}`));

  logger.info(`${tagProvider.toUpperCase()} QUEUE | ${job.videoId} | online=${online} | "${opts.prompt.slice(0, 60)}"`);
  return success(res, {
    success: true,
    videoId: job.videoId,
    jobId: job.videoId,
    status: 'queued',
    provider: tagProvider,
    workerOnline: online,
    message: online
      ? `Job queued — ${role === 'local' ? '5090' : 'GPU'} is processing now`
      : 'Job queued — your video will appear in the Library when ready',
  });
}

// ─── Status ─────────────────────────────────────────────────
// Check in-flight first (queued/processing); fall through to Cloudinary (completed).
export const getJobStatus = async (req, res) => {
  try {
    const id = req.params.jobId;
    const inflight = await getInflightJob(id);
    if (inflight) return success(res, inflight);
    const completed = await getVideo(id);
    if (completed) return success(res, completed);
    return error(res, 'Not found', 404);
  } catch (err) {
    return error(res, err.message);
  }
};

// ─── Latest ─────────────────────────────────────────────────
export const getTodayVideo = async (_req, res) => {
  try {
    return success(res, (await getLatestVideo()) || null);
  } catch (err) {
    return error(res, err.message);
  }
};

// ─── List (paginated, Cloudinary + in-flight) ──────────────
export const getVideoList = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 12, 1), 50);
    const provider = req.query.provider;
    const includeInflight = req.query.inflight !== 'false' && page === 1;

    const result = await listVideos({ provider, page, limit });

    if (includeInflight) {
      let inflight = await listInflightJobs();
      if (provider) {
        // Match by originalProvider (FE label) first; fall back to role for
        // legacy jobs that pre-date the originalProvider field.
        inflight = inflight.filter(j => (j.originalProvider || j.provider) === provider);
      }
      // Show only mid-flight states; completed should already be on Cloudinary.
      inflight = inflight.filter(j => ['queued', 'processing', 'failed'].includes(j.status));
      if (inflight.length) {
        // Prepend in-flight jobs to first page (limit total to `limit`)
        const merged = [...inflight, ...result.items].slice(0, limit);
        result.items = merged;
        result.total += inflight.length;
        result.pages = Math.max(1, Math.ceil(result.total / limit));
      }
    }

    return success(res, result);
  } catch (err) {
    logger.error('List videos failed', err.message);
    return error(res, err.message);
  }
};

// ─── Queue inspection (live in-flight jobs across all providers) ──
// Returns every queued/processing job so the FE can render a "what's
// running" panel. Sorted by createdAt asc so the worker's actual pickup
// order matches what the user sees.
export const getJobQueue = async (req, res) => {
  try {
    const provider = req.query.provider;
    let items = await listInflightJobs();
    items = items
      .filter(j => ['queued', 'processing'].includes(j.status))
      .filter(j => !provider || (j.originalProvider || j.provider) === provider)
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    return success(res, { items, total: items.length });
  } catch (err) {
    logger.error('Queue list failed', err.message);
    return error(res, err.message);
  }
};

// ─── Failures audit log ────────────────────────────────────────
// Permanently-failed jobs land here (worker NACKs without requeue, or
// max-attempts exceeded). The FE Failures tab reads this endpoint.
export const getFailuresList = (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const provider = req.query.provider;
    const result = listFailures({ provider, page, limit });
    return success(res, result);
  } catch (err) {
    logger.error('Failures list failed', err.message);
    return error(res, err.message);
  }
};

// ─── Delete ─────────────────────────────────────────────────
export const deleteVideoById = async (req, res) => {
  try {
    const id = req.params.videoId;
    if (!id) return error(res, 'videoId required', 400);

    // If it's an in-flight job, remove from JSON.
    const removed = await removeInflightJob(id);
    if (removed) return success(res, { ok: true, source: 'inflight' });

    // Otherwise destroy on Cloudinary.
    const result = await deleteVideo(id);
    if (!result.ok) return error(res, `Delete failed: ${result.result}`, 500);
    logger.info(`Deleted video ${id}`);
    return success(res, { ok: true, source: 'cloudinary' });
  } catch (err) {
    logger.error('Delete failed', err.message);
    return error(res, err.message);
  }
};

// ─── Upload a source image (for image-to-video) ────────────
// Accepts a base64 data URL, returns a Cloudinary URL the worker can fetch.
export const postUploadSourceImage = async (req, res) => {
  try {
    const { dataUrl } = req.body || {};
    if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
      return error(res, 'dataUrl (base64 image) is required', 400);
    }
    if (!isCloudinaryConfigured()) {
      return error(res, 'Cloudinary not configured on server', 503);
    }
    const result = await uploadSourceImage(dataUrl);
    return success(res, result);
  } catch (err) {
    logger.error('Source image upload failed', err.message);
    return error(res, err.message, 502);
  }
};

// ─── Standalone music generation (HF Inference fallback) ──────
// Free, server-side, no GPU on Oracle needed. Defaults to musicgen-small for
// fast cold-start. The 5090 worker has a separate higher-quality path via
// audio_generator.py — this endpoint is for standalone clips users want
// without spinning up the worker.
export const postMusicGenerate = async (req, res) => {
  try {
    const { prompt, duration = 8 } = req.body || {};
    if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 3) {
      return error(res, 'prompt is required', 400);
    }
    const t0 = Date.now();
    const out = await generateMusicViaHF({ prompt: prompt.trim(), duration });
    const elapsedMs = Date.now() - t0;
    logger.info(`MUSIC | ${out.model} | ${duration}s | ${elapsedMs}ms | ${out.audioUrl}`);
    return success(res, { ...out, elapsedMs });
  } catch (err) {
    logger.error('Music generate failed', err.message);
    return error(res, err.message, 502);
  }
};

// ─── Image Enhancer (Gemini-powered) ────────────────────────
// Sends the image + a polishing prompt to Gemini 2.5 Flash Image and uploads
// the returned image to Cloudinary. The FE has a card-grid of preset prompts
// (cinematic upscale, 4K detail recovery, Hong Kong night film look, etc.)
// and posts whichever the user picks.
export const postImageEnhance = async (req, res) => {
  try {
    const { dataUrl, imageUrl, prompt, presetId } = req.body || {};
    if (!prompt || typeof prompt !== 'string' || prompt.length < 20) {
      return error(res, 'prompt is required (minimum 20 chars)', 400);
    }
    if (!dataUrl && !imageUrl) {
      return error(res, 'dataUrl (base64) or imageUrl is required', 400);
    }
    if (!isCloudinaryConfigured()) {
      return error(res, 'Cloudinary not configured on server', 503);
    }

    // Resolve to a base64 string the Gemini API will accept.
    let inputBase64;
    if (dataUrl) {
      inputBase64 = dataUrl;   // already a data: URL
    } else {
      const imgRes = await fetch(imageUrl);
      if (!imgRes.ok) return error(res, `Failed to fetch imageUrl: ${imgRes.status}`, 502);
      const buf = Buffer.from(await imgRes.arrayBuffer());
      const mime = imgRes.headers.get('content-type') || 'image/jpeg';
      inputBase64 = `data:${mime};base64,${buf.toString('base64')}`;
    }

    const t0 = Date.now();
    const out = await enhanceImageGemini(inputBase64, prompt);
    const enhancedDataUrl = `data:${out.mimeType};base64,${out.base64}`;
    const upload = await uploadSourceImage(enhancedDataUrl);
    const elapsedMs = Date.now() - t0;

    logger.info(`IMAGE ENHANCE | preset=${presetId || 'custom'} | ${elapsedMs}ms | ${upload.imageUrl}`);
    return success(res, {
      imageUrl: upload.imageUrl,
      publicId: upload.publicId,
      presetId: presetId || null,
      model: out.model,
      elapsedMs,
    });
  } catch (err) {
    logger.error('Image enhance failed', err.message);
    return error(res, err.message, 502);
  }
};

// ─── Providers / health ────────────────────────────────────
export const getVideoProviders = async (_req, res) => {
  const lightning = await getWorkerStatus('worker');
  const local = await getWorkerStatus('local');
  const ti = zskyConfigured() ? await zskyTokenInfo() : null;
  return success(res, {
    providers: ['zsky', 'worker', 'local'],
    cloudinary: isCloudinaryConfigured(),
    // Lightning worker status (legacy keys for back-compat)
    workerOnline: isWorkerOnline(lightning),
    workerLastSeen: lightning?.lastSeenAt || null,
    workerId: lightning?.workerId || null,
    workers: {
      worker: { online: isWorkerOnline(lightning), lastSeenAt: lightning?.lastSeenAt || null, workerId: lightning?.workerId || null },
      local:  { online: isWorkerOnline(local),     lastSeenAt: local?.lastSeenAt || null,     workerId: local?.workerId || null },
    },
    zsky: {
      configured: zskyConfigured(),
      hasFreshToken: !!ti?.hasAccess,
      tokenExpiresAt: ti?.expiresAt || null,
    },
  });
};
