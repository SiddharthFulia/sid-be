import { success, error } from '../../helpers/res_helper.js';
import { generateZskyVideo } from '../../services/aiVideo/zsky.js';
import { generateGroqCaption } from '../../services/aiVideo/caption.js';
import {
  newVideoId, createInflightJob, getInflightJob, listInflightJobs, removeInflightJob,
} from '../../services/aiVideo/storage.js';
import {
  uploadVideoBuffer, listVideos, getVideo, deleteVideo,
  getLatestVideo, isCloudinaryConfigured,
} from '../../services/aiVideo/cloudinaryStore.js';
import { getWorkerStatus, isWorkerOnline } from '../../services/aiVideo/jobStore.js';
import { tryWakeWorker } from '../../services/aiVideo/wakeWorker.js';
import { tokenInfo as zskyTokenInfo, isConfigured as zskyConfigured } from '../../services/aiVideo/zskyAuth.js';
import logger from '../../helpers/logger.js';

const ALIASES = { gpu: 'worker', comfyui: 'worker' };
const VALID = new Set(['zsky', 'worker']);

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
      duration = 5,
      resolution = '720p',
      aspectRatio = '9:16',
      style = 'cinematic',
      audio = true,
      imageUrl = '',
      generateCaption = true,
    } = req.body || {};

    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      return error(res, 'Prompt is required', 400);
    }
    const provider = normalizeProvider(rawProvider);
    if (!VALID.has(provider)) return error(res, 'Invalid provider. Use "zsky" or "worker"', 400);

    if (!isCloudinaryConfigured()) {
      return error(res, 'Cloudinary not configured on server', 503);
    }

    const opts = { prompt: prompt.trim(), duration, resolution, aspectRatio, style, audio, imageUrl, generateCaption };
    if (provider === 'zsky') return handleZsky(req, res, opts);
    return handleWorker(req, res, opts);
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
    upload = await uploadVideoBuffer(result.buffer, videoId, meta);
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
async function handleWorker(req, res, opts) {
  const job = await createInflightJob({
    provider: 'worker',
    prompt: opts.prompt,
    duration: opts.duration,
    resolution: opts.resolution,
    aspectRatio: opts.aspectRatio,
    style: opts.style,
    audio: opts.audio,
    imageUrl: opts.imageUrl || '',
    generateCaption: opts.generateCaption,
  });

  const ws = await getWorkerStatus();
  const online = isWorkerOnline(ws);
  if (!online) {
    tryWakeWorker({ jobId: job.videoId, prompt: opts.prompt }).catch(() => {});
  }

  logger.info(`WORKER QUEUE | ${job.videoId} | online=${online} | "${opts.prompt.slice(0, 60)}"`);
  return success(res, {
    success: true,
    videoId: job.videoId,
    jobId: job.videoId,
    status: 'queued',
    provider: 'worker',
    workerOnline: online,
    message: online
      ? 'Job queued — GPU is processing now'
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
      if (provider) inflight = inflight.filter(j => j.provider === provider);
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

// ─── Providers / health ────────────────────────────────────
export const getVideoProviders = async (_req, res) => {
  const ws = await getWorkerStatus();
  const ti = zskyConfigured() ? await zskyTokenInfo() : null;
  return success(res, {
    providers: ['zsky', 'worker'],
    cloudinary: isCloudinaryConfigured(),
    workerOnline: isWorkerOnline(ws),
    workerLastSeen: ws?.lastSeenAt || null,
    workerId: ws?.workerId || null,
    zsky: {
      configured: zskyConfigured(),
      hasFreshToken: !!ti?.hasAccess,
      tokenExpiresAt: ti?.expiresAt || null,
    },
  });
};
