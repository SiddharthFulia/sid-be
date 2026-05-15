import { Router } from 'express';
import { getHealth, getStats } from '../../controllers/v1/health.js';
import { postChat, postAI, postGroqChat, postGeminiChat, postGeminiVision, postPromptCoach } from '../../controllers/v1/ai.js';
import { postFaceAnalyze, postObjectDetect, getFaceHealth } from '../../controllers/v1/face.js';
import { getNasa } from '../../controllers/v1/nasa.js';
import { postImageGen, postImageEdit, postTTS, postSummarize } from '../../controllers/v1/hf.js';
import { postGenerateVideo, getJobStatus, getTodayVideo, getVideoList, getVideoProviders, deleteVideoById, postUploadSourceImage, getJobQueue, getFailuresList, getJobsFeed, postImageEnhance, postMusicGenerate, getImageStatus, getImageList, deleteImage as deleteImageById, postImageBulkAction, postVideoBulkAction } from '../../controllers/v1/aiVideo.js';
import { postRegister, getNextJob, postJobComplete, postJobFailed, postJobProgress, postImageComplete, postImageFailed, postImageProgress, postLipsyncProgress, postLipsyncComplete, postLipsyncFailed, postAudioProgress, postAudioComplete, postAudioFailed } from '../../controllers/v1/gpuWorker.js';
import {
  postLipsync, getLipsyncStatus, getLipsyncList, deleteLipsync, postLipsyncBulkAction,
  postAudio, getAudioStatus, getAudioList, deleteAudio, postAudioBulkAction,
  postCinema, getCinemaStatus, getCinemaList, deleteCinema, patchCinemaShots, postCinemaBulkAction,
} from '../../controllers/v1/studio.js';
import { checkVaultPassword, signVaultToken, requireVault, maybeVault } from '../../services/auth/vault.js';
import { listLogs } from '../../services/aiVideo/logStore.js';
import { success, error } from '../../helpers/res_helper.js';

const router = Router();

// Health
router.get('/health', getHealth);
router.get('/stats', getStats);

// AI (Ollama local)
router.post('/chat', postChat);
router.post('/ai', postAI);

// AI (Groq cloud — fast inference)
router.post('/groq', postGroqChat);

// AI (Gemini — Google, multimodal)
router.post('/gemini', postGeminiChat);
router.post('/gemini/vision', postGeminiVision);

// Prompt coach — turns a plain-English idea into a model-tuned image prompt.
// Used by the Image Studio "💡 Help me write a prompt" modal. The family field
// drives which system prompt is used (sdxl / pony / sdxl-hyper / flux).
router.post('/ai/prompt-coach', postPromptCoach);

// AI Tools (image gen, edit, TTS, summarize)
router.post('/generate-image', postImageGen);
router.post('/image-edit', postImageEdit);
router.post('/tts', postTTS);
router.post('/summarize', postSummarize);

// Vault login — returns a JWT used to access the create/delete endpoints.
// View/list endpoints stay public so the library is still readable to
// anyone with the link. Only mutating routes are protected.
router.post('/auth/vault-login', (req, res) => {
  const { password } = req.body || {};
  if (!checkVaultPassword(password)) {
    return error(res, 'Invalid password', 401);
  }
  return success(res, { token: signVaultToken() });
});
router.get('/auth/vault-status', requireVault, (_req, res) => success(res, { ok: true }));

// ─── Unified log feed (added 2026-05) ──────────────────────────────
// Lightweight live-tail endpoint. The FE polls this every 1.5s during a job
// passing `since=<lastTs>` so each response is just the new lines — much
// cheaper than re-fetching the whole status row.
//
//   GET /api/job-logs/:lane/:jobId?since=<ms>&limit=80
//
// Lanes: 'video' | 'image' | 'lipsync' | 'audio'.
// Returns: { logs: [{ts, msg}, ...], nextSince } in chronological order.
router.get('/job-logs/:lane/:jobId', maybeVault, (req, res) => {
  const lane = String(req.params.lane || '').toLowerCase();
  const jobId = req.params.jobId;
  if (!['video', 'image', 'lipsync', 'audio'].includes(lane)) {
    return error(res, "lane must be 'video' | 'image' | 'lipsync' | 'audio'", 400);
  }
  if (!jobId) return error(res, 'jobId required', 400);
  const sinceTs = parseInt(req.query.since, 10) || 0;
  const limit = Math.min(parseInt(req.query.limit, 10) || 80, 500);
  const logs = listLogs({ jobId, lane, sinceTs, limit });
  return success(res, { logs, nextSince: logs.length ? logs[logs.length - 1].ts : sinceTs });
});

