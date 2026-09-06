// Shared routine for the monthly city-graph + city-places re-fetch.
//
// Two callers share this code path:
//   • crons/cityGraphsMonthly.js — 1st of every month at 03:15 UTC (~08:45
//     IST, late night in the Americas → off-peak for Overpass mirrors).
//   • controllers/admin/cityGraphsCron.js — POST /api/admin/city-graphs/
//     cron/trigger for on-demand runs (vault-gated so anon visitors can't
//     spam Overpass).
//
// Behaviour:
//   • Iterates CITY_CATALOG in declaration order.
//   • For each city: fetchAndStoreCity(slug) → wait 6s → next city.
//     ↳ fetchAndStoreCity() itself calls ensurePlacesForCity() as a
//       secondary step, so we don't double-count places here.
//   • Between successful/failed cities we sleep ETIQUETTE_PAUSE_MS to
//     stay polite with Overpass — the mirrors 429 aggressively if you
//     hammer them in a tight loop.
//   • Failures NEVER abort the run. Each city is wrapped in try/catch so
//     one dead mirror at 3am doesn't skip the remaining cities. The
//     multi-mirror fallback inside fetchFromOverpass() catches most flakes;
//     what leaks through here is recorded and moved past.
//
// Idempotent by design — the underlying upsert (see controllers/cityGraphs
// /index.js) preserves `created_at` on conflict and touches `updated_at`
// on every write, so the row always reflects the latest successful pull.
//
// Return shape: { ok: [slug, ...], failed: [{slug, error}, ...], startedAt,
// finishedAt, durationMs } — same for cron and manual invocations so the
// admin trigger endpoint can echo it back verbatim.

import logger from '../../helpers/logger.js';
import {
  CITY_CATALOG,
  fetchAndStoreCity,
} from '../../controllers/cityGraphs/index.js';

// 6s between city hits. Overpass docs suggest 2s minimum between queries
// per source IP; we sit well above that so shared IPs (Oracle Cloud
// egress) don't get us blacklisted.
const ETIQUETTE_PAUSE_MS = 6000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Guard against overlapping runs. If the cron is still going when the
// admin trigger fires (unlikely — a full pass takes < 10 min — but
// possible on a bad Overpass day), the second caller just gets told
// "already running" instead of hammering the mirrors in parallel.
let running = false;

export function isCityGraphsCronRunning() {
  return running;
}

export async function runCityGraphsRefresh({ trigger = 'cron' } = {}) {
  if (running) {
    logger.warn(`city-graphs cron: refused — a previous ${trigger} run is still in flight`);
    return {
      skipped: true,
      reason: 'already-running',
      ok: [],
      failed: [],
    };
  }
  running = true;

  const startedAt = Date.now();
  const ok = [];
  const failed = [];

  logger.info(
    `city-graphs cron: starting ${trigger} run — ${CITY_CATALOG.length} cities, ` +
    `${ETIQUETTE_PAUSE_MS} ms between hits`,
  );

  try {
    for (let i = 0; i < CITY_CATALOG.length; i++) {
      const spec = CITY_CATALOG[i];
      const slug = spec.slug;
      const t0 = Date.now();
      logger.info(`city-graphs cron: (${i + 1}/${CITY_CATALOG.length}) fetching ${slug}`);
      try {
        // fetchAndStoreCity() upserts city_graphs AND internally calls
        // ensurePlacesForCity() (see controllers/cityGraphs/index.js) so
        // both the road-graph and the places catalogue land in one shot.
        // No separate places call needed here.
        await fetchAndStoreCity(slug);
        ok.push(slug);
        logger.info(`city-graphs cron: (${i + 1}/${CITY_CATALOG.length}) ok ${slug} in ${Date.now() - t0} ms`);
      } catch (err) {
        failed.push({ slug, error: err.message });
        logger.error(`city-graphs cron: (${i + 1}/${CITY_CATALOG.length}) FAILED ${slug}: ${err.message}`);
      }

      // Polite pause between hits — skip the wait after the last one so
      // the run doesn't linger for no reason.
      if (i < CITY_CATALOG.length - 1) {
        await sleep(ETIQUETTE_PAUSE_MS);
      }
    }
  } finally {
    running = false;
  }

  const finishedAt = Date.now();
  const durationMs = finishedAt - startedAt;
  logger.info(
    `city-graphs cron: ${trigger} run complete — ok=${ok.length} failed=${failed.length} ` +
    `in ${(durationMs / 1000).toFixed(1)}s`,
  );

  return {
    skipped: false,
    trigger,
    ok,
    failed,
    startedAt,
    finishedAt,
    durationMs,
  };
}
