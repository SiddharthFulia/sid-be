// /api/events/* — Server-Sent Events for real-time job state.
//
// Public: any FE client that knows the jobId can subscribe. This mirrors the
// existing `/api/*/status/:jobId` polling endpoints — they are public today
// so the SSE side is too. If we ever gate them, gate this identically.

import { Router } from 'express';
import { streamJobEvents, getEventsStats } from '../../controllers/events/index.js';
import { requireVault } from '../../services/auth/vault.js';

const router = Router();

router.get('/events/job/:jobId', streamJobEvents);
router.get('/events/stats',      requireVault, getEventsStats);

export default router;
