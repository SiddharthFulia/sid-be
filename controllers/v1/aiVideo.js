import { success, error } from '../../helpers/res_helper.js';
import { generateZskyVideo } from '../../services/aiVideo/zsky.js';
import { generateGroqCaption } from '../../services/aiVideo/caption.js';
import {
  newVideoId, createInflightJob, getInflightJob, listInflightJobs, removeInflightJob,
  setInflightVault, removeInflightJobs,
} from '../../services/aiVideo/storage.js';
import {
  uploadVideoBuffer, listVideos, getVideo, deleteVideo,
  getLatestVideo, isCloudinaryConfigured, uploadSourceImage,
} from '../../services/aiVideo/cloudinaryStore.js';
import { getWorkerStatus, isWorkerOnline } from '../../services/aiVideo/jobStore.js';
import { tryWakeWorker } from '../../services/aiVideo/wakeWorker.js';
import { tokenInfo as zskyTokenInfo, isConfigured as zskyConfigured } from '../../services/aiVideo/zskyAuth.js';
import logger from '../../helpers/logger.js';
import { publishJob, publishImageJob } from '../../services/aiVideo/messageQueue.js';
import { listFailures } from '../../services/aiVideo/failureStore.js';
import { enhanceImageGemini } from '../../services/gemini.js';
import { generateMusicViaHF } from '../../services/aiVideo/musicGen.js';
import {
  createImage, getImage, updateImage, deleteImage as deleteImageRow,
  listImages, getImageCounts,
  setImagesVault, deleteImages as deleteImagesBulk, getImagesByIds,
} from '../../services/aiVideo/enhancedImageStore.js';
import {
  setVideosVault, deleteLocalVideos, getLocalVideosByIds,
} from '../../services/aiVideo/videoStore.js';
import { listRecentLogs, listLogs } from '../../services/aiVideo/logStore.js';
import {
  isCloudinaryConfigured as isCdnConfigured, uploadSourceImage as cdnUpload,
  deleteImageByUrl as cdnDeleteImage,
} from '../../services/aiVideo/cloudinaryStore.js';
import { classifyPrompt as classifyNsfw } from '../../services/auth/nsfwFilter.js';

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

    // Auth model: not logged in → NSFW filter blocks unsafe prompts.
    // Logged in → filter bypassed. All NEW jobs land in the public library
    // regardless of auth — the user can then explicitly "Move to Vault" from
    // the library if they want it hidden. This is simpler than guessing intent.
    const nsfw = classifyNsfw(prompt);
    if (nsfw && !req.vault) {
      return res.status(401).json({
        status: false,
        message: `Looks NSFW — log in to bypass (detected: ${nsfw.category})`,
        code: 'NSFW_BLOCKED',
        category: nsfw.category,
      });
    }
    let opts = { prompt: prompt.trim(), model, duration, resolution, aspectRatio, steps, style, audio, imageUrl, generateCaption, mode, withMusic, musicPrompt, vault: false };

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
    vault: opts.vault ? 1 : 0,
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
        inflight = inflight.filter(j => (j.originalProvider || j.provider) === provider);
      }
      inflight = inflight.filter(j => ['queued', 'processing', 'failed'].includes(j.status));
      // Vault filter: hide vault items unless caller is authenticated (req.vault).
      // This applies to in-flight AND failed jobs — vault content stays vault.
      if (!req.vault) {
        inflight = inflight.filter(j => !j.vault);
      }
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
      // Hide vault items from anonymous viewers
      .filter(j => req.vault || !j.vault)
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    return success(res, { items, total: items.length });
  } catch (err) {
    logger.error('Queue list failed', err.message);
    return error(res, err.message);
  }
};

