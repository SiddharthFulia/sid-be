// /ai-video/* — text-to-video generation lane (LTX-Video on 5090 + ZSky
// cloud). maybeVault enriches req with vault state; controllers use it
// to surface private library items + accept vault: true on /generate.

import { Router } from 'express';
import { maybeVault } from '../../services/auth/vault.js';
import {
  postGenerateVideo, getJobStatus, getTodayVideo, getVideoList, getVideoProviders,
  deleteVideoById, postUploadSourceImage, getJobQueue, getFailuresList, getJobsFeed,
  postVideoBulkAction,
} from '../../controllers/aiVideo/index.js';

const router = Router();

router.get( '/ai-video/status/:jobId', maybeVault, getJobStatus);
router.get( '/ai-video/today',                     getTodayVideo);
router.get( '/ai-video/list',          maybeVault, getVideoList);
router.get( '/ai-video/queue',         maybeVault, getJobQueue);
router.get( '/ai-video/failures',      maybeVault, getFailuresList);
router.get( '/ai-video/jobs',          maybeVault, getJobsFeed);
router.get( '/ai-video/providers',                 getVideoProviders);
router.post('/ai-video/generate',      maybeVault, postGenerateVideo);
router.delete('/ai-video/:videoId',    maybeVault, deleteVideoById);
router.post('/ai-video/upload-image',  maybeVault, postUploadSourceImage);

// Bulk actions — move-to-vault / make-public require auth. Defensive
// check before delegating to the controller.
router.post('/ai-video/bulk', maybeVault, (req, res, next) => {
  const a = req.body?.action;
  if ((a === 'move-to-vault' || a === 'make-public') && !req.vault) {
    return res.status(401).json({ status: false, message: 'Vault login required for this action' });
  }
  return postVideoBulkAction(req, res, next);
});

export default router;
