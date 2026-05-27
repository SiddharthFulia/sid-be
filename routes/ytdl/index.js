// /yt-dl/* — paste-a-YouTube-URL → save MP3 or MP4.

import { Router } from 'express';
import { requireVault } from '../../services/auth/vault.js';
import {
  postCreate, getStatus, getList, streamFile, removeJob,
} from '../../controllers/ytdl/index.js';

const router = Router();

router.post(  '/yt-dl',             postCreate);
router.get(   '/yt-dl/list',        getList);
router.get(   '/yt-dl/status/:id',  getStatus);
router.get(   '/yt-dl/file/:id',    streamFile);
// §75 — destructive op requires vault auth.
router.delete('/yt-dl/:id',         requireVault, removeJob);

export default router;
