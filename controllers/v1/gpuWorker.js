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
import { updateImage, appendImageLog } from '../../services/aiVideo/enhancedImageStore.js';
import { updateLipsyncJob, appendLipsyncLog } from '../../services/aiVideo/lipsyncStore.js';
import { updateAudioJob, appendAudioLog } from '../../services/aiVideo/audioStore.js';
import { appendLog as appendJobLog } from '../../services/aiVideo/logStore.js';

function checkAuth(req) {
  if (!GPU_WORKER_TOKEN) return true;
  const auth = req.headers.authorization || '';
  const headerToken = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const bodyToken = req.body?.token || '';
  return headerToken === GPU_WORKER_TOKEN || bodyToken === GPU_WORKER_TOKEN;
}

export const postRegister = async (req, res) => {
  if (!checkAuth(req)) return error(res, 'Invalid worker token', 401);
  const { workerId, role, ollamaModels } = req.body || {};
  if (!workerId) return error(res, 'workerId is required', 400);
  const r = normalizeRole(role);
  const extras = {};
  if (Array.isArray(ollamaModels)) {
    // Defensive — cap at 200 entries and only keep name/size to stop
    // workers from accidentally spamming the heartbeat with bloat.
    extras.ollamaModels = ollamaModels.slice(0, 200).map(m => ({
      name: String(m?.name || '').slice(0, 120),
      size: typeof m?.size === 'number' ? m.size : null,
    })).filter(m => m.name);
  }
  const status = await recordWorkerHeartbeat(workerId, r, extras);
  logger.info(`GPU worker registered: ${workerId} (role=${r}, models=${extras.ollamaModels?.length ?? '-'})`);
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

  // Auto-promote queued → processing on first progress ping. The HTTP-polling
  // path (getNextJob) sets this when handing the job to the worker, but the
  // broker-push path doesn't — worker just yanks from RabbitMQ and starts
  // work. Without this, the FE card stays stuck on 'Queued' until completion.
  // Same auto-promote behaviour as postImageProgress / postLipsyncProgress.
  try {
    const existing = await getInflightJob(jobId);
    if (existing && existing.status === 'queued') {
      updates.status = 'processing';
      if (!existing.startedAt) updates.startedAt = new Date().toISOString();
    }
  } catch { /* lookup failure → skip promote, non-fatal */ }

  // Log lines route through the shared job_logs table (logStore) so the
  // `jobs` row itself stays lean. Worker streams human-readable lines
  // here ("queued by 5090 worker", "ComfyUI step 12/30 @ 1.7s/step", etc).
  if (logLine) {
    appendJobLog(jobId, 'video', logLine);
  }

  if (!Object.keys(updates).length) return success(res, { ok: true });

  const job = await updateInflightJob(jobId, updates);
  if (!job) return error(res, 'Job not found', 404);
  return success(res, job);
};

// Live log feed for image jobs (mirrors postJobProgress for video jobs).
// Auto-promotes the row from queued → processing the moment the first log
// arrives — so the FE spinner shows the right label without the worker
// having to send an explicit status update.
export const postImageProgress = async (req, res) => {
  if (!checkAuth(req)) return error(res, 'Invalid worker token', 401);
  const { imageId, logLine, status } = req.body || {};
  if (!imageId) return error(res, 'imageId required', 400);
  if (logLine) appendImageLog(imageId, String(logLine));

  // Promote queued → processing on first log (worker has the job in hand).
  // Explicit status field from the worker still wins if provided.
  if (status === 'processing') {
    updateImage(imageId, { status: 'processing', startedAt: new Date().toISOString() });
  } else if (logLine) {
    // Read current row; if still queued, flip.
    const { getImage } = await import('../../services/aiVideo/enhancedImageStore.js');
    const row = getImage(imageId);
    if (row && row.status === 'queued') {
      updateImage(imageId, { status: 'processing', startedAt: new Date().toISOString() });
    }
  }
  return success(res, { ok: true });
};

// Image-enhance worker callbacks (mirrors postJobComplete/postJobFailed for videos)
export const postImageComplete = (req, res) => {
  if (!checkAuth(req)) return error(res, 'Invalid worker token', 401);
  const { imageId, outputUrl } = req.body || {};
  if (!imageId || !outputUrl) return error(res, 'imageId and outputUrl required', 400);
  const row = updateImage(imageId, {
    status: 'completed',
    outputUrl,
    completedAt: new Date().toISOString(),
  });
  if (!row) return error(res, 'Image not found', 404);
  logger.info(`Image ${imageId} completed by worker → ${outputUrl}`);
  return success(res, row);
};