// AI Video — fully public CRUD. maybeVault sets req.vault on every request
// when a valid token is present; controllers use it to:
//   • return vault items in list/status when ?visibility=vault is requested
//   • allow `vault: true` flag on /generate (otherwise the flag is ignored)
// Routes themselves are NEVER blocked by auth — visitors can browse + create
// + delete public content without logging in. Auth only unlocks the private
// vault lane.
router.get('/ai-video/status/:jobId',   maybeVault, getJobStatus);
router.get('/ai-video/today',           getTodayVideo);
router.get('/ai-video/list',            maybeVault, getVideoList);
router.get('/ai-video/queue',           maybeVault, getJobQueue);
router.get('/ai-video/failures',        maybeVault, getFailuresList);
router.get('/ai-video/jobs',            maybeVault, getJobsFeed);
router.get('/ai-video/providers',       getVideoProviders);
router.post('/ai-video/generate',       maybeVault, postGenerateVideo);
router.delete('/ai-video/:videoId',     maybeVault, deleteVideoById);
router.post('/ai-video/upload-image',   maybeVault, postUploadSourceImage);
// Bulk actions — move-to-vault / make-public require auth; delete does not.
// requireVault sits inside the controller via the action discriminator, so
// the route uses maybeVault and the controller rejects unauthenticated
// move/public calls (defensive check below).
router.post('/ai-video/bulk',           maybeVault, (req, res, next) => {
  const a = req.body?.action;
  if ((a === 'move-to-vault' || a === 'make-public') && !req.vault) {
    return res.status(401).json({ status: false, message: 'Vault login required for this action' });
  }
  return postVideoBulkAction(req, res, next);
});

// Image Studio — same pattern
router.get('/image-enhance/status/:imageId',  maybeVault, getImageStatus);
router.get('/image-enhance/list',             maybeVault, getImageList);
router.post('/image-enhance',                 maybeVault, postImageEnhance);
router.delete('/image-enhance/:imageId',      maybeVault, deleteImageById);
router.post('/image-enhance/bulk',            maybeVault, (req, res, next) => {
  const a = req.body?.action;
  if ((a === 'move-to-vault' || a === 'make-public') && !req.vault) {
    return res.status(401).json({ status: false, message: 'Vault login required for this action' });
  }
  return postImageBulkAction(req, res, next);
});

// Music — public, no auth needed
router.post('/music/generate',                postMusicGenerate);

// GPU worker — polling client endpoints (called by Lightning AI worker)
router.post('/gpu-worker/register', postRegister);
router.get('/gpu-worker/next-job', getNextJob);
router.post('/gpu-worker/job-complete', postJobComplete);
router.post('/gpu-worker/job-failed', postJobFailed);
router.post('/gpu-worker/job-progress', postJobProgress);
router.post('/gpu-worker/image-progress', postImageProgress);
router.post('/gpu-worker/image-complete', postImageComplete);
router.post('/gpu-worker/image-failed',   postImageFailed);
// Lip Sync worker callbacks
router.post('/gpu-worker/lipsync-progress', postLipsyncProgress);
router.post('/gpu-worker/lipsync-complete', postLipsyncComplete);
router.post('/gpu-worker/lipsync-failed',   postLipsyncFailed);
// Audio Studio worker callbacks
router.post('/gpu-worker/audio-progress',   postAudioProgress);
router.post('/gpu-worker/audio-complete',   postAudioComplete);
router.post('/gpu-worker/audio-failed',     postAudioFailed);

// ─── Studio lanes (Tier 3) — no vault gating; library + bulk delete ─
// These lanes don't need NSFW gating — they live in their own libraries.
// `maybeVault` middleware stays so we still record auth state for telemetry,
// but the controllers ignore req.vault for visibility decisions.
router.post('/lipsync',                     maybeVault, postLipsync);
router.get('/lipsync/status/:jobId',        maybeVault, getLipsyncStatus);
router.get('/lipsync/list',                 maybeVault, getLipsyncList);
router.delete('/lipsync/:jobId',            maybeVault, deleteLipsync);
router.post('/lipsync/bulk',                maybeVault, postLipsyncBulkAction);

router.post('/audio',                       maybeVault, postAudio);
router.get('/audio/status/:jobId',          maybeVault, getAudioStatus);
router.get('/audio/list',                   maybeVault, getAudioList);
router.delete('/audio/:jobId',              maybeVault, deleteAudio);
router.post('/audio/bulk',                  maybeVault, postAudioBulkAction);

router.post('/cinema',                      maybeVault, postCinema);
router.get('/cinema/status/:projectId',     maybeVault, getCinemaStatus);
router.get('/cinema/list',                  maybeVault, getCinemaList);
router.delete('/cinema/:projectId',         maybeVault, deleteCinema);
router.patch('/cinema/:projectId',          maybeVault, patchCinemaShots);
router.post('/cinema/bulk',                 maybeVault, postCinemaBulkAction);

// Face Detection
router.post('/face-analyze', postFaceAnalyze);
router.post('/detect-objects', postObjectDetect);
router.get('/face-health', getFaceHealth);

// NASA API Proxy (offloads API key from frontend)
// Express 5 wildcard syntax: matches /nasa/planetary/apod, etc.
router.get('/nasa/{*endpoint}', getNasa);

// Generic third-party API proxy (pokemon, rickmorty, dogs, weather, etc.)
router.get('/proxy/{*endpoint}', getNasa);

export default router;
