// NASA + third-party API proxy — keeps API keys off the FE.
// Express 5 wildcard syntax: matches /nasa/planetary/apod, /proxy/iss, etc.

import { Router } from 'express';
import { getNasa } from '../../controllers/nasa/index.js';

const router = Router();

router.get('/nasa/{*endpoint}',  getNasa);
router.get('/proxy/{*endpoint}', getNasa);

export default router;