export const postImageFailed = (req, res) => {
  if (!checkAuth(req)) return error(res, 'Invalid worker token', 401);
  const { imageId, error: errMsg } = req.body || {};
  if (!imageId) return error(res, 'imageId required', 400);
  const row = updateImage(imageId, {
    status: 'failed',
    error: String(errMsg || 'unknown').slice(0, 800),
    completedAt: new Date().toISOString(),
  });
  if (!row) return error(res, 'Image not found', 404);
  logger.warn(`Image ${imageId} failed: ${errMsg}`);
  return success(res, row);
};

// ─── Lip Sync worker callbacks ────────────────────────────────────
export const postLipsyncProgress = (req, res) => {
  if (!checkAuth(req)) return error(res, 'Invalid worker token', 401);
  const { jobId, logLine } = req.body || {};
  if (!jobId || !logLine) return error(res, 'jobId + logLine required', 400);
  // Auto-flip queued→processing on first log
  const existing = updateLipsyncJob(jobId, {});
  if (existing && existing.status === 'queued') {
    updateLipsyncJob(jobId, { status: 'processing', startedAt: new Date().toISOString() });
  }
  appendLipsyncLog(jobId, logLine);
  return success(res, { ok: true });
};

export const postLipsyncComplete = (req, res) => {
  if (!checkAuth(req)) return error(res, 'Invalid worker token', 401);
  const { jobId, outputUrl, durationMs, bytes } = req.body || {};
  if (!jobId || !outputUrl) return error(res, 'jobId + outputUrl required', 400);
  const row = updateLipsyncJob(jobId, {
    status: 'completed', outputUrl,
    durationMs: durationMs || null, bytes: bytes || null,
    completedAt: new Date().toISOString(),
  });
  if (!row) return error(res, 'Lipsync job not found', 404);
  logger.info(`Lipsync ${jobId} completed → ${outputUrl}`);
  return success(res, row);
};

export const postLipsyncFailed = (req, res) => {
  if (!checkAuth(req)) return error(res, 'Invalid worker token', 401);
  const { jobId, error: errMsg } = req.body || {};
  if (!jobId) return error(res, 'jobId required', 400);
  const row = updateLipsyncJob(jobId, {
    status: 'failed', error: String(errMsg || 'unknown').slice(0, 800),
    completedAt: new Date().toISOString(),
  });
  if (!row) return error(res, 'Lipsync job not found', 404);
  logger.warn(`Lipsync ${jobId} failed: ${errMsg}`);
  return success(res, row);
};

// ─── Audio Studio worker callbacks ────────────────────────────────
export const postAudioProgress = (req, res) => {
  if (!checkAuth(req)) return error(res, 'Invalid worker token', 401);
  const { jobId, logLine } = req.body || {};
  if (!jobId || !logLine) return error(res, 'jobId + logLine required', 400);
  const existing = updateAudioJob(jobId, {});
  if (existing && existing.status === 'queued') {
    updateAudioJob(jobId, { status: 'processing', startedAt: new Date().toISOString() });
  }
  appendAudioLog(jobId, logLine);
  return success(res, { ok: true });
};

export const postAudioComplete = (req, res) => {
  if (!checkAuth(req)) return error(res, 'Invalid worker token', 401);
  const { jobId, outputUrl, bytes, transcript, stems, analysis } = req.body || {};
  if (!jobId) return error(res, 'jobId required', 400);
  // Job-type completion shapes:
  //   • generation (music/sfx/tts)  → outputUrl
  //   • STT                          → transcript (text)
  //   • separate                     → stems (object of urls + lyrics)
  //   • voice-clone / voice-sing     → outputUrl + analysis (JSON stats)
  if (!outputUrl && typeof transcript !== 'string' && !stems) {
    return error(res, 'outputUrl, transcript, or stems required', 400);
  }
  const patch = {
    status: 'completed',
    completedAt: new Date().toISOString(),
  };
  if (outputUrl) { patch.outputUrl = outputUrl; patch.bytes = bytes || null; }
  if (typeof transcript === 'string') patch.transcript = transcript;
  if (stems && typeof stems === 'object') patch.stems = JSON.stringify(stems);
  // Worker sends `analysis` as a JSON string already (json.dumps in Python).
  // Pass through unchanged so the FE can JSON.parse on read.
  if (typeof analysis === 'string') patch.analysis = analysis;
  else if (analysis && typeof analysis === 'object') patch.analysis = JSON.stringify(analysis);
  const row = updateAudioJob(jobId, patch);
  if (!row) return error(res, 'Audio job not found', 404);
  logger.info(`Audio ${jobId} completed → ${
    outputUrl ? outputUrl
    : stems ? `${Object.keys(stems).length} stems`
    : `transcript (${transcript.length} chars)`
  }`);
  return success(res, row);
};

