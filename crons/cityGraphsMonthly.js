// Monthly re-fetch of every city road-graph + every city places catalogue.
//
// Schedule: 1st of every month at 03:15 UTC.
//   • 03:15 UTC  ≈ 08:45 IST (comfortable morning window on our side)
//   • 03:15 UTC  ≈ 22:15 PST / 23:15 EST prev day (late night in the
//     Americas — off-peak for the public Overpass mirrors, which are
//     hosted mostly in Europe + North America and get hammered during
//     US-daytime hours).
//
// We deliberately override the process-wide CRON_TZ (Asia/Kolkata) with
// UTC here so this schedule is stable regardless of what timezone the
// Oracle VM boots in. master_cron_server.js reads the per-job `timezone`
// export and applies it.
//
// The actual work lives in services/cron/cityGraphs.js so the admin
// manual-trigger endpoint can call the exact same routine without
// duplicating the iteration + rate-limit logic.

import logger from '../helpers/logger.js';
import { runCityGraphsRefresh } from '../services/cron/cityGraphs.js';

async function run() {
  try {
    await runCityGraphsRefresh({ trigger: 'cron' });
  } catch (err) {
    // The routine itself catches per-city errors; anything that reaches
    // here is a boot / import failure. Log + swallow so the cron scheduler
    // keeps its future firings alive.
    logger.error(`city-graphs monthly cron: unexpected failure — ${err.message}`);
  }
}

export default {
  name: 'city_graphs_monthly',
  // "min hour day-of-month month day-of-week" → 03:15 on day 1 of every month.
  schedule: '15 3 1 * *',
  // Explicit UTC override — see file header for why.
  timezone: 'UTC',
  handler: run,
};
