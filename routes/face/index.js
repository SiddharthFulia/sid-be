// /face-analyze, /detect-objects, /face-health — MediaPipe + YOLOv8
// detection lane (Python sidecar).

import { Router } from 'express';
import { postFaceAnalyze, postObjectDetect, getFaceHealth } from '../../controllers/face/index.js';

const router = Router();

router.post('/face-analyze',   postFaceAnalyze);
router.post('/detect-objects', postObjectDetect);
router.get( '/face-health',    getFaceHealth);

export default router;
