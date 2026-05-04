import path from 'path';
import fs from 'fs';
import { success, error } from '../../helpers/res_helper.js';
import { GPU_WORKER_TOKEN } from '../../helpers/constants.js';
import {
  recordWorkerHeartbeat, getNextQueuedForProvider, updateJob, getJob,
} from '../../services/aiVideo/jobStore.js';
import logger from '../../helpers/logger.js';

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
  const { workerId } = req.body || {};
  if (!workerId) return error(res, 'workerId is required', 400);
  const status = await recordWorkerHeartbeat(workerId);
  logger.info(`GPU worker registered: ${workerId}`);
  return success(res, status);
};

export const getNextJob = async (req, res) => {
  if (!checkAuth(req)) return error(res, 'Invalid worker token', 401);

  const workerId = req.query.workerId || req.headers['x-worker-id'] || 'unknown';
  await recordWorkerHeartbeat(workerId);

  const job = await getNextQueuedForProvider(['comfyui']);
  if (!job) return success(res, null);

  await updateJob(job.jobId, {
    status: 'processing',
    startedAt: new Date().toISOString(),
    workerId,
    attemptCount: (job.attemptCount || 0) + 1,
  });

  logger.info(`Dispatched ${job.jobId} → ${workerId}`);
  return success(res, {
    jobId: job.jobId,
    prompt: job.prompt,
    duration: job.duration,
    resolution: job.resolution,
    aspectRatio: job.aspectRatio,
    style: job.style,
    audio: job.audio,
    imageUrl: job.imageUrl,
  });
};

export const postJobComplete = async (req, res) => {
  if (!checkAuth(req)) return error(res, 'Invalid worker token', 401);
  const { jobId, videoUrl, caption } = req.body || {};
  if (!jobId || !videoUrl) return error(res, 'jobId and videoUrl required', 400);

  const job = await updateJob(jobId, {
    status: 'completed',
    videoUrl,
    caption: caption ?? null,
    completedAt: new Date().toISOString(),
    error: null,
  });
  if (!job) return error(res, 'Job not found', 404);

  logger.info(`Job ${jobId} completed by worker`);
  return success(res, job);
};

export const getWorkerFile = (req, res) => {
  if (!checkAuth(req)) return error(res, 'Invalid worker token', 401);

  const fname = req.params.filename;
  if (!ALLOWED_FILES.has(fname)) return error(res, 'File not allowed', 403);

  const filePath = path.join(WORKER_FILES_DIR, fname);
  // Hard guard against path traversal
  if (!filePath.startsWith(WORKER_FILES_DIR)) return error(res, 'Forbidden', 403);
  if (!fs.existsSync(filePath)) return error(res, 'File not found', 404);

  res.type(fname.endsWith('.sh') ? 'text/x-shellscript' : 'text/plain');
  res.setHeader('Cache-Control', 'no-store');
  fs.createReadStream(filePath).pipe(res);
};

export const postJobFailed = async (req, res) => {
  if (!checkAuth(req)) return error(res, 'Invalid worker token', 401);
  const { jobId, error: errMsg, requeue = true } = req.body || {};
  if (!jobId) return error(res, 'jobId required', 400);

  const existing = await getJob(jobId);
  if (!existing) return error(res, 'Job not found', 404);

  const attemptCount = existing.attemptCount || 0;
  const shouldRequeue = requeue && attemptCount < 2;

  const job = await updateJob(jobId, {
    status: shouldRequeue ? 'queued' : 'failed',
    error: errMsg || 'unknown error',
    completedAt: shouldRequeue ? null : new Date().toISOString(),
    workerId: shouldRequeue ? null : existing.workerId,
    startedAt: shouldRequeue ? null : existing.startedAt,
  });

  logger.warn(`Job ${jobId} failed (attempt ${attemptCount}/2): ${errMsg}. ${shouldRequeue ? 'Requeued.' : 'Final.'}`);
  return success(res, job);
};
