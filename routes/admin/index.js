// /admin/* — Vault-gated monitoring + queue control.

import { Router } from 'express';
import { requireVault } from '../../services/auth/vault.js';
import {
  getServerStats, getDbStats, getQueueStats, getWorkers,
  postPurgeQueue, getActivityTimeseries,
} from '../../controllers/admin/index.js';

const router = Router();

router.get( '/admin/server-stats', requireVault, getServerStats);
router.get( '/admin/db-stats',     requireVault, getDbStats);
router.get( '/admin/queues',       requireVault, getQueueStats);
router.get( '/admin/workers',      requireVault, getWorkers);
router.get( '/admin/activity',     requireVault, getActivityTimeseries);
router.post('/admin/queues/purge', requireVault, postPurgeQueue);

export default router;
