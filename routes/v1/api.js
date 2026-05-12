import { Router } from 'express';
import { getHealth, getStats } from '../../controllers/v1/health.js';
import { postChat, postAI, postGroqChat, postGeminiChat, postGeminiVision } from '../../controllers/v1/ai.js';
import { postFaceAnalyze, postObjectDetect, getFaceHealth } from '../../controllers/v1/face.js';
import { getNasa } from '../../controllers/v1/nasa.js';
import { postImageGen, postImageEdit, postTTS, postSummarize } from '../../controllers/v1/hf.js';
import { postGenerateVideo, getJobStatus, getTodayVideo, getVideoList, getVideoProviders, deleteVideoById, postUploadSourceImage, getJobQueue, getFailuresList, getJobsFeed, postImageEnhance, postMusicGenerate, getImageStatus, getImageList, deleteImage as deleteImageById } from '../../controllers/v1/aiVideo.js';
import { postRegister, getNextJob, postJobComplete, postJobFailed, getWorkerFile, postJobProgress, postImageComplete, postImageFailed, postImageProgress } from '../../controllers/v1/gpuWorker.js';
import { checkVaultPassword, signVaultToken, requireVault, maybeVault } from '../../services/auth/vault.js';
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

// AI Video — public reads, vault-gated writes. maybeVault sets req.vault
// on reads when a valid token is present so list/jobs can return private
// items to authenticated users.
router.get('/ai-video/status/:jobId',   maybeVault, getJobStatus);
router.get('/ai-video/today',           getTodayVideo);
router.get('/ai-video/list',            maybeVault, getVideoList);
router.get('/ai-video/queue',           maybeVault, getJobQueue);
router.get('/ai-video/failures',        maybeVault, getFailuresList);
router.get('/ai-video/jobs',            maybeVault, getJobsFeed);
router.get('/ai-video/providers',       getVideoProviders);
router.post('/ai-video/generate',       requireVault, postGenerateVideo);
router.delete('/ai-video/:videoId',     requireVault, deleteVideoById);
router.post('/ai-video/upload-image',   requireVault, postUploadSourceImage);

// Image Studio
router.get('/image-enhance/status/:imageId',  maybeVault, getImageStatus);
router.get('/image-enhance/list',             maybeVault, getImageList);
router.post('/image-enhance',                 requireVault, postImageEnhance);
router.delete('/image-enhance/:imageId',      requireVault, deleteImageById);

// Music
router.post('/music/generate',                requireVault, postMusicGenerate);

// GPU worker — polling client endpoints (called by Lightning AI worker)
router.post('/gpu-worker/register', postRegister);
router.get('/gpu-worker/next-job', getNextJob);
router.post('/gpu-worker/job-complete', postJobComplete);
router.post('/gpu-worker/job-failed', postJobFailed);
router.post('/gpu-worker/job-progress', postJobProgress);
router.post('/gpu-worker/image-progress', postImageProgress);
router.post('/gpu-worker/image-complete', postImageComplete);
router.post('/gpu-worker/image-failed',   postImageFailed);
router.get('/gpu-worker/files/:filename', getWorkerFile);

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