export const postAudioFailed = (req, res) => {
  if (!checkAuth(req)) return error(res, 'Invalid worker token', 401);
  const { jobId, error: errMsg } = req.body || {};
  if (!jobId) return error(res, 'jobId required', 400);
  const row = updateAudioJob(jobId, {
    status: 'failed', error: String(errMsg || 'unknown').slice(0, 800),
    completedAt: new Date().toISOString(),
  });
  if (!row) return error(res, 'Audio job not found', 404);
  logger.warn(`Audio ${jobId} failed: ${errMsg}`);
  return success(res, row);
};

// ─── Chat (Ollama on 5090) ────────────────────────────────────
// Worker posts back the assistant reply + token counts here.
import { getChatJob, updateChatJob } from '../../services/aiVideo/chatStore.js';
import {
  appendMessage as appendChatMessage,
  getConversation as getChatConversation,
} from '../../services/aiVideo/chatConversations.js';
import { generateImage as runImageGen } from '../../services/imageGen/index.js';
import { uploadChatAttachment as cdnUploadDataUrl } from '../../services/aiVideo/cloudinaryStore.js';

// Mirrors maybeRenderImage in ai.js — kept local to avoid a circular
// import. Caller passes the conversation's chosen Cloudflare model
// slug; null falls back to Flux Schnell inside the imageGen service.
const IMAGE_MARKER_RE_W = /```\s*generate-image\s*\n([\s\S]*?)\n\s*```/i;
async function maybeRenderImageW(reply, { model } = {}) {
  if (!reply) return null;
  const m = String(reply).match(IMAGE_MARKER_RE_W);
  if (!m) return null;
  const imagePrompt = m[1].trim();
  if (!imagePrompt) return null;
  try {
    const img = await runImageGen(imagePrompt, { provider: 'cloudflare', model });
    const up = await cdnUploadDataUrl(img.image);
    const cleaned = reply.replace(m[0], '').trim()
                 || `🎨 Generated: "${imagePrompt}"`;
    logger.info(`IMAGE GEN (worker) | model=${img.model} | prompt="${imagePrompt.slice(0, 80)}…" | url=${up.url}`);
    return { cleanedContent: cleaned, imageUrl: up.url, imagePrompt };
  } catch (e) {
    logger.warn(`Image gen (worker) failed: ${e.message}`);
    return null;
  }
}

export const postChatJob = (req, res) => {
  // Lets the worker pull the full chat_jobs row (including messages JSON
  // and imageUrl) — the queue trigger only carries the jobId.
  if (!checkAuth(req)) return error(res, 'Invalid worker token', 401);
  const row = getChatJob(req.params.jobId);
  if (!row) return error(res, 'Chat job not found', 404);
  // Inflate messages JSON for the worker's convenience.
  let messages = [];
  try { messages = JSON.parse(row.messages); } catch {}
  return success(res, { ...row, messages });
};

export const postChatProgress = (req, res) => {
  if (!checkAuth(req)) return error(res, 'Invalid worker token', 401);
  const { jobId } = req.body || {};
  if (!jobId) return error(res, 'jobId required', 400);
  // Promote queued → processing on first progress ping so the FE poller
  // sees the status transition.
  const row = updateChatJob(jobId, { status: 'processing', startedAt: new Date().toISOString() });
  if (!row) return error(res, 'Chat job not found', 404);
  return success(res, { ok: true });
};

