// /admin/* — Vault-gated monitoring + queue control.

import { Router } from 'express';
import { requireVault } from '../../services/auth/vault.js';
import {
  getServerStats, getDbStats, getQueueStats, getWorkers,
  postPurgeQueue, getActivityTimeseries, getDiskStats, getMeshStats,
  getCloudinaryUsage, getCloudinaryResources, postCloudinaryDelete,
} from '../../controllers/admin/index.js';
import {
  getTables as getDbTables,
  getTableRows as getDbTableRows,
  postQuery as postDbQuery,
  postAsk as postDbAsk,
} from '../../controllers/admin/dbExplorer.js';
import {
  postTriggerKeepAlive,
  getKeepAliveStatusHandler,
} from '../../controllers/admin/keepAlive.js';

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

// Database Explorer — Settings → Database tab. Schema introspection +
// safe row browser + read-only SQL + Groq natural-language → SELECT.
// `:name` and SQL are vetted inside the service before execution.
router.get( '/admin/db/tables',         requireVault, getDbTables);
router.get( '/admin/db/tables/:name',   requireVault, getDbTableRows);
router.post('/admin/db/query',          requireVault, postDbQuery);
router.post('/admin/db/ask',            requireVault, postDbAsk);

// Keep-alive queue — nightly cron + manual trigger. Vault-gated so anon
// visitors can't spam publishes.
router.post('/admin/keep-alive/trigger', requireVault, postTriggerKeepAlive);
router.get( '/admin/keep-alive/status',  requireVault, getKeepAliveStatusHandler);

export default router;
