import { generateVideo } from './index.js';
import { generateGroqCaption } from './caption.js';
import { saveVideoBuffer } from './storage.js';
import { updateJob, getQueuedForBE } from './jobStore.js';
import logger from '../../helpers/logger.js';

let processing = false;

async function processOne(job) {
  await updateJob(job.jobId, { status: 'processing', startedAt: new Date().toISOString() });

  try {
    const result = await generateVideo(job.prompt, {
      provider: job.provider,
      model: job.model,
      duration: job.duration,
      resolution: job.resolution,
      aspectRatio: job.aspectRatio,
      audio: job.audio,
      style: job.style,
      imageUrl: job.imageUrl,
    });

    let videoUrl = result.videoUrl;
    if (!videoUrl && result.buffer) {
      const saved = await saveVideoBuffer(result.buffer, job.jobId);
      videoUrl = saved.publicPath;
    }
    if (!videoUrl) throw new Error('Provider returned neither a videoUrl nor a buffer');

    let caption = null;
    if (job.generateCaption) {
      caption = await generateGroqCaption(job.prompt).catch(() => null);
    }

    await updateJob(job.jobId, {
      status: 'completed',
      videoUrl,
      caption,
      provider: result.providerUsed || result.provider || job.provider,
      completedAt: new Date().toISOString(),
    });
    logger.info(`Job ${job.jobId} completed via ${result.providerUsed || job.provider}`);
  } catch (err) {
    const attemptCount = (job.attemptCount || 0) + 1;
    const finalFail = err.contentPolicy || attemptCount >= 2;
    await updateJob(job.jobId, {
      status: finalFail ? 'failed' : 'queued',
      error: err.message,
      attemptCount,
      startedAt: finalFail ? job.startedAt : null,
      completedAt: finalFail ? new Date().toISOString() : null,
    });
    logger.warn(`Job ${job.jobId} ${finalFail ? 'failed' : 'requeued'} (attempt ${attemptCount}): ${err.message}`);
  }
}

export async function processQueuedJobs() {
  if (processing) return;
  processing = true;
  try {
    const queued = await getQueuedForBE();
    for (const job of queued) {
      await processOne(job);
    }
  } finally {
    processing = false;
  }
}

export function startJobProcessor(intervalMs = 5000) {
  setInterval(() => {
    processQueuedJobs().catch(err => logger.error('Job processor tick error:', err.message));
  }, intervalMs);
  logger.info(`Job processor started (poll every ${intervalMs}ms)`);
}
