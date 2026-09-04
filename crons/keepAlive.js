// Nightly keep-alive publisher. Runs at 00:00 IST every day.
//
// The CloudAMQP / LavinMQ free tiers delete instances that stay idle for 90
// days. This cron guarantees the broker sees ONE message per day even when
// nobody's using the site → the timer never expires.
//
// The consumer lives in services/keepAlive/index.js and is started at boot
// by server.js. The message it consumes does a shallow health check
// (/api/health + /api/stats) and records the outcome so the admin panel can
// show the last N runs.

import { publishKeepAliveJob } from '../services/keepAlive/index.js';
import logger from '../helpers/logger.js';

async function run() {
  const ok = await publishKeepAliveJob('cron');
  if (!ok) {
    logger.warn('keep-alive cron: publish failed (broker unreachable?)');
  }
}

export default {
  name: 'keep_alive',
  // Daily at 00:00 IST. master_cron_server.js applies the timezone.
  schedule: '0 0 * * *',
  handler: run,
};
