import { Router } from 'express';
import { getHealth, getStats } from '../../controllers/v1/health.js';
import { postChat, postAI } from '../../controllers/v1/ai.js';
import { postFaceAnalyze, getFaceHealth } from '../../controllers/v1/face.js';
import { getNasa } from '../../controllers/v1/nasa.js';

const router = Router();

// Health
router.get('/health', getHealth);
router.get('/stats', getStats);

// AI (Ollama)
router.post('/chat', postChat);
router.post('/ai', postAI);

// Face Detection
router.post('/face-analyze', postFaceAnalyze);
router.get('/face-health', getFaceHealth);

// NASA API Proxy (offloads API key from frontend)
// Express 5 wildcard syntax: matches /nasa/planetary/apod, /nasa/proxy/fireball, etc.
router.get('/nasa/{*endpoint}', getNasa);

export default router;
