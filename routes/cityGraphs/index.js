// /city-graphs/* — SQLite-backed road graph cache for the Pathfinding lab.
//
// Public reads (list + get). Vault-gated refresh so random visitors
// can't spam Overpass. See controllers/cityGraphs/index.js for the
// storage + rate-limit rationale.

import { Router } from 'express';
import { requireVault } from '../../services/auth/vault.js';
import {
  listCities, getCity, refreshCity, searchPlaces,
} from '../../controllers/cityGraphs/index.js';

const router = Router();

router.get( '/city-graphs',                  listCities);
// NOTE — /places must come BEFORE the bare /:slug route or Express will
// swallow the "/places" segment into the :slug param.
router.get( '/city-graphs/:slug/places',     searchPlaces);
router.get( '/city-graphs/:slug',            getCity);
router.post('/city-graphs/:slug/refresh',    requireVault, refreshCity);

export default router;
