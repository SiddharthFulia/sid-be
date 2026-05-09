import path from 'path';
import fs from 'fs';
import { success, error } from '../../helpers/res_helper.js';
import { GPU_WORKER_TOKEN } from '../../helpers/constants.js';
import {
  recordWorkerHeartbeat,
} from '../../services/aiVideo/jobStore.js';
import {
  getInflightJob, updateInflightJob, removeInflightJob, getNextQueuedForRole,
} from '../../services/aiVideo/storage.js';

const VALID_ROLES = new Set(['worker', 'local']);
function normalizeRole(role) {
  const r = (role || 'worker').toLowerCase();
  return VALID_ROLES.has(r) ? r : 'worker';
}
import logger from '../../helpers/logger.js';
import { recordFailure } from '../../services/aiVideo/failureStore.js';
import { recordVideo } from '../../services/aiVideo/videoStore.js';
import { generateGroqCaption } from '../../services/aiVideo/caption.js';

const WORKER_FILES_DIR = path.join(process.cwd(), 'gpu-worker');
const ALLOWED_FILES = new Set([
  'worker.py', 'comfyui_client.py', 'cloudinary_upload.py',
  'requirements.txt', 'wake.sh', '.env.example',
]);

function checkAuth(req) {
  if (!GPU_WORKER_TOKEN) return true;
  const auth = req.headers.authorization || '';
  const headerToken = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const bodyToken = req.body?.token || '';
  return headerToken === GPU_WORKER_TOKEN || bodyToken === GPU_WORKER_TOKEN;
}

export const postRegister = async (req, res) => {
  if (!checkAuth(req)) return error(res, 'Invalid worker token', 401);
  const { workerId, role } = req.body || {};
  if (!workerId) return error(res, 'workerId is required', 400);
  const r = normalizeRole(role);
  const status = await recordWorkerHeartbeat(workerId, r);
  logger.info(`GPU worker registered: ${workerId} (role=${r})`);
  return success(res, status);
};

export const getNextJob = async (req, res) => {
  if (!checkAuth(req)) return error(res, 'Invalid worker token', 401);

  const workerId = req.query.workerId || req.headers['x-worker-id'] || 'unknown';
  const role = normalizeRole(req.query.role || req.headers['x-worker-role']);
  await recordWorkerHeartbeat(workerId, role);

  const job = await getNextQueuedForRole(role);
  if (!job) return success(res, null);

  await updateInflightJob(job.videoId, {
    status: 'processing',
    startedAt: new Date().toISOString(),
    workerId,
    attemptCount: (job.attemptCount || 0) + 1,
  });

  logger.info(`Dispatched ${job.videoId} → ${workerId} (${role})`);
  return success(res, {
    jobId: job.videoId,
    prompt: job.prompt,
    model: job.model || 'ltx-video',
    duration: job.duration,
    resolution: job.resolution,
    aspectRatio: job.aspectRatio,
    steps: job.steps || 30,
    style: job.style,
    audio: job.audio,
    imageUrl: job.imageUrl,
    public_id: job.videoId,
    context: {
      prompt: job.prompt,
      // originalProvider preserves the FE-facing label ('optimized' vs 'local')
      // so the Library can filter videos by which 5090 lane they came from,
      // even though both lanes share the same worker role.
      provider: job.originalProvider || role,
      duration: String(job.duration || 5),
      aspectRatio: job.aspectRatio || '9:16',
      resolution: job.resolution || '720p',
      style: job.style || '',
      audio: job.audio ? '1' : '0',
      createdAt: job.createdAt,
    },
    tags: [job.originalProvider || role, job.aspectRatio || ''].filter(Boolean),
  });
};

export const postJobComplete = async (req, res) => {
  if (!checkAuth(req)) return error(res, 'Invalid worker token', 401);
  const { jobId, videoUrl } = req.body || {};
  if (!jobId || !videoUrl) return error(res, 'jobId and videoUrl required', 400);

  // Worker has already uploaded to Cloudinary. We just clear the in-flight record.
  const job = await getInflightJob(jobId);
  if (!job) return error(res, 'Job not found', 404);

  // Caption generation — the worker doesn't have the Groq key, so the BE
  // does it here using the job's original prompt. ZSky already does this
  // sync; for the 5090/Lightning lanes this fills the gap.
  // Fast (~200ms via Groq llama-3.1-8b-instant) so we run it inline.
  let caption = req.body?.caption ?? null;
  if (!caption && job.generateCaption !== false) {
    try {
      caption = await generateGroqCaption(job.prompt);
    } catch (e) {
      logger.warn(`Groq caption failed for ${jobId}: ${e.message}`);
    }
  }

  // Mirror the completed video into our local SQLite cache so the Library
  // tab can paginate / filter without paying the Cloudinary Search-API tax.
  // Failures here are non-fatal — Cloudinary remains the source of truth.
  try {
    recordVideo({
      videoId: jobId,
      publicId: jobId,
      videoUrl,
      prompt: job.prompt,
      provider: job.originalProvider || job.provider,
      model: job.model,
      duration: job.duration,
      aspectRatio: job.aspectRatio,
      resolution: job.resolution,
      style: job.style,
      audio: !!job.audio,
      caption,
      bytes: req.body?.bytes ?? null,
      createdAt: job.createdAt,
      cloudinaryContext: {
        prompt: job.prompt,
        provider: job.originalProvider || job.provider,
        caption: caption || '',
      },
    });
  } catch (e) {
    logger.error('recordVideo failed (non-fatal)', e.message);
  }

  await removeInflightJob(jobId);
  logger.info(`Job ${jobId} completed by worker → ${videoUrl}${caption ? ' (with caption)' : ''}`);
  return success(res, { ok: true, videoId: jobId, videoUrl, caption });
};

