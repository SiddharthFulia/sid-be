// /api/realism/* — sandbox routes for cinematic prompt enrichment.
// Open lane (no vault) because enrichment is cheap (Groq free tier)
// and we want the user to iterate quickly while tuning prompts.

import { Router } from 'express';
import { maybeVault, requireVault } from '../../services/auth/vault.js';
import {
  postEnrichPrompt, getRealismPresets,
  postSaveFromUrl, getRealismList, getRealismFile, getRealismPoster,
  deleteRealism,
} from '../../controllers/realism/index.js';

const router = Router();

router.post(  '/realism/enrich-prompt',   postEnrichPrompt);
router.get(   '/realism/presets',         getRealismPresets);

// Local-storage library
router.post(  '/realism/save-from-url',   maybeVault, postSaveFromUrl);
router.get(   '/realism/list',            maybeVault, getRealismList);
router.get(   '/realism/file/:name',      maybeVault, getRealismFile);
router.get(   '/realism/poster/:name',    maybeVault, getRealismPoster);
router.delete('/realism/:id',             requireVault, deleteRealism);

export default router;
