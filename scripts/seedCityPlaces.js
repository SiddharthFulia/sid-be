// scripts/seedCityPlaces.js — one-shot preseeder for the area-search
// Trie's data source. Walks the CITY_CATALOG, fetches every metro's
// place / neighbourhood / landmark / building set from Overpass, and
// stores the rows in the city_places SQLite table.
//
//   node scripts/seedCityPlaces.js                       # seed every catalog city (skips already-seeded)
//   node scripts/seedCityPlaces.js bangalore             # seed just one
//   node scripts/seedCityPlaces.js --force               # re-seed even if present
//   node scripts/seedCityPlaces.js mumbai --force        # single city refresh
//   node scripts/seedCityPlaces.js --dry-run             # preview what would run
//   node scripts/seedCityPlaces.js mumbai --force --dry-run
//
// Idempotent — cities already seeded (>= MIN_PLACES rows) are skipped
// unless --force. Overpass gets a 6-second delay between hits per its
// public etiquette guidance.
//
// The Overpass query is now widened (Sep 2026) to include named
// buildings (apartments, hospitals, universities, malls, tech parks,
// schools, offices, libraries, theatres, cinemas) in addition to the
// original place / landmark set. Existing rows for a city are safe to
// leave — --force wipes the city's rows and re-seeds under the new
// query.

import { CITY_CATALOG, ensurePlacesForCity, fetchPlacesFromOverpass } from '../controllers/cityGraphs/index.js';
import { db } from '../services/aiVideo/db.js';
import logger from '../helpers/logger.js';

const args = process.argv.slice(2);
const force  = args.includes('--force');
const dryRun = args.includes('--dry-run');
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

// Roll up the kind distribution so operators can see whether the
// widened query is actually pulling in buildings (they should).
function summariseByKind(rows) {
  const counts = new Map();
  for (const r of rows) {
    counts.set(r.kind, (counts.get(r.kind) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k}=${n}`)
    .join(' ');
}

async function run() {
  logger.info(
    `seedCityPlaces: ${targets.length} target(s), force=${force}, dryRun=${dryRun}`,
  );
  let ok = 0, skipped = 0, failed = 0;
  for (const [i, spec] of targets.entries()) {
    const { n } = countStmt.get(spec.slug);
    if (n > 0 && !force) {
      logger.info(`  · [${i + 1}/${targets.length}] ${spec.slug} — ${n} places cached, skipping`);
      skipped++;
      continue;
    }
    try {
      if (dryRun) {
        // Dry-run: hit Overpass, report what WOULD be inserted, but do
        // not touch the DB at all. Useful for verifying the widened
        // query returns a reasonable spread of building kinds before
        // committing to a full 53-city reseed.
        const rows = await fetchPlacesFromOverpass(spec.bbox);
        const sample = rows.slice(0, 5).map((r) =>
          `${r.name} [${r.kind}]`,
        ).join(' | ');
        logger.info(
          `  ~ [${i + 1}/${targets.length}] ${spec.slug} — would insert ${rows.length} places ` +
          `(${summariseByKind(rows)}); sample: ${sample || '(none)'}`,
        );
        ok++;
      } else {
        const result = await ensurePlacesForCity(spec.slug, { force });
        // Peek at the freshly-inserted rows to log the kind spread.
        const summary = summariseByKind(
          db.prepare('SELECT kind FROM city_places WHERE city_slug = ?').all(spec.slug),
        );
        logger.info(
          `  ✓ [${i + 1}/${targets.length}] ${spec.slug} — ${result.count} places (${summary})`,
        );
        ok++;
      }
    } catch (err) {
      logger.error(`  ✗ [${i + 1}/${targets.length}] ${spec.slug} failed: ${err.message}`);
      failed++;
    }
    if (i < targets.length - 1) await sleep(6000);
  }
  logger.info(
    `seedCityPlaces: done — ok=${ok} skipped=${skipped} failed=${failed}` +
    (dryRun ? ' (dry-run, no DB writes)' : ''),
  );
  process.exit(failed && !ok ? 1 : 0);
}

run().catch((err) => {
  logger.error(`seedCityPlaces: fatal ${err.message}`);
  process.exit(1);
});
