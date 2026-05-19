// Controllers for the Tier 3 lanes: Lip Sync, Audio Studio, Cinema mode.
// Pattern mirrors the image-enhance lane: BE creates a job row in SQLite,
// publishes a trigger to the appropriate RabbitMQ queue, returns the jobId.
// FE polls /status until completed/failed. Worker does the heavy lifting.

import { success, error } from '../../helpers/res_helper.js';
import logger from '../../helpers/logger.js';
import {
  createLipsyncJob, getLipsyncJob, listLipsyncJobs, updateLipsyncJob, deleteLipsyncJob,
  getLipsyncJobsByIds, deleteLipsyncJobs,
} from '../../services/aiVideo/lipsyncStore.js';
import {
  createAudioJob, getAudioJob, listAudioJobs, updateAudioJob, deleteAudioJob,
  getAudioJobsByIds, deleteAudioJobs,
} from '../../services/aiVideo/audioStore.js';
import {
  createCinemaProject, getCinemaProject, listCinemaProjects, updateCinemaProject, deleteCinemaProject,
  getCinemaProjectsByIds, deleteCinemaProjects,
} from '../../services/aiVideo/cinemaStore.js';
import {
  isCloudinaryConfigured,
  uploadSourceImage as cdnUploadImage,
  uploadAudioDataUrl as cdnUploadAudio,
  deleteImageByUrl as cdnDeleteImage,
} from '../../services/aiVideo/cloudinaryStore.js';
import { publishLipsyncJob, publishAudioJob } from '../../services/aiVideo/messageQueue.js';
import { chatGroq } from '../../services/groq.js';
import { listRecentLogs } from '../../services/aiVideo/logStore.js';

// ─── Lip Sync ─────────────────────────────────────────────────────
// POST /api/lipsync { audioDataUrl | audioUrl, portraitDataUrl | portraitUrl, model? }
// Returns { jobId, status } — FE polls /api/lipsync/status/:jobId for completion.
export const postLipsync = async (req, res) => {
  try {
    const { audioDataUrl, audioUrl, portraitDataUrl, portraitUrl, model = 'latentsync' } = req.body || {};
    if (!audioDataUrl && !audioUrl) return error(res, 'audioDataUrl or audioUrl is required', 400);
    if (!portraitDataUrl && !portraitUrl) return error(res, 'portraitDataUrl or portraitUrl is required', 400);
    if (!isCloudinaryConfigured()) return error(res, 'Cloudinary not configured', 503);

    // Upload audio + portrait to Cloudinary so the worker can fetch them.
    // (Worker doesn't have direct access to FE's blob — it fetches via HTTPS.)
    //
    // Audio goes through uploadAudioDataUrl (resource_type=video, no `format:`
    // param — Cloudinary stores the original mp3/wav/m4a as-is).
    // Portrait goes through uploadSourceImage (image bucket).
    // The previous version routed audio through uploadSourceImage too, which
    // hardcodes format=jpg → transcode mp3→jpg → "unknown format: mpa".
    let resolvedAudio = audioUrl, resolvedPortrait = portraitUrl;
    if (audioDataUrl) {
      const up = await cdnUploadAudio(audioDataUrl);
      resolvedAudio = up.url;
    }
    if (portraitDataUrl) {
      const up = await cdnUploadImage(portraitDataUrl);
      resolvedPortrait = up.url;
    }

    // Lip Sync isn't NSFW-gated — these aren't private; the FE just shows
    // them in the lane's own library. vault defaults to 0.
    const job = createLipsyncJob({
      audioUrl: resolvedAudio,
      portraitUrl: resolvedPortrait,
      model,
    });

    publishLipsyncJob({ jobId: job.jobId, model }).catch(e =>
      logger.warn(`Lipsync publish skipped: ${e.message}`));

    logger.info(`LIPSYNC QUEUE | ${job.jobId} | model=${model}`);
    return success(res, { jobId: job.jobId, status: job.status, model });
  } catch (err) {
    logger.error('Lipsync submit failed', err.message);
    return error(res, err.message);
  }
};

export const getLipsyncStatus = (req, res) => {
  const row = getLipsyncJob(req.params.jobId);
  if (!row) return error(res, 'Not found', 404);
  let logs = listRecentLogs(row.jobId, 'lipsync');
  if (logs.length === 0 && row.logs) {
    try { const p = JSON.parse(row.logs); if (Array.isArray(p)) logs = p; } catch {}
  }
  return success(res, { ...row, logs });
};

