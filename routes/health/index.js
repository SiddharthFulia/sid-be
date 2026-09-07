// /health, /stats — uptime + memory snapshots.
// /api-catalog — public list of every registered endpoint (no auth). Sits
// on this router because it's cheap discovery data with no secrets.

import { Router } from 'express';
import { getHealth, getStats } from '../../controllers/health/index.js';
import { API_CATALOG, countByCategory } from '../../services/apiCatalog/index.js';

const router = Router();

router.get('/health', getHealth);
router.get('/stats',  getStats);

// Public catalog. Users can see what's on offer; nothing sensitive is
// exposed (URL patterns only, never env values). Optional ?category=osint
// filter for lightweight client-side rendering.
router.get('/api-catalog', (req, res) => {
  const category = String(req.query.category || '').trim().toLowerCase();
  const entries = category
    ? API_CATALOG.filter(e => e.category === category)
    : API_CATALOG;
  res.json({
    total: entries.length,
    countByCategory: countByCategory(),
    entries,
  });
});

export default router;
