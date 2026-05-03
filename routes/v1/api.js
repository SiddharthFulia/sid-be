import { Router } from 'express';
import { getHealth, getStats } from '../../controllers/v1/health.js';
import { postChat, postAI, postGroqChat, postGeminiChat, postGeminiVision } from '../../controllers/v1/ai.js';
import { postFaceAnalyze, postObjectDetect, getFaceHealth } from '../../controllers/v1/face.js';
import { getNasa } from '../../controllers/v1/nasa.js';
import { postImageGen, postImageEdit, postTTS, postSummarize } from '../../controllers/v1/hf.js';
import { postGenerateVideo, getTodayVideo, getVideoList, getVideoProviders } from '../../controllers/v1/aiVideo.js';

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

// AI Video generation (free + open-source models)
router.post('/ai-video/generate', postGenerateVideo);
router.get('/ai-video/today', getTodayVideo);
router.get('/ai-video/list', getVideoList);
router.get('/ai-video/providers', getVideoProviders);

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
