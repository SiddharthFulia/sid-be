// Admin controller for the monthly city-graphs re-fetch cron.
//
//  · POST /api/admin/city-graphs/cron/trigger — fire the same routine the
//    monthly cron runs, on demand. Vault-gated at the route level.
//
// This handler awaits the full run, so the caller sees the completion
// summary in the response. On a fresh DB with all 10 cities that's up to
// ~90 s (~5-10 s per Overpass hit + 6 s etiquette pause). curl's default
// timeout is more than long enough; the FE admin panel bumps its fetch
// timeout separately.
//
// We picked "await + return summary" (vs "fire-and-forget + poll status")
// because the caller is always an admin who wants immediate feedback —
// there's no user-facing latency to protect here.

import {
  runCityGraphsRefresh,
  isCityGraphsCronRunning,
} from '../../services/cron/cityGraphs.js';

export async function postTriggerCityGraphsCron(_req, res) {
  if (isCityGraphsCronRunning()) {
    return res.status(409).json({
      ok: [],
      failed: [],
      running: true,
      message: 'city-graphs refresh already in flight — try again once it finishes',
    });
  }
  const result = await runCityGraphsRefresh({ trigger: 'manual' });
  // 200 even if a subset failed — the run itself completed. The caller
  // inspects `failed[]` to see which cities need attention.
  return res.status(200).json(result);
}
