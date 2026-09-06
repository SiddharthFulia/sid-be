// scripts/seedCityGraphs.js — one-shot preseeder.
//
//   node scripts/seedCityGraphs.js              # seed all 10 metros
//   node scripts/seedCityGraphs.js bangalore    # seed just one
//   node scripts/seedCityGraphs.js --force      # re-fetch even if cached
//
// Walks the CITY_CATALOG, fetches each city's road graph from Overpass,
// gzips it, and stores it in the `city_graphs` SQLite table. Politely
// waits 6 s between hits so Overpass doesn't rate-limit us.
//
// Safe to run repeatedly — cities already cached are skipped unless
// --force is set. Failures don't abort the whole run: we log + move on.

import { CITY_CATALOG, fetchAndStoreCity } from '../controllers/cityGraphs/index.js';
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

async function run() {
  logger.info(`seedCityGraphs: ${targets.length} target(s), force=${force}`);
  let ok = 0, skipped = 0, failed = 0;
  for (const [i, spec] of targets.entries()) {
    const existing = db.prepare('SELECT slug, fetched_at, node_count FROM city_graphs WHERE slug = ?').get(spec.slug);
    if (existing && !force) {
      logger.info(`  · [${i + 1}/${targets.length}] ${spec.slug} — already cached (${existing.node_count} nodes), skipping`);
      skipped++;
      continue;
    }
    try {
      const meta = await fetchAndStoreCity(spec.slug);
      logger.info(`  ✓ [${i + 1}/${targets.length}] ${spec.slug} — ${meta.node_count} nodes, ${meta.edge_count} edges, ${Math.round(meta.bytes / 1024)} KB`);
      ok++;
    } catch (err) {
      logger.error(`  ✗ [${i + 1}/${targets.length}] ${spec.slug} failed: ${err.message}`);
      failed++;
    }
    // Overpass etiquette — throttle between requests. Only when we actually
    // hit the network; skipped cities don't need the pause.
    if (i < targets.length - 1) await sleep(6000);
  }
  logger.info(`seedCityGraphs: done — ok=${ok} skipped=${skipped} failed=${failed}`);
  process.exit(failed && !ok ? 1 : 0);
}

run().catch((err) => {
  logger.error(`seedCityGraphs: fatal ${err.message}`);
  process.exit(1);
});
