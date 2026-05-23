// /image-enhance/* — image-to-image upscale + restyle lane. Same
// public-with-Vault-bulk-gating shape as /ai-video.

import { Router } from 'express';
import { maybeVault } from '../../services/auth/vault.js';
import {
  postImageEnhance, getImageStatus, getImageList,
  deleteImage as deleteImageById, postImageBulkAction,
} from '../../controllers/aiVideo/index.js';

const router = Router();

router.get( '/image-enhance/status/:imageId', maybeVault, getImageStatus);
router.get( '/image-enhance/list',            maybeVault, getImageList);
router.post('/image-enhance',                 maybeVault, postImageEnhance);
router.delete('/image-enhance/:imageId',      maybeVault, deleteImageById);

router.post('/image-enhance/bulk', maybeVault, (req, res, next) => {
  const a = req.body?.action;
  if ((a === 'move-to-vault' || a === 'make-public') && !req.vault) {
    return res.status(401).json({ status: false, message: 'Vault login required for this action' });
  }
  return postImageBulkAction(req, res, next);
});

export default router;
