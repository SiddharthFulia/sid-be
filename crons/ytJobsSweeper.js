// Daily sweep for the yt_jobs table + its on-disk files.
//
// Terminal rows (completed | failed) older than 48 hours get pruned,
// and the corresponding MP3/MP4 on disk is unlinked. Keeps the
// downloads dir from ballooning indefinitely.
//
// Schedule: 04:30 Asia/Kolkata (sweepers staggered to avoid stepping on
// each other during midnight).

import fs from 'fs';
import logger from '../helpers/logger.js';
import { listExpiredJobs, deleteJob } from '../services/ytdl/store.js';

function run() {
  try {
    const expired = listExpiredJobs(48);
    let unlinked = 0;
    for (const row of expired) {
      if (row.filePath) {
        try { fs.unlinkSync(row.filePath); unlinked++; } catch {}
      }
      deleteJob(row.id);
    }
    logger.info(`yt_jobs sweep: rows=${expired.length}, files=${unlinked}`);
  } catch (err) {
    logger.error(`yt_jobs sweep failed: ${err.message}`);
  }
}

export default {
  name: 'yt_jobs_sweeper',
  schedule: '30 4 * * *',          // every day at 04:30
  handler: run,
};
