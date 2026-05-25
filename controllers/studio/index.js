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
    const {
      kind = 'music',
      model, prompt, duration = 10, voice,
      audioDataUrl, language, withLyrics,
      // Voice-clone fields (kind = 'voice-clone' | 'voice-sing').
      // referenceAudioDataUrl: 6-30s clean speech clip of the target voice
      // (data: URL). prompt holds the text/lyrics to speak/sing in that voice.
      // melodyAudioDataUrl: optional sung/hummed reference for voice-sing — if
      // provided, RVC rides this melody; otherwise XTTS produces flat speech.
      // vcLanguage: XTTS phoneme-set hint (ISO short code: en/hi/es/…). Reuses
      // the `voice` column for storage — JSON {language, melodyUrl?} packed in.
      referenceAudioDataUrl, melodyAudioDataUrl, vcLanguage,
    } = req.body || {};
    if (!['music', 'sfx', 'tts', 'stt', 'separate', 'voice-clone', 'voice-sing'].includes(kind)) {
      return error(res, "kind must be 'music' | 'sfx' | 'tts' | 'stt' | 'separate' | 'voice-clone' | 'voice-sing'", 400);
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

    // Source-separation branch — drop a song, get back 4 stems (vocals,
    // drums, bass, other) + optional Whisper lyrics on the vocals stem.
    // Worker runs Demucs (htdemucs) on the 5090; upload each stem to
    // Cloudinary; stash the URL map in audio_jobs.stems.
    if (kind === 'separate') {
      if (!audioDataUrl) return error(res, 'audioDataUrl is required for kind=separate', 400);
      let uploadedUrl = null;
      try {
        const up = await cdnUploadAudio(audioDataUrl);
        uploadedUrl = up.url;
      } catch (e) {
        return error(res, `Could not upload audio: ${e.message}`, 502);
      }
      const sepModel = model || 'htdemucs';
      // Reuse `voice` column as the withLyrics boolean flag — tiny hack
      // that avoids a schema change for one optional flag.
      const lyricsFlag = withLyrics === true || withLyrics === 1 || withLyrics === '1';
      const job = createAudioJob({
        kind: 'separate',
        model: sepModel,
        prompt: '',
        duration: 0,
        voice: lyricsFlag ? 'with-lyrics' : null,
      });
      updateAudioJob(job.jobId, { sourceUrl: uploadedUrl });
      publishAudioJob({ jobId: job.jobId, kind: 'separate', model: sepModel }).catch(e =>
        logger.warn(`Audio publish skipped: ${e.message}`));

      logger.info(`SEPARATE QUEUE | ${job.jobId} | model=${sepModel} | lyrics=${lyricsFlag}`);
      return success(res, { jobId: job.jobId, status: job.status, kind: 'separate', model: sepModel });
    }

    // ── Voice-clone branches ─────────────────────────────────────
    //   voice-clone — XTTS-v2: ref clip + text → speech in that voice
    //   voice-sing  — XTTS-v2 (+ optional RVC melody) → singing
    // Same shape: upload the reference clip, stash URL in sourceUrl, lyrics
    // go in `prompt`. For voice-sing, an optional melody clip rides along —
    // we upload that too and stash its URL in `voice` (repurposed column).
    if (kind === 'voice-clone' || kind === 'voice-sing') {
      if (!referenceAudioDataUrl) {
        return error(res, 'referenceAudioDataUrl is required (6-30s clean clip of target voice)', 400);
      }
      const lyrics = String(prompt || '').trim();
      if (lyrics.length < 2)    return error(res, 'prompt (text/lyrics) is required', 400);
      if (lyrics.length > 2000) return error(res, 'prompt too long (max 2000 chars)', 400);

      if (!isCloudinaryConfigured()) return error(res, 'Cloudinary not configured', 503);

      let refUrl = null, melodyUrl = null;
      try {
        const up = await cdnUploadAudio(referenceAudioDataUrl);
        refUrl = up.url;
      } catch (e) {
        return error(res, `Could not upload reference clip: ${e.message}`, 502);
      }
      if (kind === 'voice-sing' && melodyAudioDataUrl) {
        try {
          const up = await cdnUploadAudio(melodyAudioDataUrl);
          melodyUrl = up.url;
        } catch (e) {
          // Non-fatal — worker will fall back to flat-speech if melody missing.
          logger.warn(`Melody upload failed (non-fatal): ${e.message}`);
        }
      }

      const vcModel = model || (kind === 'voice-clone' ? 'xtts-v2' : 'xtts-v2+rvc');
      // Pack language + melodyUrl into a single JSON string in the `voice`
      // column. The worker JSON.loads this back at dispatch time. Default
      // language is 'en' to match XTTS-v2's primary training set.
      const voiceMeta = JSON.stringify({
        language: typeof vcLanguage === 'string' && vcLanguage ? vcLanguage : 'en',
        ...(melodyUrl ? { melodyUrl } : {}),
      });
      const job = createAudioJob({
        kind,
        model: vcModel,
        prompt: lyrics,
        duration: 0,
        voice: voiceMeta,
      });
      updateAudioJob(job.jobId, { sourceUrl: refUrl });
      publishAudioJob({ jobId: job.jobId, kind, model: vcModel }).catch(e =>
        logger.warn(`Audio publish skipped: ${e.message}`));

      logger.info(`VOICE QUEUE | ${job.jobId} | kind=${kind} | model=${vcModel} | len=${lyrics.length}`);
      return success(res, { jobId: job.jobId, status: job.status, kind, model: vcModel });
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
  // Source-separation rows store stems as JSON string in SQLite — inflate
  // it for the FE so it can render the 4 stem URLs without a second parse.
  let stems = null;
  if (row.stems) {
    try { stems = JSON.parse(row.stems); } catch {}
  }
  return success(res, { ...row, logs, stems });
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

    // Duration-aware sizing band. The video models can only produce so
    // much motion per second of output — a 360° rotation or multi-beat
    // action ("then ... then ...") that's fine in a 7s clip turns into
    // smeared frame chaos when squeezed into 3s. The system prompt
    // hands Groq a budget so the per-shot prose actually fits.
    const safeDuration = Math.round(durationPerShot);
    const durationBand = safeDuration <= 3
      ? '12-20 words. ONE static or simple motion only. NO "then / next / after". NO 360° / multi-axis camera moves — they don\'t resolve in 3s.'
      : safeDuration <= 5
      ? '20-35 words. ONE clear action with an optional second beat. Mention lighting (golden hour, neon, etc.). Single-axis camera move okay (dolly, pan, push).'
      : '30-50 words. Can describe TWO connected actions (intro → payoff). Lighting + camera-move detail welcome (drone, crane, tracking shot).';

    // Use Groq to split the master prompt into N shot prompts.
    const system = `You are a cinema director breaking down a one-line idea into ${shotCount} sequential shot prompts for AI video generation. Each shot will be rendered as a ${safeDuration}-second clip on a single-model pipeline.

Output rules:
- EXACTLY ${shotCount} shot prompts, separated by newlines.
- Each line is ONE shot prompt sized for a ${safeDuration}s clip:
    ${durationBand}
- Shots should flow narratively from the master idea (act 1 → climax → resolution shape).
- Each prompt describes: subject, action, camera framing, lighting.
- Tone & subject continuity across shots — same person/place/style.
- NEVER use "then", "and then", "after that", "later" — video models render ONE continuous moment per clip, not a sequence.
- Just output the prompts. No preamble, no explanation, no quotes, no numbering.`;

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
  const { shotJobIds, shotPrompts, status, outputUrl, errorMsg } = req.body || {};
  const patch = {};
  if (Array.isArray(shotJobIds)) patch.shotJobIds = shotJobIds;
  // Editable shot prompts — the FE planner lets the user tune each
  // shot's prose before kicking off the render. We just trust the
  // array shape; per-shot length validation happens client-side.
  if (Array.isArray(shotPrompts)) {
    patch.shotPrompts = shotPrompts
      .map(s => typeof s === 'string' ? s.trim() : '')
      .filter(Boolean)
      .slice(0, row.shotCount);
  }
  if (status) patch.status = status;
  if (outputUrl) patch.outputUrl = outputUrl;
  if (errorMsg) patch.error = errorMsg;
  if (status === 'completed' || status === 'failed') patch.completedAt = new Date().toISOString();
  const updated = updateCinemaProject(req.params.projectId, patch);
  return success(res, updated);
};

// POST /api/cinema/:projectId/shots/:shotIndex/review
//   { currentPrompt?: string, engine?: 'groq' | 'gemini' }
//
// Asks the model to assess a per-shot prompt against the project's
// duration budget. Returns:
//   {
//     assessment: 'too_detailed' | 'good' | 'too_vague',
//     feedback: string,
//     suggested: string   // a rewritten prompt the user can apply with one click
//   }
//
// Groq (llama-3.3-70b) is the default — sub-second, free. Gemini is
// stub-wired here for parity once the user wants a second opinion; we
// pass through to the same chatGemini helper the rest of the BE uses.
export const postCinemaShotReview = async (req, res) => {
  try {
    const projectId = req.params.projectId;
    const shotIndex = parseInt(req.params.shotIndex, 10);
    const row = getCinemaProject(projectId);
    if (!row) return error(res, 'Cinema project not found', 404);
    if (row.vault && !req.vault) return error(res, 'Cinema project not found', 404);
    if (!Number.isFinite(shotIndex) || shotIndex < 0 || shotIndex >= row.shotCount) {
      return error(res, `shotIndex must be 0..${row.shotCount - 1}`, 400);
    }

    const { currentPrompt, engine = 'groq' } = req.body || {};
    const prompt = (typeof currentPrompt === 'string' && currentPrompt.trim())
      ? currentPrompt.trim()
      : (row.shotPrompts || [])[shotIndex] || '';
    if (!prompt) return error(res, 'No prompt to review', 400);

    const safeDuration = row.durationPerShot || 5;
    const reviewSystem = `You are a video-prompt critic. The user is about to render a ${safeDuration}-second AI video clip from this prompt. Your job: decide if the prompt fits the duration budget.

Budget guide:
- ≤3s clips → 12-20 words, ONE static or simple motion, NO multi-beat actions, NO 360°/multi-axis camera moves.
- 5s clips  → 20-35 words, ONE action + optional second beat, single-axis camera move okay.
- 7s+ clips → 30-50 words, can have TWO connected actions, lighting + camera detail welcome.

Words like "then", "and then", "after that", "later" are red flags — video models render ONE continuous moment per clip.

Output STRICT JSON only (no markdown, no code fences, no preamble):
{
  "assessment": "too_detailed" | "good" | "too_vague",
  "feedback":   "one short sentence explaining why, max 25 words",
  "suggested":  "a rewritten prompt that fits the budget, applying your feedback"
}`;

    let raw = '';
    if (engine === 'gemini') {
      // Lazy-import so we don't pull Gemini deps when Groq is the only path.
      const { chatGemini } = await import('../../services/ai/geminiService.js').catch(() => ({}));
      if (typeof chatGemini !== 'function') {
        return error(res, 'Gemini engine not configured on this BE', 503);
      }
      const result = await chatGemini(prompt, [], 'gemini-2.5-flash', { system: reviewSystem, temperature: 0.3 });
      raw = (result?.reply || '').trim();
    } else {
      const result = await chatGroq(prompt, [], 'llama-3.3-70b', {
        system: reviewSystem,
        temperature: 0.3,
        maxTokens: 400,
      });
      raw = (result?.reply || '').trim();
    }

    // Parse the strict JSON the model was asked for. Models sometimes
    // wrap in ```json fences anyway — strip them defensively.
    const stripped = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    let parsed = null;
    try { parsed = JSON.parse(stripped); } catch {}
    if (!parsed || typeof parsed !== 'object') {
      return success(res, {
        assessment: 'good',
        feedback: raw.slice(0, 200) || 'No structured feedback returned',
        suggested: prompt,
        engine,
      });
    }

    const out = {
      assessment: ['too_detailed', 'good', 'too_vague'].includes(parsed.assessment) ? parsed.assessment : 'good',
      feedback:   String(parsed.feedback || '').slice(0, 400),
      suggested:  String(parsed.suggested || prompt).slice(0, 600),
      engine,
    };
    logger.info(`CINEMA REVIEW | ${projectId} | shot ${shotIndex} | ${out.assessment} | engine=${engine}`);
    return success(res, out);
  } catch (err) {
    logger.error('Cinema shot review failed', err.message);
    return error(res, err.message);
  }
};

// ─── Cinema renders (per-attempt resumable state) ──────────────
// The FE drives the actual multi-shot chain client-side, but each
// render is registered here so a refresh / new tab / share-link can
// pick the live view back up. See services/aiVideo/cinemaRenderStore.js
// for the shape contract. Vault inherits from the parent project.

import {
  createCinemaRender, getCinemaRender, updateCinemaRender,
  deleteCinemaRender, listCinemaRenders,
} from '../../services/aiVideo/cinemaRenderStore.js';
import { notifyCinemaChainOfCompletion } from '../../services/aiVideo/cinemaChain.js';
import { db } from '../../services/aiVideo/db.js';
import {
  tagJobsToRender, listLogsByRender,
} from '../../services/aiVideo/logStore.js';

// POST /api/cinema/:projectId/render
// Creates a render row tied to the project. Returns { renderId } so the
// FE can navigate to /cinema/render/<renderId>. No actual generation
// kicks off here — the FE orchestrator handles that.
export const postCinemaRender = (req, res) => {
  try {
    const project = getCinemaProject(req.params.projectId);
    if (!project) return error(res, 'Cinema project not found', 404);
    if (project.vault && !req.vault) return error(res, 'Cinema project not found', 404);
    if (!Array.isArray(project.shotPrompts) || project.shotPrompts.length === 0) {
      return error(res, 'Project has no planned shots — plan first', 400);
    }
    const { provider, optimizedMode } = req.body || {};
    const row = createCinemaRender({
      projectId: project.projectId,
      shotCount: project.shotPrompts.length,
      vault: project.vault ? 1 : 0,
      provider,
      optimizedMode,
    });
    logger.info(`CINEMA RENDER NEW | ${row.renderId} | project=${project.projectId} | shots=${row.shotCount}`);
    return success(res, row);
  } catch (err) {
    logger.error('Cinema render create failed', err.message);
    return error(res, err.message);
  }
};

// GET /api/cinema/render/:renderId
// Returns the render row + the parent project (so the page has
// shotPrompts + duration + aspect/resolution without a second call).
// Vault rows return 404 to anonymous viewers.
export const getCinemaRenderStatus = (req, res) => {
  const row = getCinemaRender(req.params.renderId);
  if (!row) return error(res, 'Cinema render not found', 404);
  if (row.vault && !req.vault) return error(res, 'Cinema render not found', 404);
  // Re-tag the in-memory jobId→renderId cache on every status read.
  // Cheap (just a Map set per shot) and keeps the cache warm after
  // process restarts so worker logs land with the right cinemaRenderId.
  tagJobsToRender(row.renderId, [
    ...(row.shotJobIds || []).filter(Boolean),
    row.combineJobId != null ? String(row.combineJobId) : null,
  ].filter(Boolean));
  const project = getCinemaProject(row.projectId);
  return success(res, { ...row, project });
};

// GET /api/cinema/render/:renderId/logs?since=<ms>&limit=500
// Unified log stream for a whole cinema render. Every line written for
// any shot's video job + the combine step lands in job_logs.cinemaRenderId
// (either via the in-memory cache, or via explicit stamping by the
// orchestrator). This endpoint returns every line in chronological
// order, annotated with jobId + lane + shotIndex, so the FE can render
// one timeline instead of N per-shot accordions.
export const getCinemaRenderLogs = (req, res) => {
  const row = getCinemaRender(req.params.renderId);
  if (!row) return error(res, 'Cinema render not found', 404);
  if (row.vault && !req.vault) return error(res, 'Cinema render not found', 404);

  const since = parseInt(req.query.since, 10) || 0;
  const limit = parseInt(req.query.limit, 10) || 500;
  const raw = listLogsByRender({ renderId: row.renderId, sinceTs: since, limit });

  // Annotate each log line with which shot it belongs to (or -1 for
  // the combine step). Lookup table built once per request.
  const jobIdToShotIndex = new Map();
  (row.shotJobIds || []).forEach((jobId, idx) => {
    if (jobId) jobIdToShotIndex.set(jobId, idx);
  });
  const combineIdStr = row.combineJobId != null ? String(row.combineJobId) : null;

  const logs = raw.map(line => {
    const shotIndex = jobIdToShotIndex.has(line.jobId)
      ? jobIdToShotIndex.get(line.jobId)
      : (combineIdStr && line.jobId === combineIdStr ? -1 : null);
    return {
      ts: line.ts,
      msg: line.msg,
      jobId: line.jobId,
      lane: line.lane,
      shotIndex,                          // 0..N-1 for shots, -1 for combine, null if unknown
    };
  });

  const nextSince = logs.length ? logs[logs.length - 1].ts : since;
  return success(res, { logs, nextSince });
};

// PATCH /api/cinema/render/:renderId
// Called by the FE chain after each shot transition. Accepts:
//   { status, phase, currentShotIndex, shotJobIds, combineJobId,
//     finalDownloadHref, error }
// Auto-stamps completedAt when status flips to completed / failed /
// cancelled. shotJobIds is REPLACED whole (not merged) — the FE sends
// the current array each time.
export const patchCinemaRender = (req, res) => {
  const row = getCinemaRender(req.params.renderId);
  if (!row) return error(res, 'Cinema render not found', 404);
  if (row.vault && !req.vault) return error(res, 'Cinema render not found', 404);
  const {
    status, phase, currentShotIndex,
    shotJobIds, combineJobId, finalDownloadHref, error: errorMsg,
  } = req.body || {};
  const patch = {};
  if (status) patch.status = status;
  if (phase)  patch.phase  = phase;
  if (typeof currentShotIndex === 'number') patch.currentShotIndex = currentShotIndex;
  if (Array.isArray(shotJobIds))  patch.shotJobIds  = shotJobIds;
  if (combineJobId != null)       patch.combineJobId = combineJobId;
  if (finalDownloadHref)          patch.finalDownloadHref = finalDownloadHref;
  if (errorMsg)                   patch.error = String(errorMsg).slice(0, 800);
  const terminal = status && ['completed', 'failed', 'cancelled'].includes(status);
  if (terminal) patch.completedAt = new Date().toISOString();
  const updated = updateCinemaRender(req.params.renderId, patch);
  return success(res, updated);
};

// GET /api/cinema/renders?projectId=&status=&page=&pageSize=
// Paginated list of renders. Same contract every other library list uses.
export const getCinemaRendersList = (req, res) => {
  try {
    const projectId = typeof req.query.projectId === 'string' && req.query.projectId
      ? req.query.projectId : undefined;
    const status = typeof req.query.status === 'string' && req.query.status && req.query.status !== 'all'
      ? req.query.status : undefined;
    const page     = parseInt(req.query.page, 10)     || 1;
    const pageSize = parseInt(req.query.pageSize, 10) || parseInt(req.query.limit, 10) || 24;
    const vault    = req.vault ? 1 : 0;
    const result = listCinemaRenders({ projectId, status, page, pageSize, vault });
    return success(res, result);
  } catch (err) {
    logger.error('Cinema renders list failed', err.message);
    return error(res, err.message);
  }
};

// POST /api/cinema/render/:renderId/resume
// User clicked "Resume from shot N" after a failed / cancelled render.
// Re-uses the same chain machinery: figure out the LAST shot that has
// a completed videoId on the videos table, then call
// notifyCinemaChainOfCompletion on it. The orchestrator does the right
// thing — extracts that shot's last frame and queues the next shot, or
// triggers combine if every shot is already done.
//
// If NO shots are done yet, this endpoint short-circuits to a hint —
// the FE startRender path should submit shot 1 in that case, not /resume.
export const postCinemaRenderResume = async (req, res) => {
  const row = getCinemaRender(req.params.renderId);
  if (!row) return error(res, 'Cinema render not found', 404);
  if (row.vault && !req.vault) return error(res, 'Cinema render not found', 404);

  // Find the last index with a populated jobId whose video has a
  // completed entry in the videos table. That's where the BE chain
  // last "left off".
  const { getLocalVideo } = await import('../../services/aiVideo/videoStore.js');
  let lastCompletedIdx = -1;
  for (let idx = row.shotJobIds.length - 1; idx >= 0; idx -= 1) {
    const jobId = row.shotJobIds[idx];
    if (!jobId) continue;
    const video = getLocalVideo(jobId);
    if (video?.videoUrl) { lastCompletedIdx = idx; break; }
  }

  if (lastCompletedIdx === -1) {
    return error(res, 'No completed shots yet — call startRender (POST /api/ai-video/generate for shot 1) before /resume', 400);
  }

  // Clear the error state + flip to rendering so the FE poll sees
  // progress immediately. The orchestrator will overwrite phase as
  // it does its work.
  updateCinemaRender(row.renderId, { status: 'rendering', phase: 'rendering', error: null });
  notifyCinemaChainOfCompletion(row.shotJobIds[lastCompletedIdx]);
  return success(res, { ok: true, resumedFromShotIndex: lastCompletedIdx });
};

// GET /api/cinema/disk-stats
// Cinema-specific disk usage. Aggregates `combined_videos.fileSize` for
// every combine row that's owned by a cinema_render — the user wants
// to know "how much disk am I using just for Cinema, separately from
// ad-hoc Build-tab combines". Returns counts + bytes + a per-render
// breakdown so the FE library can highlight which rows contribute.
export const getCinemaDiskStats = (req, res) => {
  try {
    const totalsRow = db.prepare(`
      SELECT
        COUNT(*) AS count,
        COALESCE(SUM(cv.fileSize), 0) AS bytes
      FROM combined_videos cv
      WHERE cv.id IN (
        SELECT combineJobId FROM cinema_renders WHERE combineJobId IS NOT NULL
      )
      AND cv.outputPath IS NOT NULL
    `).get();

    const perRender = db.prepare(`
      SELECT cr.renderId, cr.projectId, cv.id AS combineId, cv.fileSize, cv.title, cv.createdAt
      FROM cinema_renders cr
      JOIN combined_videos cv ON cv.id = cr.combineJobId
      WHERE cr.vault = 0 OR @vault = 1
      ORDER BY cv.createdAt DESC
    `).all({ vault: req.vault ? 1 : 0 });

    return success(res, {
      total: { count: Number(totalsRow?.count || 0), bytes: Number(totalsRow?.bytes || 0) },
      perRender,
    });
  } catch (err) {
    logger.error('Cinema disk stats failed', err.message);
    return error(res, err.message);
  }
};

// DELETE /api/cinema/render/:renderId
export const deleteCinemaRenderCtrl = (req, res) => {
  const row = getCinemaRender(req.params.renderId);
  if (!row) return error(res, 'Cinema render not found', 404);
  if (row.vault && !req.vault) return error(res, 'Cinema render not found', 404);
  const ok = deleteCinemaRender(req.params.renderId);
  return success(res, { ok });
};
