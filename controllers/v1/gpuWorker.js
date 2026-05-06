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
    duration: job.duration,
    resolution: job.resolution,
    aspectRatio: job.aspectRatio,
    style: job.style,
    audio: job.audio,
    imageUrl: job.imageUrl,
    public_id: job.videoId,
    context: {
      prompt: job.prompt,
      provider: role,
      duration: String(job.duration || 5),
      aspectRatio: job.aspectRatio || '9:16',
      resolution: job.resolution || '720p',
      style: job.style || '',
      audio: job.audio ? '1' : '0',
      createdAt: job.createdAt,
    },
    tags: [role, job.aspectRatio || ''].filter(Boolean),
  });
};

export const postJobComplete = async (req, res) => {
  if (!checkAuth(req)) return error(res, 'Invalid worker token', 401);
  const { jobId, videoUrl } = req.body || {};
  if (!jobId || !videoUrl) return error(res, 'jobId and videoUrl required', 400);

  // Worker has already uploaded to Cloudinary. We just clear the in-flight record.
  const job = await getInflightJob(jobId);
  if (!job) return error(res, 'Job not found', 404);

  await removeInflightJob(jobId);
  logger.info(`Job ${jobId} completed by worker → ${videoUrl}`);
  return success(res, { ok: true, videoId: jobId, videoUrl });
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
    completedAt: shouldRequeue ? null : new Date().toISOString(),
    workerId: shouldRequeue ? null : existing.workerId,
    startedAt: shouldRequeue ? null : existing.startedAt,
  });

  logger.warn(`Job ${jobId} failed (attempt ${attemptCount}/2): ${errMsg}. ${shouldRequeue ? 'Requeued.' : 'Final.'}`);
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