// No vault filter — lipsync isn't a gated lane. Anyone can see anyone's
// generations (this is your personal box; no multi-tenant separation needed).
export const getLipsyncList = (req, res) => {
  const status = req.query.status || undefined;
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 24, 1), 100);
  const result = listLipsyncJobs({
    status: status === 'all' ? undefined : status,
    page, limit,
  });
  return success(res, result);
};

// ─── Bulk delete (Lip Sync) ───────────────────────────────────────
export const postLipsyncBulkAction = async (req, res) => {
  try {
    const { action, ids } = req.body || {};
    if (action !== 'delete') return error(res, "action must be 'delete'", 400);
    if (!Array.isArray(ids) || ids.length === 0) return error(res, 'ids array is required', 400);
    if (ids.length > 100) return error(res, 'max 100 ids per call', 400);
    const rows = getLipsyncJobsByIds(ids);
    const removed = deleteLipsyncJobs(ids);
    // Cloudinary cleanup — three URLs per row (audio source + portrait + output)
    Promise.all(
      rows.flatMap(r => [r.audioUrl, r.portraitUrl, r.outputUrl].filter(Boolean).map(u => cdnDeleteImage(u)))
    ).catch(e => logger.warn(`Cloudinary lipsync bulk cleanup partial: ${e.message}`));
    logger.info(`LIPSYNC BULK delete | ${removed}/${ids.length} rows`);
    return success(res, { ok: true, action, affected: removed });
  } catch (err) {
    logger.error('Lipsync bulk action failed', err.message);
    return error(res, err.message);
  }
};

export const deleteLipsync = async (req, res) => {
  const row = getLipsyncJob(req.params.jobId);
  if (!row) return error(res, 'Not found', 404);
  deleteLipsyncJob(req.params.jobId);
  Promise.all([
    row.audioUrl ? cdnDeleteImage(row.audioUrl) : null,
    row.portraitUrl ? cdnDeleteImage(row.portraitUrl) : null,
    row.outputUrl ? cdnDeleteImage(row.outputUrl) : null,
  ]).catch(e => logger.warn(`Cloudinary lipsync cleanup partial: ${e.message}`));
  return success(res, { ok: true });
};

// ─── Audio Studio ─────────────────────────────────────────────────
// POST /api/audio
//   { kind: 'music'|'sfx'|'tts', model, prompt, duration?, voice? }
//   { kind: 'stt', model: 'whisper-local', audioDataUrl, language? }   ← 5090 path
//
// STT-on-5090 path: caller sends the audio dataUrl, BE uploads it to
// Cloudinary, queues a job. The worker pulls whisper-large-v3 weights
// the first time, then transcribes locally and posts back the text via
// /api/gpu-worker/audio-complete with a `transcript` field.
export const postAudio = async (req, res) => {
  try {
    const { kind = 'music', model, prompt, duration = 10, voice, audioDataUrl, language } = req.body || {};
    if (!['music', 'sfx', 'tts', 'stt'].includes(kind)) {
      return error(res, "kind must be 'music' | 'sfx' | 'tts' | 'stt'", 400);
    }

    // STT branch — audio in, text out. Skips the prompt/duration validation
    // path (those don't apply) and uploads the audio so the worker can fetch.
    if (kind === 'stt') {
      if (!audioDataUrl) return error(res, 'audioDataUrl is required for kind=stt', 400);
      let uploadedUrl = null;
      try {
        const up = await cdnUploadAudio(audioDataUrl);
        uploadedUrl = up.url;
      } catch (e) {
        return error(res, `Could not upload audio: ${e.message}`, 502);
      }
      const sttModel = model || 'whisper-large-v3';
      const job = createAudioJob({
        kind: 'stt',
        model: sttModel,
        prompt: language || '',                  // reuse `prompt` column as language hint
        duration: 0,
        voice: null,
      });
      // Persist the source URL so the worker can download the audio bytes.
      updateAudioJob(job.jobId, { sourceUrl: uploadedUrl });
      publishAudioJob({ jobId: job.jobId, kind: 'stt', model: sttModel }).catch(e =>
        logger.warn(`Audio publish skipped: ${e.message}`));

      logger.info(`STT QUEUE | ${job.jobId} | model=${sttModel}`);
      return success(res, { jobId: job.jobId, status: job.status, kind: 'stt', model: sttModel });
    }

    // Original music / sfx / tts path
    if (!prompt || prompt.trim().length < 2) return error(res, 'prompt is required', 400);
    if (duration < 1 || duration > 60) return error(res, 'duration must be 1-60 seconds', 400);

    // Default model per kind
    const defaultModel = kind === 'tts' ? 'bark' : kind === 'sfx' ? 'stable-audio' : 'musicgen';
    const resolvedModel = model || defaultModel;

    const job = createAudioJob({
      kind, model: resolvedModel, prompt: prompt.trim(),
      duration: Math.round(duration), voice: voice || null,
    });

    publishAudioJob({ jobId: job.jobId, kind, model: resolvedModel }).catch(e =>
      logger.warn(`Audio publish skipped: ${e.message}`));

    logger.info(`AUDIO QUEUE | ${job.jobId} | kind=${kind} model=${resolvedModel}`);
    return success(res, { jobId: job.jobId, status: job.status, kind, model: resolvedModel });
  } catch (err) {
    logger.error('Audio submit failed', err.message);
    return error(res, err.message);
  }
};

