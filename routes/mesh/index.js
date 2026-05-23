// /mesh/* — text → 3D on the 5090 (Shap-E / Point-E).

import { Router } from 'express';
import {
  postCreateMeshJob, getMeshStatus, listMeshJobsCtrl,
} from '../../controllers/mesh/index.js';

const router = Router();

router.post('/mesh/generate',      postCreateMeshJob);
router.get( '/mesh/status/:jobId', getMeshStatus);
router.get( '/mesh/list',          listMeshJobsCtrl);

export default router;