// ─── Unified jobs feed (queued + processing + completed + failed) ──
// Single endpoint for the FE Jobs tab. Reads straight from SQLite (jobs +
// videos + failures) so it's a few ms even with paging — no Cloudinary
// Search API on the hot path.
//
// Query params:
//   status=queued|processing|completed|failed|all   (default 'all')
//   page=N, limit=N (default 1, 24)
//
// Response items have a unified shape regardless of source table:
//   { videoId, status, lane, model, prompt, duration, aspectRatio,
//     resolution, videoUrl?, error?, createdAt, completedAt? }
export const getJobsFeed = async (req, res) => {
  try {
    const status = (req.query.status || 'all').toLowerCase();
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 24, 1), 100);
    const offset = (page - 1) * limit;

    // Lazy-load to avoid circular imports.
    const { db } = await import('../../services/aiVideo/db.js');

    // Vault filter: anonymous visitors (req.vault=false) only see vault=0 rows.
    // Authenticated callers see everything. The clause is injected into each
    // UNION leg so SQLite can still use the per-table indexes.
    const vClause = req.vault ? '' : ' WHERE vault = 0';
    const vClauseAnd = req.vault ? '' : ' AND vault = 0';

    // We UNION ALL three sources, then sort by ts and page. Each row carries
    // a normalized `status` and `ts` (ms epoch) so the FE can render uniformly.
    const sql = `
      WITH unified AS (
        SELECT videoId, status,
               COALESCE(originalProvider, provider) AS lane,
               model, prompt, duration, aspectRatio, resolution,
               videoUrl, error, createdAt,
               COALESCE(completedAt, startedAt, createdAt) AS ts,
               'jobs' AS src
          FROM jobs${vClause}
        UNION ALL
        SELECT videoId, 'completed' AS status,
               provider AS lane,
               model, prompt, duration, aspectRatio, resolution,
               videoUrl, NULL AS error, createdAt,
               createdAt AS ts,
               'videos' AS src
          FROM videos${vClause}
        UNION ALL
        SELECT videoId, 'failed' AS status,
               originalProvider AS lane,
               model, prompt, duration, aspectRatio, resolution,
               NULL AS videoUrl, error, createdAt,
               failedAt AS ts,
               'failures' AS src
          FROM failures${vClause}
      )
      SELECT * FROM unified
      ${status === 'all' ? '' : 'WHERE status = @status'}
      ORDER BY ts DESC
      LIMIT @limit OFFSET @offset
    `;
    const countSql = `
      WITH unified AS (
        SELECT videoId, status FROM jobs${vClause}
        UNION ALL SELECT videoId, 'completed' FROM videos${vClause}
        UNION ALL SELECT videoId, 'failed'    FROM failures${vClause}
      )
      SELECT COUNT(*) AS n FROM unified
      ${status === 'all' ? '' : 'WHERE status = @status'}
    `;

    const items = db.prepare(sql).all({ status, limit, offset });
    const total = db.prepare(countSql).get({ status }).n;

    return success(res, {
      items, total, page, limit,
      pages: Math.max(1, Math.ceil(total / limit)),
      counts: db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM jobs     WHERE status='queued'    ${vClauseAnd}) AS queued,
          (SELECT COUNT(*) FROM jobs     WHERE status='processing'${vClauseAnd}) AS processing,
          (SELECT COUNT(*) FROM videos   WHERE 1=1                ${vClauseAnd}) AS completed,
          (SELECT COUNT(*) FROM failures WHERE 1=1                ${vClauseAnd}) AS failed
      `).get(),
    });
  } catch (err) {
    logger.error('Jobs feed failed', err.message);
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
    const result = listFailures({ provider, page, limit, vault: !!req.vault });
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

// ─── Image Enhancer (async, queue + Gemini cloud OR 5090 local) ──
// Replaces the old sync implementation. Both engines write to the same
// `enhanced_images` table and follow the same FE polling lifecycle:
//   queued → processing → completed | failed
//
// Cloud (Gemini): processed inline on the BE in a fire-and-forget background
// task — no worker needed. Status flips to 'processing' immediately.
// Local (5090):  published to image_enhance_queue; the 5090 worker picks it
// up, runs the ComfyUI workflow, and POSTs back via job-progress / -complete.
export const postImageEnhance = async (req, res) => {
  try {
    const {
      dataUrl, imageUrl, prompt, presetId,
      type = 'fast', engine = 'cloud',
      workflow, steps, denoise, cfg, width, height,
      model: customModel,
      negativePrompt,
    } = req.body || {};

    // Auth model:
    //   • Not logged in → NSFW prompt filter blocks unsafe inputs; output → public library
    //   • Logged in    → no filter; output ALWAYS lands in private Vault library
    // No client-side flag needed; the auth token (Authorization header) does both.
    const nsfw = classifyNsfw(prompt);
    if (nsfw && !req.vault) {
      return res.status(401).json({
        status: false,
        message: `Looks NSFW — log in to bypass (detected: ${nsfw.category})`,
        code: 'NSFW_BLOCKED',
        category: nsfw.category,
      });
    }
    // All NEW image jobs land public. Logged-in users can flip them to Vault
    // explicitly via the library's "Move to Vault" action — see
    // postImageBulkAction. No more automatic vault routing on submit.
    const vaultFlag = false;
    // Accept legacy 'local' as an alias for 'atelier'.
    const eng = engine === 'local' ? 'atelier' : engine;
    if (!['cloud', 'atelier'].includes(eng)) {
      return error(res, 'engine must be cloud or atelier', 400);
    }
    // Workflow allowlist for atelier; cloud only uses presets/prompts.
    const ATELIER_WORKFLOWS = new Set([
      'realesrgan-x4', 'ultrasharp-x4', 'nmkd-siax',
      'sdxl-polish', 'sdxl-t2i', 'flux-kontext-edit',
      'custom-sdxl', 'custom-t2i',
    ]);
    if (eng === 'atelier' && workflow && !ATELIER_WORKFLOWS.has(workflow)) {
      return error(res, `unknown atelier workflow: ${workflow}`, 400);
    }
    // Source-image rule: t2i workflows don't need an image.
    const isT2I = workflow === 'sdxl-t2i' || workflow === 'custom-t2i';
    if (!isT2I && !dataUrl && !imageUrl) {
      const friendly = workflow
        ? `Workflow "${workflow}" needs a source image. Upload one, or pick a "text→image" workflow.`
        : 'Upload a source image first.';
      return error(res, friendly, 400);
    }
    if (!prompt || typeof prompt !== 'string' || prompt.length < 3) {
      return error(res, 'prompt is required', 400);
    }
    if (!isCdnConfigured()) {
      return error(res, 'Cloudinary not configured on server', 503);
    }
    if (!['fast', 'quality', 'cinematic', 'edit', 't2i', 'img2img', 'upscale'].includes(type)) {
      return error(res, `unknown type: ${type}`, 400);
    }

    // Source upload only when needed (t2i workflow has no source image).
    let sourceUrl = imageUrl || null;
    if (!isT2I && !sourceUrl && dataUrl) {
      const upload = await cdnUpload(dataUrl);
      sourceUrl = upload.url;
    }

    const job = createImage({
      status: eng === 'cloud' ? 'processing' : 'queued',
      type, engine: eng, presetId: presetId || null,
      prompt, sourceUrl,
      workflow: workflow || null,
      steps: typeof steps === 'number' ? steps : null,
      denoise: typeof denoise === 'number' ? denoise : null,
      cfg: typeof cfg === 'number' ? cfg : null,
      width: typeof width === 'number' ? width : null,
      height: typeof height === 'number' ? height : null,
      customModel: typeof customModel === 'string' && customModel.trim() ? customModel.trim() : null,
      negativePrompt: typeof negativePrompt === 'string' && negativePrompt.trim() ? negativePrompt.trim() : null,
      vault: vaultFlag ? 1 : 0,
      startedAt: eng === 'cloud' ? new Date().toISOString() : null,
    });

    if (eng === 'cloud') {
      // Fire-and-forget; FE polls /status. Errors recorded into the SQLite row.
      runCloudEnhance(job).catch((err) => {
        logger.error(`Cloud enhance ${job.imageId} failed: ${err.message}`);
        updateImage(job.imageId, {
          status: 'failed', error: err.message.slice(0, 800),
          completedAt: new Date().toISOString(),
        });
      });
    } else {
      // Atelier — push trigger to RabbitMQ (worker fallback to HTTP polling on broker outages)
      publishImageJob({ imageId: job.imageId, type, engine: eng, presetId })
        .catch((err) => logger.warn(`Image publish skipped: ${err.message}`));
    }

    logger.info(`IMAGE_ENHANCE QUEUE | ${job.imageId} | engine=${eng} workflow=${workflow || '-'} type=${type} vault=${vaultFlag ? 'YES' : 'no'} authHeader=${!!req.headers.authorization}`);
    return success(res, {
      imageId: job.imageId,
      status: job.status,
      engine: eng, type, presetId: presetId || null,
      workflow: workflow || null,
      sourceUrl,
    });
  } catch (err) {
    logger.error('Image enhance queue failed', err.message);
    return error(res, err.message, 502);
  }
};

// Background processor for cloud (Gemini) jobs. Runs out-of-band; status is
// the only way the FE knows we're working on it.
//
// Auto-retry strategy: Gemini often refuses heavy identity-preservation
// prompts (especially on portraits) with `IMAGE_OTHER` or `SAFETY`. When that
// happens we retry once with a stripped-down generic enhancement prompt that
// the model accepts. The user still gets *an* enhancement, just less
// instruction-heavy than the preset they picked.
const FALLBACK_PROMPT = (
  'Enhance the image quality. Improve sharpness, lighting, contrast, and ' +
  'fine details. Keep the same composition, colors, and overall scene.'
);

async function runCloudEnhance(job) {
  // Fetch source as base64 for Gemini
  const imgRes = await fetch(job.sourceUrl);
  if (!imgRes.ok) throw new Error(`source fetch ${imgRes.status}`);
  const buf = Buffer.from(await imgRes.arrayBuffer());
  const mime = imgRes.headers.get('content-type') || 'image/jpeg';
  const inputBase64 = `data:${mime};base64,${buf.toString('base64')}`;

  let out;
  try {
    out = await enhanceImageGemini(inputBase64, job.prompt);
  } catch (e) {
    const msg = e.message || '';
    const refused = /IMAGE_OTHER|SAFETY|RECITATION|blockReason/i.test(msg);
    if (!refused) throw e;
    logger.warn(`Gemini refused first try (${msg.slice(0, 120)}) — retrying with softened prompt`);
    out = await enhanceImageGemini(inputBase64, FALLBACK_PROMPT);
  }

  const enhancedDataUrl = `data:${out.mimeType};base64,${out.base64}`;
  const upload = await cdnUpload(enhancedDataUrl);

  updateImage(job.imageId, {
    status: 'completed',
    outputUrl: upload.url,
    bytes: upload.bytes || out.base64.length,
    completedAt: new Date().toISOString(),
  });
}

// FE polls this every 1.5s while the spinner is up
export const getImageStatus = (req, res) => {
  try {
    const row = getImage(req.params.imageId);
    if (!row) return error(res, 'Not found', 404);
    // New jobs: logs are in the shared job_logs table.
    // Old jobs: logs were stored as a JSON string in the row's `logs` column —
    // fall back to that for back-compat so the gallery still shows history.
    let logs = listRecentLogs(row.imageId, 'image');
    if (logs.length === 0 && row.logs) {
      try { const p = JSON.parse(row.logs); if (Array.isArray(p)) logs = p; } catch {}
    }
    return success(res, { ...row, logs });
  } catch (err) {
    return error(res, err.message);
  }
};

// Library listing. Public callers see vault=0; logged-in callers can request
// `?visibility=vault` to see their private items. Default = public for safety.
export const getImageList = (req, res) => {
  try {
    const status = req.query.status || 'completed';
    const type = req.query.type || undefined;
    const engine = req.query.engine || undefined;
    const visibility = (req.query.visibility || 'public').toLowerCase();
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 24, 1), 100);

    // Auth required for vault view; silently downgrade if no token.
    const effective = req.vault ? visibility : 'public';
    const vault = effective === 'vault' ? 1 : effective === 'all' ? undefined : 0;

    const result = listImages({
      status: status === 'all' ? undefined : status,
      type, engine, vault, page, limit,
    });
    // Counts must match the visibility being viewed — Vault tab should NOT
    // show public counts. Pass the same vault filter into getImageCounts.
    result.counts = getImageCounts(vault);
    result.visibility = effective;
    return success(res, result);
  } catch (err) {
    return error(res, err.message);
  }
};

// Hard delete — removes the SQLite row + both Cloudinary assets if present.
export const deleteImage = async (req, res) => {
  try {
    const row = getImage(req.params.imageId);
    if (!row) return error(res, 'Not found', 404);
    deleteImageRow(req.params.imageId);
    // Cloudinary deletes run in parallel + fire-and-forget so the response is
    // fast. Both failure modes (404/403/network) are non-fatal — orphans get
    // auto-evicted on the free tier eventually.
    Promise.all([
      row.sourceUrl ? cdnDeleteImage(row.sourceUrl) : null,
      row.outputUrl ? cdnDeleteImage(row.outputUrl) : null,
    ]).catch(e => logger.warn(`Cloudinary cleanup partial: ${e.message}`));
    return success(res, { ok: true });
  } catch (err) {
    return error(res, err.message);
  }
};

// ─── Bulk actions (images) ────────────────────────────────────────
// One endpoint handles three actions to keep the FE plumbing tiny:
//   action: 'move-to-vault' | 'make-public' | 'delete'
//   ids:    array of imageId
// move-to-vault and make-public REQUIRE a valid vault token (requireVault
// middleware on the route). delete is open — same as the existing single
// delete route.
export const postImageBulkAction = async (req, res) => {
  try {
    const { action, ids } = req.body || {};
    if (!action || !['move-to-vault', 'make-public', 'delete'].includes(action)) {
      return error(res, 'action must be move-to-vault | make-public | delete', 400);
    }
    if (!Array.isArray(ids) || ids.length === 0) {
      return error(res, 'ids array is required', 400);
    }
    if (ids.length > 100) return error(res, 'max 100 ids per call', 400);

    if (action === 'delete') {
      // Fetch first so we know which Cloudinary URLs to clean up
      const rows = getImagesByIds(ids);
      const removed = deleteImagesBulk(ids);
      // Fire-and-forget Cloudinary cleanup
      const cdnPromises = [];
      for (const row of rows) {
        if (row.sourceUrl) cdnPromises.push(cdnDeleteImage(row.sourceUrl));
        if (row.outputUrl) cdnPromises.push(cdnDeleteImage(row.outputUrl));
      }
      Promise.all(cdnPromises).catch(e => logger.warn(`Cloudinary bulk cleanup partial: ${e.message}`));
      logger.info(`IMAGE BULK delete | ${removed}/${ids.length} rows`);
      return success(res, { ok: true, action, affected: removed });
    }

    // move-to-vault / make-public — route is gated by requireVault upstream,
    // so getting here means the caller is authenticated.
    const moveToVault = action === 'move-to-vault';
    const affected = setImagesVault(ids, moveToVault);
    logger.info(`IMAGE BULK ${action} | ${affected}/${ids.length} rows`);
    return success(res, { ok: true, action, affected });
  } catch (err) {
    logger.error('Image bulk action failed', err.message);
    return error(res, err.message);
  }
};

// ─── Bulk actions (videos) ────────────────────────────────────────
// Same three actions. Operates across both jobs (in-flight) AND videos
// (completed) tables so a single bulk call can move/delete items wherever
// they live in the pipeline.
export const postVideoBulkAction = async (req, res) => {
  try {
    const { action, ids } = req.body || {};
    if (!action || !['move-to-vault', 'make-public', 'delete'].includes(action)) {
      return error(res, 'action must be move-to-vault | make-public | delete', 400);
    }
    if (!Array.isArray(ids) || ids.length === 0) {
      return error(res, 'ids array is required', 400);
    }
    if (ids.length > 100) return error(res, 'max 100 ids per call', 400);

    if (action === 'delete') {
      const rows = getLocalVideosByIds(ids);
      const inflightRemoved = await removeInflightJobs(ids);
      const videoRemoved = deleteLocalVideos(ids);
      // Cloudinary cleanup for completed videos
      Promise.all(
        rows.map(r => r.videoId ? deleteVideo(r.videoId) : null).filter(Boolean)
      ).catch(e => logger.warn(`Cloudinary video bulk cleanup partial: ${e.message}`));
      const affected = inflightRemoved + videoRemoved;
      logger.info(`VIDEO BULK delete | inflight=${inflightRemoved} videos=${videoRemoved}`);
      return success(res, { ok: true, action, affected });
    }

    // move-to-vault / make-public — flip on BOTH tables in one call
    const moveToVault = action === 'move-to-vault';
    const inflightChanged = await setInflightVault(ids, moveToVault);
    const videosChanged = setVideosVault(ids, moveToVault);
    const affected = inflightChanged + videosChanged;
    logger.info(`VIDEO BULK ${action} | inflight=${inflightChanged} videos=${videosChanged}`);
    return success(res, { ok: true, action, affected });
  } catch (err) {
    logger.error('Video bulk action failed', err.message);
    return error(res, err.message);
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
