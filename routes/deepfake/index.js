// /deepfake/* — Vault-gated face-swap + voice-clone lane.

import { Router } from 'express';
import { requireVault } from '../../services/auth/vault.js';
import {
  postCreateDeepfakeJob, getDeepfakeStatus, listDeepfakeJobsCtrl,
} from '../../controllers/deepfake/index.js';

const router = Router();

router.post('/deepfake/generate',      requireVault, postCreateDeepfakeJob);
router.get( '/deepfake/status/:jobId', requireVault, getDeepfakeStatus);
router.get( '/deepfake/list',          requireVault, listDeepfakeJobsCtrl);

export default router;
