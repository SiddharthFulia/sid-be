// /vision/* — deep + light vision analysis, all on the BE.
//
// POST /api/vision/analyze         multipart 'image' → light or deep (auto-upgrade)
// POST /api/vision/deep-analyze    multipart 'image' → forces the deep pipeline
//                                  (BLIP caption + CLIP tags + InsightFace +
//                                  YOLOv8 + PaddleOCR + Depth-Anything + palette)
// POST /api/vision/face-verify     multipart 'imageA' + 'imageB' → InsightFace
//                                  cosine similarity → { same_person, similarity }
// POST /api/vision/extract-subject multipart 'image' + ?mode=auto|dark|depth
//                                  → 1-bit alpha mask + bbox + centroid +
//                                    RGBA thumbnail of the extracted subject.
//                                    Pure OpenCV — fast, no model weights.
// GET  /api/vision/health          Python service + cache + rate-limit diagnostics
//
// See controllers/vision/index.js for the SHA-256 cache + per-endpoint rate
// limits (analyze 5/min, deep 3/min, verify 3/min, extract-subject 5/min).
// Underlying compute runs in the Python face-service (FACE_SERVICE_URL,
// port 5000 locally, same host on Oracle).

import { Router } from 'express';
import {
  postVisionAnalyze,
  postVisionDeepAnalyze,
  postFaceVerify,
  postExtractSubject,
  getVisionHealth,
  visionUploadMiddleware,
  visionVerifyUploadMiddleware,
} from '../../controllers/vision/index.js';

const router = Router();

router.post('/vision/analyze',         visionUploadMiddleware,       postVisionAnalyze);
router.post('/vision/deep-analyze',    visionUploadMiddleware,       postVisionDeepAnalyze);
router.post('/vision/face-verify',     visionVerifyUploadMiddleware, postFaceVerify);
router.post('/vision/extract-subject', visionUploadMiddleware,       postExtractSubject);
router.get( '/vision/health',          getVisionHealth);

export default router;
