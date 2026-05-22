// Master cron registrar. Auto-loads every *.js file under ./crons/, each
// exporting `{ name, schedule, handler }` as default, and registers them
// with node-cron under a single fixed timezone (Asia/Kolkata).
//
// Why this lives inside the BE process (and not its own PM2 entry):
//   • One process = one logger + one DB connection + one place to debug.
//   • node-cron's scheduler is cheap (a single setTimeout per job, re-
//     armed each fire), so it doesn't fight the request loop.
//   • A PM2 restart cleanly tears down + re-registers everything on boot.
//
// Adding a new job: drop a file into ./crons/ that default-exports the
// trio. No edit here required.

import cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import logger from './helpers/logger.js';

const CRON_TZ = process.env.CRON_TZ || 'Asia/Kolkata';
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const CRONS_DIR  = path.join(__dirname, 'crons');

export async function startCrons() {
  if (!fs.existsSync(CRONS_DIR)) {
    logger.info('No crons/ directory — skipping cron registration.');
    return [];
  }

  const files = fs.readdirSync(CRONS_DIR).filter(f => f.endsWith('.js'));
  const registered = [];

  for (const f of files) {
    try {
      // pathToFileURL needed on Windows so the dynamic import resolves
      // (file:// scheme, not a bare absolute path).
      const mod = await import(pathToFileURL(path.join(CRONS_DIR, f)).href);
      const job = mod.default;
      if (!job || !job.name || !job.schedule || typeof job.handler !== 'function') {
        logger.warn(`crons/${f}: invalid export — expected { name, schedule, handler }`);
        continue;
      }
      if (!cron.validate(job.schedule)) {
        logger.warn(`crons/${f}: invalid schedule "${job.schedule}"`);
        continue;
      }
      cron.schedule(job.schedule, job.handler, { timezone: CRON_TZ });
      registered.push({ name: job.name, schedule: job.schedule });
      logger.info(`cron registered: ${job.name} @ "${job.schedule}" (${CRON_TZ})`);
    } catch (err) {
      logger.error(`failed to load crons/${f}: ${err.message}`);
    }
  }

  logger.info(`crons online: ${registered.length}`);
  return registered;
}
