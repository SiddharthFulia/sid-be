// scripts/seedCityPlaces.js — one-shot preseeder for the area-search
// Trie's data source. Walks the CITY_CATALOG, fetches every metro's
// place / neighbourhood / landmark set from Overpass, and stores the
// rows in the city_places SQLite table.
//
//   node scripts/seedCityPlaces.js               # seed all 10 metros
//   node scripts/seedCityPlaces.js bangalore     # seed just one
//   node scripts/seedCityPlaces.js --force       # re-seed even if present
//
// Idempotent — cities already seeded (>= MIN_PLACES rows) are skipped
// unless --force. Overpass gets a 6-second delay between hits per its
// public etiquette guidance.

import { CITY_CATALOG, ensurePlacesForCity } from '../controllers/cityGraphs/index.js';
import { db } from '../services/aiVideo/db.js';
import logger from '../helpers/logger.js';

const args = process.argv.slice(2);
const force = args.includes('--force');
const onlySlugs = args.filter((a) => !a.startsWith('--'));

const targets = onlySlugs.length
  ? CITY_CATALOG.filter((c) => onlySlugs.includes(c.slug))
  : CITY_CATALOG;

if (!targets.length) {
  console.error('No matching cities.');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const countStmt = db.prepare('SELECT COUNT(*) AS n FROM city_places WHERE city_slug = ?');

async function run() {
  logger.info(`seedCityPlaces: ${targets.length} target(s), force=${force}`);
  let ok = 0, skipped = 0, failed = 0;
  for (const [i, spec] of targets.entries()) {
    const { n } = countStmt.get(spec.slug);
    if (n > 0 && !force) {
      logger.info(`  · [${i + 1}/${targets.length}] ${spec.slug} — ${n} places cached, skipping`);
      skipped++;
      continue;
    }
    try {
      const result = await ensurePlacesForCity(spec.slug, { force });
      logger.info(`  ✓ [${i + 1}/${targets.length}] ${spec.slug} — ${result.count} places`);
      ok++;
    } catch (err) {
      logger.error(`  ✗ [${i + 1}/${targets.length}] ${spec.slug} failed: ${err.message}`);
      failed++;
    }
    if (i < targets.length - 1) await sleep(6000);
  }
  logger.info(`seedCityPlaces: done — ok=${ok} skipped=${skipped} failed=${failed}`);
  process.exit(failed && !ok ? 1 : 0);
}

run().catch((err) => {
  logger.error(`seedCityPlaces: fatal ${err.message}`);
  process.exit(1);
});
