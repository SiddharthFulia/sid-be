// /combine/* — multi-video concatenation lane.

import { Router } from 'express';
import { maybeVault, requireVault } from '../../services/auth/vault.js';
import {
  postCreate, getStatus, getList, streamFile, removeJob,
  postUpload, uploadMiddleware,
} from '../../controllers/combine/index.js';

const router = Router();

// maybeVault populates req.vault when a valid token is present (and is a
// no-op otherwise) so handlers can decide what to expose. Each endpoint
// makes its own visibility call inside the handler — see controller.
router.post(  '/combine',             maybeVault, postCreate);
router.post(  '/combine/upload',      maybeVault, uploadMiddleware, postUpload);
router.get(   '/combine/list',        maybeVault, getList);
router.get(   '/combine/status/:id',  maybeVault, getStatus);
router.get(   '/combine/file/:id',    maybeVault, streamFile);
router.delete('/combine/:id',         requireVault, removeJob);   // §75 — vault gate

export default router;
