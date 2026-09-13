// /vision/* — Fully-offline vision analysis (no Gemini, no cloud).
//
// POST /api/vision/analyze  multipart 'image' → YOLO + MediaPipe + Tesseract
//                           + dominant colours + metadata → unified JSON
// GET  /api/vision/health   backend + cache + rate-limit diagnostics
//
// Backed by the Python face-service at $FACE_SERVICE_URL (port 5000 locally,
// same host+port on Oracle). See controllers/vision/index.js for the
// per-lane fallback + cache + rate-limit logic.

import { Router } from 'express';
import {
  postVisionAnalyze, getVisionHealth, visionUploadMiddleware,
} from '../../controllers/vision/index.js';

const router = Router();

router.post('/vision/analyze', visionUploadMiddleware, postVisionAnalyze);
router.get( '/vision/health',  getVisionHealth);

export default router;
