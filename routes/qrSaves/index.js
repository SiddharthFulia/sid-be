// /qr-saves/* — public shareable QR library. Owner identity is a
// browser fingerprint hash passed as X-QR-Owner: <hex>. No accounts.

import { Router } from 'express';
import {
  postCreate, getList, getOne, deleteOne, patchOne,
} from '../../controllers/qrSaves/index.js';

const router = Router();

router.post(  '/qr-saves',      postCreate);
router.get(   '/qr-saves',      getList);
router.get(   '/qr-saves/:id',  getOne);
router.patch( '/qr-saves/:id',  patchOne);
router.delete('/qr-saves/:id',  deleteOne);

export default router;