export const postChatComplete = async (req, res) => {
  if (!checkAuth(req)) return error(res, 'Invalid worker token', 401);
  const { jobId, reply, elapsedMs, tokensIn, tokensOut } = req.body || {};
  if (!jobId || typeof reply !== 'string') return error(res, 'jobId + reply required', 400);

  // Image-gen fence → render only when the parent conversation has
  // opted in. Compact-summary jobs have chatId=null so they're skipped
  // automatically; non-opted-in chats still see the marker as plain
  // text but no Cloudflare call is made.
  let finalReply = reply;
  let imageUrl = null;
  const row0 = getChatJob(jobId);
  if (row0?.chatId) {
    const conv = getChatConversation(row0.chatId);
    if (conv?.imageGenEnabled) {
      const rendered = await maybeRenderImageW(reply, { model: conv.imageGenModel || undefined });
      if (rendered) {
        finalReply = rendered.cleanedContent;
        imageUrl   = rendered.imageUrl;
      }
    }
  }

  const row = updateChatJob(jobId, {
    status: 'completed',
    reply: finalReply,
    elapsedMs: typeof elapsedMs === 'number' ? elapsedMs : null,
    tokensIn: typeof tokensIn === 'number' ? tokensIn : null,
    tokensOut: typeof tokensOut === 'number' ? tokensOut : null,
    completedAt: new Date().toISOString(),
  });
  if (!row) return error(res, 'Chat job not found', 404);
  // If the job belongs to a conversation, append the assistant message
  // to chat_messages so the conversation thread updates in place.
  if (row.chatId) {
    try {
      appendChatMessage({
        chatId: row.chatId,
        role: 'assistant',
        content: finalReply,
        imageUrl,
        model: row.model,
        provider: row.provider || null,
        tokensIn: typeof tokensIn === 'number' ? tokensIn : null,
        tokensOut: typeof tokensOut === 'number' ? tokensOut : null,
        elapsedMs: typeof elapsedMs === 'number' ? elapsedMs : null,
        jobId,
      });
    } catch (e) {
      logger.warn(`Chat ${jobId}: assistant append failed: ${e.message}`);
    }
  }
  logger.info(`Chat ${jobId} done in ${elapsedMs ?? '?'}ms · ${finalReply.length} chars${imageUrl ? ' | +image' : ''}`);
  return success(res, row);
};

export const postChatFailed = (req, res) => {
  if (!checkAuth(req)) return error(res, 'Invalid worker token', 401);
  const { jobId, error: errMsg } = req.body || {};
  if (!jobId) return error(res, 'jobId required', 400);
  const row = updateChatJob(jobId, {
    status: 'failed', error: String(errMsg || 'unknown').slice(0, 800),
    completedAt: new Date().toISOString(),
  });
  if (!row) return error(res, 'Chat job not found', 404);
  logger.warn(`Chat ${jobId} failed: ${errMsg}`);
  return success(res, row);
};

// ─── Mesh generation (text→3D on 5090) ─────────────────────────
// Same shape as the chat callbacks. Worker GETs the full mesh_jobs row
// when it pulls from QUEUE_MESH (which only carries the jobId), then
// streams progress + final GLB URL back.
import { getMeshJob, updateMeshJob } from '../../services/aiVideo/meshStore.js';

export const postMeshJob = (req, res) => {
  // Lets the worker pull the full mesh_jobs row (prompt + model + steps) —
  // the queue trigger only carries the jobId.
  if (!checkAuth(req)) return error(res, 'Invalid worker token', 401);
  const row = getMeshJob(req.params.jobId);
  if (!row) return error(res, 'Mesh job not found', 404);
  return success(res, row);
};

export const postMeshProgress = (req, res) => {
  if (!checkAuth(req)) return error(res, 'Invalid worker token', 401);
  const { jobId, message, step, total } = req.body || {};
  if (!jobId) return error(res, 'jobId required', 400);

  // Promote queued → processing on the first progress ping so the FE
  // poller sees the status transition.
  const existing = getMeshJob(jobId);
  if (!existing) return error(res, 'Mesh job not found', 404);
  if (existing.status === 'queued') {
    updateMeshJob(jobId, {
      status: 'processing',
      startedAt: new Date().toISOString(),
    });
  }

  // Build a human-readable log line: prefer message, fall back to step/total.
  let logLine = '';
  if (typeof message === 'string' && message.trim()) {
    logLine = message.trim();
  } else if (typeof step === 'number' && typeof total === 'number') {
    logLine = `step ${step}/${total}`;
  }
  if (logLine) {
    appendJobLog(jobId, 'mesh', logLine);
    // Also expose the latest line on the row for cheap status reads.
    updateMeshJob(jobId, { progressMessage: logLine.slice(0, 200) });
  }
  return success(res, { ok: true });
};

