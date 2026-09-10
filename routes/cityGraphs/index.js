// /city-graphs/* — SQLite-backed road graph cache for the Pathfinding lab.
//
// Public reads (list + get). Vault-gated refresh so random visitors
// can't spam Overpass. See controllers/cityGraphs/index.js for the
// storage + rate-limit rationale.

import { Router } from 'express';
import { requireVault } from '../../services/auth/vault.js';
import {
  listCities, getCity, refreshCity, searchPlaces, searchPlacesAll,
  getCityMeta, getCityGraphBlob, getStats, getCityLabels,
} from '../../controllers/cityGraphs/index.js';

const router = Router();

router.get( '/city-graphs',                       listCities);
// NOTE — order matters. Fixed segments (/stats, /places, /:slug/places,
// /:slug/labels, /:slug/meta, /:slug/graph.json.gz) must come BEFORE the
// bare /:slug route or Express will swallow the trailing segment into
// the :slug param.
router.get( '/city-graphs/stats',                 getStats);
router.get( '/city-graphs/places',                searchPlacesAll);
router.get( '/city-graphs/:slug/labels',          getCityLabels);
router.get( '/city-graphs/:slug/places',          searchPlaces);
router.get( '/city-graphs/:slug/meta',            getCityMeta);
router.get( '/city-graphs/:slug/graph.json.gz',   getCityGraphBlob);
router.get( '/city-graphs/:slug',                 getCity);
router.post('/city-graphs/:slug/refresh',         requireVault, refreshCity);

export default router;
