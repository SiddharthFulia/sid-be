// /combine/* — multi-video concatenation lane.

import { Router } from 'express';
import {
  postCreate, getStatus, getList, streamFile, removeJob,
} from '../../controllers/combine/index.js';

const router = Router();

router.post(  '/combine',             postCreate);
router.get(   '/combine/list',        getList);
router.get(   '/combine/status/:id',  getStatus);
router.get(   '/combine/file/:id',    streamFile);
router.delete('/combine/:id',         removeJob);

export default router;