export const getAudioStatus = (req, res) => {
  const row = getAudioJob(req.params.jobId);
  if (!row) return error(res, 'Not found', 404);
  let logs = listRecentLogs(row.jobId, 'audio');
  if (logs.length === 0 && row.logs) {
    try { const p = JSON.parse(row.logs); if (Array.isArray(p)) logs = p; } catch {}
  }
  return success(res, { ...row, logs });
};

export const getAudioList = (req, res) => {
  const status = req.query.status || undefined;
  const kind = req.query.kind || undefined;
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 24, 1), 100);
  const result = listAudioJobs({
    status: status === 'all' ? undefined : status,
    kind, page, limit,
  });
  return success(res, result);
};

// ─── Bulk delete (Audio Studio) ───────────────────────────────────
export const postAudioBulkAction = async (req, res) => {
  try {
    const { action, ids } = req.body || {};
    if (action !== 'delete') return error(res, "action must be 'delete'", 400);
    if (!Array.isArray(ids) || ids.length === 0) return error(res, 'ids array is required', 400);
    if (ids.length > 100) return error(res, 'max 100 ids per call', 400);
    const rows = getAudioJobsByIds(ids);
    const removed = deleteAudioJobs(ids);
    Promise.all(
      rows.flatMap(r => [r.outputUrl].filter(Boolean).map(u => cdnDeleteImage(u)))
    ).catch(e => logger.warn(`Cloudinary audio bulk cleanup partial: ${e.message}`));
    logger.info(`AUDIO BULK delete | ${removed}/${ids.length} rows`);
    return success(res, { ok: true, action, affected: removed });
  } catch (err) {
    logger.error('Audio bulk action failed', err.message);
    return error(res, err.message);
  }
};

export const deleteAudio = async (req, res) => {
  const row = getAudioJob(req.params.jobId);
  if (!row) return error(res, 'Not found', 404);
  deleteAudioJob(req.params.jobId);
  if (row.outputUrl) cdnDeleteImage(row.outputUrl).catch(() => {});
  return success(res, { ok: true });
};

