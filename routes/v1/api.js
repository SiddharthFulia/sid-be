import { Router } from 'express';
import { getHealth, getStats } from '../../controllers/v1/health.js';
import { postChat, postAI, postGroqChat, postGeminiChat, postGeminiVision } from '../../controllers/v1/ai.js';
import { postFaceAnalyze, postObjectDetect, getFaceHealth } from '../../controllers/v1/face.js';
import { getNasa } from '../../controllers/v1/nasa.js';
import { postImageGen, postImageEdit, postTTS, postSummarize } from '../../controllers/v1/hf.js';
import { postGenerateVideo, getJobStatus, getTodayVideo, getVideoList, getVideoProviders, deleteVideoById, postUploadSourceImage, getJobQueue, getFailuresList, getJobsFeed, postImageEnhance, postMusicGenerate, getImageStatus, getImageList, deleteImage as deleteImageById } from '../../controllers/v1/aiVideo.js';
import { postRegister, getNextJob, postJobComplete, postJobFailed, getWorkerFile, postJobProgress, postImageComplete, postImageFailed, postImageProgress } from '../../controllers/v1/gpuWorker.js';

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

// AI Video generation (Cloudinary-backed)
router.post('/ai-video/generate', postGenerateVideo);
router.get('/ai-video/status/:jobId', getJobStatus);
router.get('/ai-video/today', getTodayVideo);
router.get('/ai-video/list', getVideoList);
router.get('/ai-video/queue', getJobQueue);
router.get('/ai-video/failures', getFailuresList);
router.get('/ai-video/jobs', getJobsFeed);
router.get('/ai-video/providers', getVideoProviders);
router.delete('/ai-video/:videoId', deleteVideoById);
router.post('/ai-video/upload-image', postUploadSourceImage);
router.post('/image-enhance',          postImageEnhance);    // creates job, returns imageId
router.get('/image-enhance/status/:imageId', getImageStatus);
router.get('/image-enhance/list',      getImageList);         // paginated library
router.delete('/image-enhance/:imageId', deleteImageById);
router.post('/music/generate',         postMusicGenerate);

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
