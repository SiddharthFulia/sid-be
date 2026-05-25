// /mesh/* — text → 3D on the 5090 (Shap-E / Point-E).

import { Router } from 'express';
import {
  postCreateMeshJob, getMeshStatus, listMeshJobsCtrl, deleteMeshJobCtrl,
  streamMeshFile,
} from '../../controllers/mesh/index.js';

const router = Router();

router.post(  '/mesh/generate',      postCreateMeshJob);
router.get(   '/mesh/status/:jobId', getMeshStatus);
router.get(   '/mesh/list',          listMeshJobsCtrl);
router.get(   '/mesh/file/:jobId',   streamMeshFile);
router.delete('/mesh/:jobId',        deleteMeshJobCtrl);

export default router;
