// Top-level route aggregator. Each subrouter owns a domain folder
// under routes/<name>/index.js and uses its own URL prefix internally
// (so we just mount them all at /). Add a new domain by dropping a
// folder under routes/ and adding one import + use() line below.
//
// Mounted at /api by app.js, so endpoints land at /api/<route>.

import { Router } from 'express';

import healthRoutes        from './health/index.js';
import authRoutes          from './auth/index.js';
import aiRoutes            from './ai/index.js';
import adminRoutes         from './admin/index.js';
import chessRoutes         from './chess/index.js';
import deepfakeRoutes      from './deepfake/index.js';
import meshRoutes          from './mesh/index.js';
import gamesRoutes         from './games/index.js';
import ytdlRoutes          from './ytdl/index.js';
import gpuWorkerRoutes     from './gpuWorker/index.js';
import aiVideoRoutes       from './aiVideo/index.js';
import imageEnhanceRoutes  from './imageEnhance/index.js';
import studioRoutes        from './studio/index.js';
import faceRoutes          from './face/index.js';
import nasaRoutes          from './nasa/index.js';
import toolsRoutes         from './tools/index.js';

const router = Router();

router.use('/', healthRoutes);
router.use('/', authRoutes);
router.use('/', aiRoutes);
router.use('/', adminRoutes);
router.use('/', chessRoutes);
router.use('/', deepfakeRoutes);
router.use('/', meshRoutes);
router.use('/', gamesRoutes);
router.use('/', ytdlRoutes);
router.use('/', gpuWorkerRoutes);
router.use('/', aiVideoRoutes);
router.use('/', imageEnhanceRoutes);
router.use('/', studioRoutes);
router.use('/', faceRoutes);
router.use('/', nasaRoutes);
router.use('/', toolsRoutes);

export default router;