export const postMeshComplete = (req, res) => {
  if (!checkAuth(req)) return error(res, 'Invalid worker token', 401);
  const { jobId, glbUrl, publicId, bytes, elapsedMs } = req.body || {};
  if (!jobId || !glbUrl) return error(res, 'jobId + glbUrl required', 400);
  const row = updateMeshJob(jobId, {
    status: 'completed',
    glbUrl,
    publicId: publicId || null,
    bytes: typeof bytes === 'number' ? bytes : null,
    elapsedMs: typeof elapsedMs === 'number' ? elapsedMs : null,
    completedAt: new Date().toISOString(),
  });
  if (!row) return error(res, 'Mesh job not found', 404);
  logger.info(`Mesh ${jobId} completed in ${elapsedMs ?? '?'}ms → ${glbUrl}`);
  return success(res, row);
};

export const postMeshFailed = (req, res) => {
  if (!checkAuth(req)) return error(res, 'Invalid worker token', 401);
  const { jobId, error: errMsg } = req.body || {};
  if (!jobId) return error(res, 'jobId required', 400);
  const row = updateMeshJob(jobId, {
    status: 'failed',
    error: String(errMsg || 'unknown').slice(0, 800),
    completedAt: new Date().toISOString(),
  });
  if (!row) return error(res, 'Mesh job not found', 404);
  logger.warn(`Mesh ${jobId} failed: ${errMsg}`);
  return success(res, row);
};

// ─── Deepfake worker callbacks (Vault-gated lane) ──────────────────
// Same shape as mesh. Worker pulls deepfake_jobs row when triggered, then
// streams progress + final outputUrl back. Vault gating happens at the
// USER-facing routes (/api/deepfake/*) — these worker-facing routes are
// authed by the shared worker token, same as the other gpu-worker/*.
import { getDeepfakeJob, updateDeepfakeJob } from '../../services/aiVideo/deepfakeStore.js';

export const postDeepfakeJob = (req, res) => {
  if (!checkAuth(req)) return error(res, 'Invalid worker token', 401);
  const row = getDeepfakeJob(req.params.jobId);
  if (!row) return error(res, 'Deepfake job not found', 404);
  return success(res, row);
};

export const postDeepfakeProgress = (req, res) => {
  if (!checkAuth(req)) return error(res, 'Invalid worker token', 401);
  const { jobId, message, step, total } = req.body || {};
  if (!jobId) return error(res, 'jobId required', 400);
  const existing = getDeepfakeJob(jobId);
  if (!existing) return error(res, 'Deepfake job not found', 404);
  if (existing.status === 'queued') {
    updateDeepfakeJob(jobId, { status: 'processing', startedAt: new Date().toISOString() });
  }
  let logLine = '';
  if (typeof message === 'string' && message.trim()) logLine = message.trim();
  else if (typeof step === 'number' && typeof total === 'number') logLine = `step ${step}/${total}`;
  if (logLine) {
    appendJobLog(jobId, 'deepfake', logLine);
    updateDeepfakeJob(jobId, { progressMessage: logLine.slice(0, 200) });
  }
  return success(res, { ok: true });
};

export const postDeepfakeComplete = (req, res) => {
  if (!checkAuth(req)) return error(res, 'Invalid worker token', 401);
  const { jobId, outputUrl, publicId, bytes, elapsedMs, analysis } = req.body || {};
  if (!jobId || !outputUrl) return error(res, 'jobId + outputUrl required', 400);
  const patch = {
    status: 'completed',
    outputUrl,
    publicId: publicId || null,
    bytes: typeof bytes === 'number' ? bytes : null,
    elapsedMs: typeof elapsedMs === 'number' ? elapsedMs : null,
    completedAt: new Date().toISOString(),
  };
  if (typeof analysis === 'string') patch.analysis = analysis;
  else if (analysis && typeof analysis === 'object') patch.analysis = JSON.stringify(analysis);
  const row = updateDeepfakeJob(jobId, patch);
  if (!row) return error(res, 'Deepfake job not found', 404);
  logger.info(`Deepfake ${jobId} completed in ${elapsedMs ?? '?'}ms → ${outputUrl}`);
  return success(res, row);
};

export const postDeepfakeFailed = (req, res) => {
  if (!checkAuth(req)) return error(res, 'Invalid worker token', 401);
  const { jobId, error: errMsg } = req.body || {};
  if (!jobId) return error(res, 'jobId required', 400);
  const row = updateDeepfakeJob(jobId, {
    status: 'failed',
    error: String(errMsg || 'unknown').slice(0, 800),
    completedAt: new Date().toISOString(),
  });
  if (!row) return error(res, 'Deepfake job not found', 404);
  logger.warn(`Deepfake ${jobId} failed: ${errMsg}`);
  return success(res, row);
};

