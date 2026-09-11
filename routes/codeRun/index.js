// /code/* — sandboxed code execution proxy for the /algorithms pages.
// Backed by a public Piston instance; upstream URL never crosses the
// wire to the browser. See controllers/codeRun/index.js for limits,
// rate-limit, and cache TTL.

import { Router } from 'express';
import { postCodeRun } from '../../controllers/codeRun/index.js';

const router = Router();

router.post('/code/run', postCodeRun);

export default router;