export const postJobFailed = async (req, res) => {
  if (!checkAuth(req)) return error(res, 'Invalid worker token', 401);
  const { jobId, error: errMsg, requeue = true } = req.body || {};
  if (!jobId) return error(res, 'jobId required', 400);

  const existing = await getInflightJob(jobId);
  if (!existing) return error(res, 'Job not found', 404);

  const attemptCount = existing.attemptCount || 0;
  const shouldRequeue = requeue && attemptCount < 2;

  const job = await updateInflightJob(jobId, {
    status: shouldRequeue ? 'queued' : 'failed',
    error: errMsg || 'unknown error',
    attemptCount: attemptCount + 1,
    completedAt: shouldRequeue ? null : new Date().toISOString(),
    workerId: shouldRequeue ? null : existing.workerId,
    startedAt: shouldRequeue ? null : existing.startedAt,
  });

  // Permanent failures land in the audit table so the FE Failures tab can
  // show them (and we keep history even if the job row is later evicted).
  if (!shouldRequeue) {
    try {
      recordFailure({ job: existing, error: errMsg, workerId: existing.workerId });
    } catch (e) {
      logger.error('Failed to record failure audit row', e.message);
    }
  }

  logger.warn(`Job ${jobId} failed (attempt ${attemptCount + 1}/3): ${errMsg}. ${shouldRequeue ? 'Requeued.' : 'Final.'}`);
  return success(res, job);
};

// Worker reports progress mid-job: estimated total seconds + optional message.
// FE polls /status/:jobId and computes live ETA from startedAt + estimatedSeconds.
export const postJobProgress = async (req, res) => {
  if (!checkAuth(req)) return error(res, 'Invalid worker token', 401);
  const { jobId, estimatedSeconds, message, step, totalSteps, logLine } = req.body || {};
  if (!jobId) return error(res, 'jobId required', 400);

  const updates = {};
  if (typeof estimatedSeconds === 'number') updates.estimatedSeconds = estimatedSeconds;
  if (message) updates.progressMessage = String(message).slice(0, 200);
  if (typeof step === 'number') updates.progressStep = step;
  if (typeof totalSteps === 'number') updates.progressTotal = totalSteps;

  // Append a structured log entry. The worker streams human-readable lines
  // here (e.g. "queued by 5090 worker", "ComfyUI step 12/30 @ 1.7s/step",
  // "uploading to Cloudinary", "https://res.cloudinary.com/...") so the FE
  // can show a live activity feed for the in-flight job. Cap at the most
  // recent 80 entries to keep the JSON file from ballooning.
  if (logLine) {
    const existing = (await getInflightJob(jobId))?.logs || [];
    const next = [...existing, { ts: Date.now(), msg: String(logLine).slice(0, 300) }];
    updates.logs = next.slice(-80);
  }

  if (!Object.keys(updates).length) return success(res, { ok: true });

  const job = await updateInflightJob(jobId, updates);
  if (!job) return error(res, 'Job not found', 404);
  return success(res, job);
};

export const getWorkerFile = (req, res) => {
  if (!checkAuth(req)) return error(res, 'Invalid worker token', 401);
  const fname = req.params.filename;
  if (!ALLOWED_FILES.has(fname)) return error(res, 'File not allowed', 403);
  const filePath = path.join(WORKER_FILES_DIR, fname);
  if (!filePath.startsWith(WORKER_FILES_DIR)) return error(res, 'Forbidden', 403);
  if (!fs.existsSync(filePath)) return error(res, 'File not found', 404);
  res.type(fname.endsWith('.sh') ? 'text/x-shellscript' : 'text/plain');
  res.setHeader('Cache-Control', 'no-store');
  fs.createReadStream(filePath).pipe(res);
};
