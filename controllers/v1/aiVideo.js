import { success, error } from '../../helpers/res_helper.js';
import { VIDEO_PROVIDERS } from '../../services/aiVideo/index.js';
import {
  createJob, getJob, getRecentJobs, getLatestCompletedJob,
  getWorkerStatus, isWorkerOnline,
} from '../../services/aiVideo/jobStore.js';
import { processQueuedJobs } from '../../services/aiVideo/jobProcessor.js';
import { tryWakeWorker } from '../../services/aiVideo/wakeWorker.js';
import logger from '../../helpers/logger.js';

const ALIASES = { worker: 'comfyui', gpu: 'comfyui', hf: 'zsky', huggingface: 'zsky' };

export const postGenerateVideo = async (req, res) => {
  try {
    const {
      prompt,
      provider: rawProvider = 'auto',
      model,
      duration = 5,
      resolution = '1080p',
      aspectRatio = '9:16',
      style = 'cinematic',
      audio = true,
      imageUrl = '',
      generateCaption = true,
    } = req.body || {};

    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      return error(res, 'Prompt is required', 400);
    }

    const p = ALIASES[rawProvider.toLowerCase()] || rawProvider.toLowerCase();
    if (!VIDEO_PROVIDERS.includes(p)) {
      return error(res, `Invalid provider. Use one of: ${VIDEO_PROVIDERS.join(', ')}`, 400);
    }

    const job = await createJob({
      prompt: prompt.trim(),
      provider: p,
      model,
      duration,
      resolution,
      aspectRatio,
      style,
      audio,
      imageUrl,
      generateCaption,
    });

    logger.info(`Queued ${job.jobId} | provider=${p} | "${prompt.slice(0, 50)}"`);

    if (p !== 'comfyui') {
      setImmediate(() => processQueuedJobs());
    } else {
      const workerStatus = await getWorkerStatus();
      if (!isWorkerOnline(workerStatus)) {
        tryWakeWorker({ jobId: job.jobId, prompt: job.prompt }).catch(() => {});
      }
    }

    return success(res, {
      success: true,
      jobId: job.jobId,
      status: job.status,
      provider: job.provider,
      message: p === 'comfyui'
        ? 'Job queued — waiting for GPU worker'
        : 'Job queued — processing now',
    });
  } catch (err) {
    logger.error('AI video queue failed', err.message);
    return error(res, err.message, 500);
  }
};

export const getJobStatus = async (req, res) => {
  try {
    const job = await getJob(req.params.jobId);
    if (!job) return error(res, 'Job not found', 404);
    return success(res, job);
  } catch (err) {
    return error(res, err.message);
  }
};

export const getTodayVideo = async (_req, res) => {
  try {
    const latest = await getLatestCompletedJob();
    return success(res, latest || null);
  } catch (err) {
    return error(res, err.message);
  }
};

export const getVideoList = async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);
    const items = await getRecentJobs(limit);
    return success(res, items);
  } catch (err) {
    return error(res, err.message);
  }
};

export const getVideoProviders = async (_req, res) => {
  const workerStatus = await getWorkerStatus();
  return success(res, {
    providers: VIDEO_PROVIDERS,
    fallbackOrder: ['zsky', 'comfyui'],
    workerOnline: isWorkerOnline(workerStatus),
    workerLastSeen: workerStatus?.lastSeenAt || null,
    workerId: workerStatus?.workerId || null,
  });
};