// ─── Cinema mode ──────────────────────────────────────────────────
// POST /api/cinema { masterPrompt, shotCount?, durationPerShot?, aspectRatio?, resolution? }
//
// Phase 1 (planning): Groq splits the master prompt into N shot prompts.
//   Returns immediately with status='planning' and projectId.
// Phase 2 (rendering): each shot is sent to the existing video pipeline.
//   This part is orchestrated by a separate worker / cron — see notes in
//   the doc. For now, the FE polls /status to watch the shotJobIds populate.
export const postCinema = async (req, res) => {
  try {
    const {
      masterPrompt, shotCount = 4,
      durationPerShot = 5, aspectRatio = '16:9', resolution = '720p',
    } = req.body || {};
    if (!masterPrompt || masterPrompt.trim().length < 5) {
      return error(res, 'masterPrompt is required (min 5 chars)', 400);
    }
    if (shotCount < 2 || shotCount > 12) {
      return error(res, 'shotCount must be 2-12', 400);
    }

    // Use Groq to split the master prompt into N shot prompts.
    const system = `You are a cinema director breaking down a one-line idea into ${shotCount} sequential shot prompts for AI video generation.

Output rules:
- EXACTLY ${shotCount} shot prompts, separated by newlines.
- Each line is ONE shot prompt (15-30 words, no bullets, no numbering).
- Shots should flow narratively from the master idea.
- Each prompt describes: subject, action, camera framing, lighting.
- Tone & subject continuity across shots — same person/place/style.
- Just output the prompts. No preamble, no explanation, no quotes.`;

    let shotPrompts = [];
    try {
      const groqRes = await chatGroq(masterPrompt.trim(), [], 'llama-3.3-70b', {
        system, temperature: 0.7, maxTokens: 800,
      });
      const raw = (groqRes.reply || '').trim();
      shotPrompts = raw.split('\n').map(s => s.trim()).filter(Boolean).slice(0, shotCount);
      if (shotPrompts.length < shotCount) {
        // Pad with copies of the master prompt if Groq under-delivered
        while (shotPrompts.length < shotCount) shotPrompts.push(masterPrompt.trim());
      }
    } catch (e) {
      logger.warn(`Cinema Groq split failed, falling back to master prompt: ${e.message}`);
      shotPrompts = Array(shotCount).fill(masterPrompt.trim());
    }

    const project = createCinemaProject({
      status: 'planning',
      masterPrompt: masterPrompt.trim(),
      shotCount,
      shotPrompts,
      durationPerShot: Math.round(durationPerShot),
      aspectRatio, resolution,
    });

    logger.info(`CINEMA CREATE | ${project.projectId} | shots=${shotCount}`);
    // NOTE: actual shot-by-shot rendering is left to a separate orchestrator
    // (or the FE can drive it via /api/ai-video/generate per shot). For now
    // we return the planned shotPrompts so the FE can show them.
    return success(res, { ...project, shotPrompts });
  } catch (err) {
    logger.error('Cinema create failed', err.message);
    return error(res, err.message);
  }
};

export const getCinemaStatus = (req, res) => {
  const row = getCinemaProject(req.params.projectId);
  if (!row) return error(res, 'Not found', 404);
  return success(res, row);
};

export const getCinemaList = (req, res) => {
  const status = req.query.status || undefined;
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 24, 1), 100);
  const result = listCinemaProjects({
    status: status === 'all' ? undefined : status,
    page, limit,
  });
  return success(res, result);
};

// ─── Bulk delete (Cinema) ─────────────────────────────────────────
export const postCinemaBulkAction = async (req, res) => {
  try {
    const { action, ids } = req.body || {};
    if (action !== 'delete') return error(res, "action must be 'delete'", 400);
    if (!Array.isArray(ids) || ids.length === 0) return error(res, 'ids array is required', 400);
    if (ids.length > 100) return error(res, 'max 100 ids per call', 400);
    const rows = getCinemaProjectsByIds(ids);
    const removed = deleteCinemaProjects(ids);
    Promise.all(
      rows.flatMap(r => [r.outputUrl].filter(Boolean).map(u => cdnDeleteImage(u)))
    ).catch(e => logger.warn(`Cloudinary cinema bulk cleanup partial: ${e.message}`));
    logger.info(`CINEMA BULK delete | ${removed}/${ids.length} rows`);
    return success(res, { ok: true, action, affected: removed });
  } catch (err) {
    logger.error('Cinema bulk action failed', err.message);
    return error(res, err.message);
  }
};

export const deleteCinema = async (req, res) => {
  const row = getCinemaProject(req.params.projectId);
  if (!row) return error(res, 'Not found', 404);
  deleteCinemaProject(req.params.projectId);
  if (row.outputUrl) cdnDeleteImage(row.outputUrl).catch(() => {});
  return success(res, { ok: true });
};

// Patch endpoint for the FE to attach the rendered child video IDs after it
// generates each shot. Updates shotJobIds[] and flips status as appropriate.
export const patchCinemaShots = (req, res) => {
  const row = getCinemaProject(req.params.projectId);
  if (!row) return error(res, 'Not found', 404);
  if (row.vault && !req.vault) return error(res, 'Not found', 404);
  const { shotJobIds, status, outputUrl, errorMsg } = req.body || {};
  const patch = {};
  if (Array.isArray(shotJobIds)) patch.shotJobIds = shotJobIds;
  if (status) patch.status = status;
  if (outputUrl) patch.outputUrl = outputUrl;
  if (errorMsg) patch.error = errorMsg;
  if (status === 'completed' || status === 'failed') patch.completedAt = new Date().toISOString();
  const updated = updateCinemaProject(req.params.projectId, patch);
  return success(res, updated);
};
