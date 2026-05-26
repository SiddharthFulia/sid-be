// /admin/* — Vault-gated monitoring + queue control.

import { Router } from 'express';
import { requireVault } from '../../services/auth/vault.js';
import {
  getServerStats, getDbStats, getQueueStats, getWorkers,
  postPurgeQueue, getActivityTimeseries, getDiskStats, getMeshStats,
  getCloudinaryUsage, getCloudinaryResources, postCloudinaryDelete,
} from '../../controllers/admin/index.js';

const router = Router();

router.get( '/admin/server-stats', requireVault, getServerStats);
router.get( '/admin/db-stats',     requireVault, getDbStats);
router.get( '/admin/disk-stats',   requireVault, getDiskStats);
router.get( '/admin/mesh-stats',   requireVault, getMeshStats);
router.get( '/admin/queues',       requireVault, getQueueStats);
router.get( '/admin/workers',      requireVault, getWorkers);
router.get( '/admin/activity',     requireVault, getActivityTimeseries);
router.post('/admin/queues/purge', requireVault, postPurgeQueue);

// Cloudinary management — Settings → Cloudinary tab.
router.get( '/admin/cloudinary/usage',     requireVault, getCloudinaryUsage);
router.get( '/admin/cloudinary/resources', requireVault, getCloudinaryResources);
router.post('/admin/cloudinary/delete',    requireVault, postCloudinaryDelete);

export default router;
