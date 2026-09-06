// /city-graphs/* — SQLite-backed road graph cache for the Pathfinding lab.
//
// Public reads (list + get). Vault-gated refresh so random visitors
// can't spam Overpass. See controllers/cityGraphs/index.js for the
// storage + rate-limit rationale.

import { Router } from 'express';
import { requireVault } from '../../services/auth/vault.js';
import {
  listCities, getCity, refreshCity,
} from '../../controllers/cityGraphs/index.js';

const router = Router();

router.get( '/city-graphs',                  listCities);
router.get( '/city-graphs/:slug',            getCity);
router.post('/city-graphs/:slug/refresh',    requireVault, refreshCity);

export default router;
