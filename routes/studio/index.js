// Studio lanes (Tier 3) — /lipsync/*, /audio/*, /cinema/*.
// maybeVault still applied so controllers can record auth state for
// telemetry, but visibility decisions ignore vault state — these lanes
// live in their own libraries, no NSFW gate.

import { Router } from 'express';
import { maybeVault, requireVault } from '../../services/auth/vault.js';
import {
  postLipsync, getLipsyncStatus, getLipsyncList, deleteLipsync, postLipsyncBulkAction,
  postAudio, getAudioStatus, getAudioList, deleteAudio, postAudioBulkAction,
  postCinema, getCinemaStatus, getCinemaList, deleteCinema, patchCinemaShots, postCinemaBulkAction,
  postCinemaRender, getCinemaRenderStatus, patchCinemaRender,
  getCinemaRendersList, deleteCinemaRenderCtrl, postCinemaRenderResume,
  getCinemaRenderLogs, postCinemaShotReview, postCinemaFixAction, getCinemaDiskStats,
  postCinemaRenderCancel,
} from '../../controllers/studio/index.js';

const router = Router();

// Lip Sync
router.post(  '/lipsync',                  maybeVault, postLipsync);
router.get(   '/lipsync/status/:jobId',    maybeVault, getLipsyncStatus);
router.get(   '/lipsync/list',             maybeVault, getLipsyncList);
// §75 — destructive ops now require vault auth (site going public).
router.delete('/lipsync/:jobId',           requireVault, deleteLipsync);
router.post(  '/lipsync/bulk',             requireVault, postLipsyncBulkAction);

// Audio Studio
router.post(  '/audio',                    maybeVault, postAudio);
router.get(   '/audio/status/:jobId',      maybeVault, getAudioStatus);
router.get(   '/audio/list',               maybeVault, getAudioList);
router.delete('/audio/:jobId',             requireVault, deleteAudio);
router.post(  '/audio/bulk',               requireVault, postAudioBulkAction);

// Cinema (multi-shot project)
router.post(  '/cinema',                   maybeVault, postCinema);
router.get(   '/cinema/status/:projectId', maybeVault, getCinemaStatus);
router.get(   '/cinema/list',              maybeVault, getCinemaList);
router.delete('/cinema/:projectId',        requireVault, deleteCinema);
router.patch( '/cinema/:projectId',                       maybeVault, patchCinemaShots);
router.post(  '/cinema/:projectId/shots/:shotIndex/review',     maybeVault, postCinemaShotReview);
router.post(  '/cinema/:projectId/shots/:shotIndex/fix-action', maybeVault, postCinemaFixAction);
router.post(  '/cinema/bulk',                             requireVault, postCinemaBulkAction);

// Cinema renders (per-attempt resumable state). Listed BEFORE the
// `/cinema/:projectId` route above so the `/render/...` path doesn't
// get swallowed by the projectId route — Express matches in order.
router.get(   '/cinema/disk-stats',                maybeVault, getCinemaDiskStats);
router.post(  '/cinema/:projectId/render',         maybeVault, postCinemaRender);
router.get(   '/cinema/render/:renderId',          maybeVault, getCinemaRenderStatus);
router.get(   '/cinema/render/:renderId/logs',     maybeVault, getCinemaRenderLogs);
router.patch( '/cinema/render/:renderId',          maybeVault, patchCinemaRender);
router.post(  '/cinema/render/:renderId/resume',   maybeVault, postCinemaRenderResume);
router.post(  '/cinema/render/:renderId/cancel',   requireVault, postCinemaRenderCancel);
router.delete('/cinema/render/:renderId',          requireVault, deleteCinemaRenderCtrl);
router.get(   '/cinema/renders',                   maybeVault, getCinemaRendersList);

export default router;
