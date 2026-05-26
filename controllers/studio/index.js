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

    // Cinematic Continuity Director planner (§69). Groq now emits a
    // bible + a STRUCTURED directorState + an action list. The director
    // module glues all three together at submit time per shot.
    const system = `You are a cinema director planning a CONTINUITY-LOCKED multi-shot sequence for AI video. ${shotCount} shots, ${safeDuration} seconds each, ONE model running ONE locked seed across all shots. The audience should feel one camera captured one continuous moment, not N independent clips.

Output STRICT JSON ONLY (no markdown, no code fences, no preamble):
{
  "bible": {
    "subject":     "main subject — name/age/body/identifying features",
    "wardrobe":    "exact outfit / costume / props",
    "environment": "place — terrain, weather, time of day, scale",
    "lighting":    "single short clause — direction + colour temperature",
    "camera":      "lens + grade + film stock vibe (one phrase)",
    "palette":     "3-5 colour words for the overall grade"
  },
  "directorState": {
    "physicalState": {
      "screenDirection":   "left_to_right | right_to_left | toward_camera | away_from_camera",
      "subjectMotion":     "what the subject is physically doing (e.g. 'walking forward slowly')",
      "windDirection":     "left_to_right | right_to_left | none",
      "snowDirection":     "left_to_right | right_to_left | none | not_applicable",
      "weatherIntensity":  "none | light | medium | heavy",
      "terrain":           "what the ground is",
      "timeOfDay":         "golden hour | blue hour | day | night | dawn | dusk"
    },
    "cameraState": {
      "lens":          "e.g. 35mm anamorphic",
      "height":        "eye level | low | high | subject-eye level",
      "movement":      "slow forward tracking | static | slow push-in | slow pull-back",
      "energy":        "calm | tense | documentary realism | epic",
      "stabilization": "slightly handheld with natural operator sway"
    },
    "emotionArc": {
      "start":  "the feeling shot 1 establishes",
      "middle": "what evolves by shot ${Math.ceil(shotCount / 2)}",
      "end":    "the feeling the last shot lands"
    },
    "negativeContinuityRules": [
      "do not change the subject design",
      "do not change the environment",
      "do not change time of day",
      "do not teleport subjects",
      "do not flip screen direction",
      "do not introduce new characters",
      "do not change camera style",
      "do not make it cartoonish",
      "avoid surreal morphing",
      "avoid sudden composition resets"
    ]
  },
  "actions": ["action 1", "action 2", ..., "action ${shotCount}"]
}

BIBLE rules:
- Each field MUST be a single string, ≤ 18 words.
- Bible is LOCKED — describe the world that exists for the WHOLE sequence.
- NEVER reference camera moves or events in the bible.

DIRECTORSTATE rules:
- physicalState locks how the WORLD moves (wind, snow, screen direction). It must remain identical from shot 1 to shot N.
- cameraState locks the CAMERA's identity + movement style. The chain enforces continuation per shot; you just describe the established style.
- emotionArc captures the feeling progression, not new world events.
- negativeContinuityRules: 8-12 short imperative sentences forbidding world resets.

ACTION rules — THIS IS WHERE FILMS DIE OR LIVE:
- EXACTLY ${shotCount} entries, ${durationBand}
- Each action describes ONLY what CHANGES in that single shot — a verb + a small camera adjustment.
- For shot 2 and later, the action MUST read as a CONTINUATION (e.g. "continues forward as the leader's nose lifts to the wind").
- NEVER re-describe subject appearance, environment, lighting, or palette. Bible carries those.
- NEVER introduce a "new" world element, new character, new place, new time of day.
- NEVER use "then", "and then", "after that", "later" — each clip is one continuous moment.
- Subjects must NOT teleport, reverse direction, or pose-reset between shots.
- Camera momentum must carry across shots (if shot 1 is forward tracking, shot 2 continues forward).
- Include 1 in 3 actions with imperfect framing (foreground occlusion, off-center subject, dead space).
- Narrative shape: setup → development → beat → resolution, compressed to ${shotCount} beats.

Example for a snowy wolf-pack sequence (4 shots):
{"bible":{"subject":"wolf pack of five, alpha at front, weather-beaten coats","wardrobe":"thick winter fur with frost crystals","environment":"narrow snowy mountain pass with cliffs either side, hidden valley ahead","lighting":"warm golden hour rim from the west","camera":"35mm anamorphic, soft halation, fine grain","palette":"amber, snow white, slate blue, charcoal"},"directorState":{"physicalState":{"screenDirection":"left_to_right","subjectMotion":"walking forward at a steady pace","windDirection":"left_to_right","snowDirection":"left_to_right","weatherIntensity":"medium","terrain":"snow-covered rocky mountain pass","timeOfDay":"golden hour"},"cameraState":{"lens":"35mm anamorphic","height":"wolf-eye level","movement":"slow forward tracking","energy":"calm tense documentary realism","stabilization":"slightly handheld with natural operator sway"},"emotionArc":{"start":"searching and alert","middle":"the leader senses something","end":"reveal and recognition"},"negativeContinuityRules":["do not change the wolf design","do not change the snowy pass","do not change golden hour","do not teleport wolves","do not reverse screen direction","do not add other animals","do not change camera style","do not make it cartoonish","avoid surreal morphing","avoid sudden framing resets"]},"actions":["wide shot, the pack continues left to right through the pass, slow forward tracking","medium shot, the alpha's nose lifts to the wind while still walking, foreground branch crosses lens","low-angle close on paws crunching fresh snow, camera continues forward at the same pace","over-shoulder reveal of the hidden valley below, slow tilt down without breaking the forward momentum"]}
`;

    let shotPrompts = [];
    let bible       = {};
    let directorState = {};
    try {
      const groqRes = await chatGroq(masterPrompt.trim(), [], 'llama-3.3-70b', {
        system, temperature: 0.55, maxTokens: 2000,
      });
      let raw = (groqRes.reply || '').trim();
      raw = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch {}
      if (parsed && Array.isArray(parsed.actions)) {
        shotPrompts = parsed.actions.map(s => String(s || '').trim()).filter(Boolean).slice(0, shotCount);
        if (parsed.bible && typeof parsed.bible === 'object') {
          const clamp = (s) => String(s || '').trim().split(/\s+/).slice(0, 25).join(' ');
          bible = {
            subject:     clamp(parsed.bible.subject),
            wardrobe:    clamp(parsed.bible.wardrobe),
            environment: clamp(parsed.bible.environment),
            lighting:    clamp(parsed.bible.lighting),
            camera:      clamp(parsed.bible.camera),
            palette:     clamp(parsed.bible.palette),
          };
        }
        if (parsed.directorState && typeof parsed.directorState === 'object') {
          // Whitelisted shape — accept only known keys so a hallucinated
          // sub-object can't sneak into the JSON column.
          const ds = parsed.directorState;
          directorState = {
            physicalState: ds.physicalState && typeof ds.physicalState === 'object' ? {
              screenDirection:  String(ds.physicalState.screenDirection || '').trim(),
              subjectMotion:    String(ds.physicalState.subjectMotion   || '').trim(),
              windDirection:    String(ds.physicalState.windDirection   || '').trim(),
              snowDirection:    String(ds.physicalState.snowDirection   || '').trim(),
              weatherIntensity: String(ds.physicalState.weatherIntensity|| '').trim(),
              terrain:          String(ds.physicalState.terrain         || '').trim(),
              timeOfDay:        String(ds.physicalState.timeOfDay       || '').trim(),
            } : {},
            cameraState: ds.cameraState && typeof ds.cameraState === 'object' ? {
              lens:          String(ds.cameraState.lens          || '').trim(),
              height:        String(ds.cameraState.height        || '').trim(),
              movement:      String(ds.cameraState.movement      || '').trim(),
              energy:        String(ds.cameraState.energy        || '').trim(),
              stabilization: String(ds.cameraState.stabilization || '').trim(),
            } : {},
            emotionArc: ds.emotionArc && typeof ds.emotionArc === 'object' ? {
              start:  String(ds.emotionArc.start  || '').trim(),
              middle: String(ds.emotionArc.middle || '').trim(),
              end:    String(ds.emotionArc.end    || '').trim(),
            } : {},
            negativeContinuityRules: Array.isArray(ds.negativeContinuityRules)
              ? ds.negativeContinuityRules
                  .filter(s => typeof s === 'string' && s.trim())
                  .map(s => s.trim().slice(0, 100))
                  .slice(0, 16)
              : [],
          };
        }
      } else {
        shotPrompts = raw.split('\n').map(s => s.trim()).filter(Boolean).slice(0, shotCount);
      }
      if (shotPrompts.length < shotCount) {
        while (shotPrompts.length < shotCount) shotPrompts.push(masterPrompt.trim());
      }
    } catch (e) {
      logger.warn(`Cinema Groq split failed, falling back to master prompt: ${e.message}`);
      shotPrompts = Array(shotCount).fill(masterPrompt.trim());
    }

    const lockedSeed = Math.floor(Math.random() * 1_000_000_000);

    const project = createCinemaProject({
      status: 'planning',
      masterPrompt: masterPrompt.trim(),
      shotCount,
      shotPrompts,
      durationPerShot: Math.round(durationPerShot),
      aspectRatio, resolution,
    });
    const updated = updateCinemaProject(project.projectId, {
      continuityBible: bible,
      directorState,
      lockedSeed,
      motionStrength: 0.5,           // safer default for continuity (was 0.6)
      continuityMode: true,
      realismMode:    true,
      overlapMode:    false,
    }) || project;

    logger.info(`CINEMA CREATE | ${project.projectId} | shots=${shotCount}`);
    // NOTE: actual shot-by-shot rendering is left to a separate orchestrator
    // (or the FE can drive it via /api/ai-video/generate per shot). For now
    // we return the planned shotPrompts so the FE can show them.
    return success(res, { ...updated, shotPrompts });
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
  const {
    shotJobIds, shotPrompts, shotModels, shotMusic,
    continuityBible, lockedSeed, motionStrength, heroImageUrl,
    directorState, continuityMode, overlapMode, realismMode,
    stepsPerShot,
    status, outputUrl, errorMsg,
  } = req.body || {};
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
  // Per-shot model selection (only meaningful when the chain runs on
  // the Beast lane — the optimized + zsky providers ignore it).
  if (Array.isArray(shotModels)) {
    patch.shotModels = shotModels
      .map(m => (typeof m === 'string' ? m.trim() : ''))
      .slice(0, row.shotCount);
  }
  // Per-shot background-music toggle. Stored as 0/1 in SQLite; FE
  // sees booleans courtesy of the deserialize() helper.
  if (Array.isArray(shotMusic)) {
    patch.shotMusic = shotMusic.map(v => !!v).slice(0, row.shotCount);
  }
  // Continuity-bible JSON object. Whitelist the 6 known string fields
  // + clamp each to 25 words so an over-eager edit can't poison the
  // prompt that gets glued to every shot.
  if (continuityBible && typeof continuityBible === 'object' && !Array.isArray(continuityBible)) {
    const ALLOWED_BIBLE_KEYS = ['subject', 'wardrobe', 'environment', 'lighting', 'camera', 'palette'];
    const clamp = (s) => String(s || '').trim().split(/\s+/).slice(0, 25).join(' ');
    const cleaned = {};
    for (const k of ALLOWED_BIBLE_KEYS) {
      if (typeof continuityBible[k] === 'string') cleaned[k] = clamp(continuityBible[k]);
    }
    patch.continuityBible = cleaned;
  }
  // Locked seed — integer, 0..2^31-1 (SQLite INTEGER fits comfortably).
  if (lockedSeed !== undefined && lockedSeed !== null) {
    const n = parseInt(lockedSeed, 10);
    if (Number.isFinite(n) && n >= 0 && n <= 2_147_483_647) patch.lockedSeed = n;
  }
  // Motion strength clamp 0.1..1.0 (lower disables motion entirely
  // on some models; higher mutates the subject).
  if (motionStrength !== undefined && motionStrength !== null) {
    const v = Number(motionStrength);
    if (Number.isFinite(v)) patch.motionStrength = Math.max(0.1, Math.min(1.0, v));
  }
  // Hero image URL — string only. Empty string clears it.
  if (typeof heroImageUrl === 'string') {
    patch.heroImageUrl = heroImageUrl.trim() || null;
  }
  // Director state — JSON object with the four sub-keys the chain
  // honours. Whitelist to avoid arbitrary blobs.
  if (directorState && typeof directorState === 'object' && !Array.isArray(directorState)) {
    const ds = {};
    if (directorState.physicalState && typeof directorState.physicalState === 'object') ds.physicalState = directorState.physicalState;
    if (directorState.cameraState   && typeof directorState.cameraState   === 'object') ds.cameraState   = directorState.cameraState;
    if (directorState.emotionArc    && typeof directorState.emotionArc    === 'object') ds.emotionArc    = directorState.emotionArc;
    if (Array.isArray(directorState.negativeContinuityRules)) {
      ds.negativeContinuityRules = directorState.negativeContinuityRules
        .filter(s => typeof s === 'string' && s.trim())
        .map(s => s.trim().slice(0, 100))
        .slice(0, 16);
    }
    patch.directorState = ds;
  }
  // Boolean toggles — only honoured when provided explicitly so a
  // partial PATCH from the FE doesn't accidentally flip them.
  if (typeof continuityMode === 'boolean') patch.continuityMode = continuityMode;
  if (typeof overlapMode    === 'boolean') patch.overlapMode    = overlapMode;
  if (typeof realismMode    === 'boolean') patch.realismMode    = realismMode;
  // Per-shot step override. NULL / 0 clears it (chain falls back to
  // the per-model continuity default). Bounded [4, 200] to keep one
  // overzealous edit from running for hours.
  if (stepsPerShot === null || stepsPerShot === 0) {
    patch.stepsPerShot = null;
  } else if (Number.isFinite(stepsPerShot)) {
    patch.stepsPerShot = Math.max(4, Math.min(200, Math.floor(stepsPerShot)));
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

    const { currentPrompt, engine = 'groq', model: modelOverride } = req.body || {};
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
      // Path is `services/gemini.js`, not the older `ai/geminiService.js` —
      // earlier wiring pointed at the wrong file and always 503'd.
      const { chatGemini } = await import('../../services/gemini.js').catch(() => ({}));
      if (typeof chatGemini !== 'function') {
        return error(res, 'Gemini engine not configured on this BE', 503);
      }
      // Whitelist the same three Gemini aliases AI Chat exposes so the
      // FE can offer a model picker without us shipping arbitrary
      // upstream model ids.
      const GEMINI_ALLOWED = new Set(['gemini-flash', 'gemini-flash-lite', 'gemini-pro']);
      const geminiModel = GEMINI_ALLOWED.has(modelOverride) ? modelOverride : 'gemini-flash';
      try {
        const result = await chatGemini(prompt, [], geminiModel, { system: reviewSystem, temperature: 0.3 });
        raw = (result?.reply || '').trim();
      } catch (geminiErr) {
        // Most common cause: GEMINI_API_KEY missing in env. Return a
        // 503 with the underlying reason so the FE can show it instead
        // of a generic 500.
        return error(res, `Gemini review failed: ${geminiErr.message}`, 503);
      }
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

    const reportedModel = engine === 'gemini'
      ? (['gemini-flash', 'gemini-flash-lite', 'gemini-pro'].includes(modelOverride) ? modelOverride : 'gemini-flash')
      : 'llama-3.3-70b';
    const out = {
      assessment: ['too_detailed', 'good', 'too_vague'].includes(parsed.assessment) ? parsed.assessment : 'good',
      feedback:   String(parsed.feedback || '').slice(0, 400),
      suggested:  String(parsed.suggested || prompt).slice(0, 600),
      engine,
      model: reportedModel,
    };
    logger.info(`CINEMA REVIEW | ${projectId} | shot ${shotIndex} | ${out.assessment} | engine=${engine} model=${reportedModel}`);
    return success(res, out);
  } catch (err) {
    logger.error('Cinema shot review failed', err.message);
    return error(res, err.message);
  }
};

