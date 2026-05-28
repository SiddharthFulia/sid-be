// /api/room/* — AI Room Designer V2 routes.
//
// Vault gating policy:
//   - /analyze       open (anyone can try the analyzer)
//   - /render        requireVault (Cloudinary cost + GPU minutes)
//   - /status        open (polled by FE, doesn't mutate)
//   - /list          maybeVault (vault items hidden for anon)
//   - DELETE         requireVault

import { Router } from 'express';
import { maybeVault, requireVault } from '../../services/auth/vault.js';
import {
  roomUploadMiddleware,
  postAnalyzeRoom,
  postRenderRoom,
  getRoomStatus,
  getRoomList,
} from '../../controllers/room/index.js';
import { getSplatSample, listSplatSamples } from '../../controllers/room/splatSamples.js';

const router = Router();

router.post(  '/room/analyze',       maybeVault, roomUploadMiddleware, postAnalyzeRoom);
router.post(  '/room/render',        requireVault, postRenderRoom);
router.get(   '/room/status/:jobId', getRoomStatus);
router.get(   '/room/list',          maybeVault, getRoomList);

// Splat-viewer sample-scene cache. Lazy-downloads from Hugging Face
// using HF_TOKEN, caches to disk, streams with Range support.
router.get(   '/splat-sample/list',   listSplatSamples);
router.get(   '/splat-sample/:slug',  getSplatSample);

export default router;
