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

const router = Router();

router.post(  '/room/analyze',       maybeVault, roomUploadMiddleware, postAnalyzeRoom);
router.post(  '/room/render',        requireVault, postRenderRoom);
router.get(   '/room/status/:jobId', getRoomStatus);
router.get(   '/room/list',          maybeVault, getRoomList);

export default router;
