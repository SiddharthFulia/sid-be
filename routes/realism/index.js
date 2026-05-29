// /api/realism/* — sandbox routes for cinematic prompt enrichment.
// Open lane (no vault) because enrichment is cheap (Groq free tier)
// and we want the user to iterate quickly while tuning prompts.

import { Router } from 'express';
import { postEnrichPrompt, getRealismPresets } from '../../controllers/realism/index.js';

const router = Router();

router.post('/realism/enrich-prompt', postEnrichPrompt);
router.get( '/realism/presets',       getRealismPresets);

export default router;
