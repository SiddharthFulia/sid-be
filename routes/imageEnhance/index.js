// /image-enhance/* — image-to-image upscale + restyle lane. Same
// public-with-Vault-bulk-gating shape as /ai-video.

import { Router } from 'express';
import { maybeVault, requireVault } from '../../services/auth/vault.js';
import {
  postImageEnhance, getImageStatus, getImageList,
  deleteImage as deleteImageById, postImageBulkAction,
} from '../../controllers/aiVideo/index.js';

const router = Router();

router.get( '/image-enhance/status/:imageId', maybeVault, getImageStatus);
router.get( '/image-enhance/list',            maybeVault, getImageList);
router.post('/image-enhance',                 maybeVault, postImageEnhance);
// §75 — destructive ops require vault auth.
router.delete('/image-enhance/:imageId',      requireVault, deleteImageById);
router.post('/image-enhance/bulk',            requireVault, postImageBulkAction);

export default router;
