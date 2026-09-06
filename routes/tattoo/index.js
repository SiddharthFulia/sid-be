// /tattoo/* — Tattoo → AI-styled QR analysis endpoints.
//
// POST /api/tattoo/analyze   multipart 'image' → Gemini Vision → JSON
// GET  /api/tattoo/health    config + cache diagnostics

import { Router } from 'express';
import {
  postAnalyzeTattoo, getTattooHealth, tattooUploadMiddleware,
} from '../../controllers/tattoo/index.js';

const router = Router();

router.post('/tattoo/analyze', tattooUploadMiddleware, postAnalyzeTattoo);
router.get( '/tattoo/health',  getTattooHealth);

export default router;
