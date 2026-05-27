// /ai-video/* — text-to-video generation lane (LTX-Video on 5090 + ZSky
// cloud). maybeVault enriches req with vault state; controllers use it
// to surface private library items + accept vault: true on /generate.

import { Router } from 'express';
import { maybeVault, requireVault } from '../../services/auth/vault.js';
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
// §75 — site going public: every destructive op now requires vault
// auth. Anonymous visitors get a 401 before the handler runs.
router.delete('/ai-video/:videoId',    requireVault, deleteVideoById);
router.post('/ai-video/upload-image',  maybeVault, postUploadSourceImage);

// Bulk actions — ALL three (move-to-vault / make-public / delete) now
// require vault auth. requireVault is the hard gate.
router.post('/ai-video/bulk', requireVault, postVideoBulkAction);

export default router;