// POST /api/cinema/:projectId/shots/:shotIndex/fix-action
//   { engine?: 'groq' | 'gemini', model?: string }
//
// Rewrites a single shot's action as a TRUE CONTINUATION of the bible
// + director state. Strips drift, anchors physical + camera state,
// and returns a saferAction plus before/after risk scores. The FE
// shows both side-by-side with one-click Apply (which PATCHes the
// shotPrompts array).
export const postCinemaFixAction = async (req, res) => {
  try {
    const { projectId, shotIndex: shotIndexStr } = req.params;
    const shotIndex = parseInt(shotIndexStr, 10);
    const row = getCinemaProject(projectId);
    if (!row) return error(res, 'Cinema project not found', 404);
    if (row.vault && !req.vault) return error(res, 'Cinema project not found', 404);
    if (!Number.isFinite(shotIndex) || shotIndex < 0 || shotIndex >= row.shotCount) {
      return error(res, `shotIndex must be 0..${row.shotCount - 1}`, 400);
    }
    const engine = (req.body?.engine || 'groq').toLowerCase();
    const model  = req.body?.model;
    const currentAction = (row.shotPrompts || [])[shotIndex] || '';
    if (!currentAction.trim()) return error(res, 'Shot has no action to fix', 400);

    // Risk score on the CURRENT action so we can show the user
    // before vs after.
    const { calculateContinuityRisk } = await import('../../services/aiVideo/cinematicContinuityDirector.js');
    const riskBefore = calculateContinuityRisk({
      bible: row.continuityBible || {},
      directorState: row.directorState || {},
      action: currentAction,
      model: 'wan-2.2',
      motionStrength: row.motionStrength || 0.5,
      durationPerShot: row.durationPerShot || 5,
      hasHeroImage: !!row.heroImageUrl,
      shotIndex,
    });

    const previousAction = shotIndex > 0 ? (row.shotPrompts[shotIndex - 1] || '') : '';
    const dur = row.durationPerShot || 5;
    const fixSystem = `You are a continuity-locked shot rewriter for AI video. Rewrite this single shot as a TRUE CONTINUATION of the previous shot — same subject, same environment, same lighting, same camera language, same physical direction. Remove any new-world description (no new place, no new time of day, no new character, no morphing, no teleporting, no extreme camera moves). Keep the action achievable in ${dur} seconds.

Bible (LOCKED — do not redescribe):
${JSON.stringify(row.continuityBible || {}, null, 2)}

Director state (LOCKED — do not contradict):
${JSON.stringify(row.directorState || {}, null, 2)}

${previousAction ? `Previous shot's action: "${previousAction}"\n` : ''}
Current action (rewrite this):
"${currentAction}"

Output STRICT JSON:
{
  "saferAction": "the rewritten action, action-only, 8-16 words, continuation language",
  "reason":      "one short sentence explaining what you fixed, max 24 words"
}`;

    let raw = '';
    if (engine === 'gemini') {
      const { chatGemini } = await import('../../services/gemini.js').catch(() => ({}));
      if (typeof chatGemini !== 'function') return error(res, 'Gemini engine not configured on this BE', 503);
      const GEMINI_ALLOWED = new Set(['gemini-flash', 'gemini-flash-lite', 'gemini-pro']);
      const m = GEMINI_ALLOWED.has(model) ? model : 'gemini-flash';
      try {
        const result = await chatGemini(currentAction, [], m, { system: fixSystem, temperature: 0.3 });
        raw = (result?.reply || '').trim();
      } catch (e) {
        return error(res, `Gemini fix failed: ${e.message}`, 503);
      }
    } else {
      const result = await chatGroq(currentAction, [], 'llama-3.3-70b', {
        system: fixSystem, temperature: 0.3, maxTokens: 400,
      });
      raw = (result?.reply || '').trim();
    }

    const stripped = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    let parsed = null;
    try { parsed = JSON.parse(stripped); } catch {}
    const saferAction = String(parsed?.saferAction || '').trim();
    const reason      = String(parsed?.reason      || '').trim();
    if (!saferAction) {
      return success(res, {
        saferAction: currentAction,
        reason: 'Model did not return a structured rewrite',
        riskBefore, riskAfter: riskBefore, engine,
      });
    }
    const riskAfter = calculateContinuityRisk({
      bible: row.continuityBible || {},
      directorState: row.directorState || {},
      action: saferAction,
      model: 'wan-2.2',
      motionStrength: row.motionStrength || 0.5,
      durationPerShot: row.durationPerShot || 5,
      hasHeroImage: !!row.heroImageUrl,
      shotIndex,
    });
    logger.info(`CINEMA FIX-ACTION | ${projectId} shot ${shotIndex} | risk ${riskBefore.score}→${riskAfter.score} | engine=${engine}`);
    return success(res, { saferAction, reason, riskBefore, riskAfter, engine });
  } catch (err) {
    logger.error('Cinema fix-action failed', err.message);
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
    const { provider, optimizedMode, beastModel } = req.body || {};
    const row = createCinemaRender({
      projectId: project.projectId,
      shotCount: project.shotPrompts.length,
      vault: project.vault ? 1 : 0,
      provider,
      optimizedMode,
      beastModel,
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
