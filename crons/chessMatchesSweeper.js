// Daily sweeper for the chess_matches table. Runs once at midnight
// (Asia/Kolkata — set by master_cron_server.js) and deletes:
//
//   1. Pure-noise aborts (status='aborted' AND moveCount=0): both tabs
//      bailed before anyone made a move. No PGN value, no library copy
//      was created. Hard-delete after 10 minutes so the user's redirect
//      countdown finishes cleanly.
//
//   2. Any terminal match (completed | aborted) older than 24 hours:
//      the game lives forever in chess_games (live matches with ≥1 move
//      auto-copy on termination, see controllers/v1/chess.js), so the
//      chess_matches row is just URL plumbing past day +1. After 24h
//      the /chess/m/<id> URL falls back to a clean 404.
//
// Absolute-timestamp comparison (completedAt < now - 24h) — not
// "delete everything at midnight" — so a match that ends at 23:59 isn't
// killed the same night. It survives until the NEXT midnight sweep.
//
// Schema reminder: chess_matches.completedAt is an ISO string written by
// the controller on every status transition. SQLite's datetime('now',
// '-24 hours') returns the canonical 'YYYY-MM-DD HH:MM:SS' shape; an ISO
// string lexicographically compares correctly against it for our range.

import { db } from '../services/aiVideo/db.js';
import logger from '../helpers/logger.js';

const NOISE_TTL = '-10 minutes';
const REAL_TTL  = '-24 hours';

function run() {
  try {
    const noise = db.prepare(`
      DELETE FROM chess_matches
      WHERE status = 'aborted'
        AND moveCount = 0
        AND completedAt IS NOT NULL
        AND completedAt < datetime('now', ?)
    `).run(NOISE_TTL);

    const expired = db.prepare(`
      DELETE FROM chess_matches
      WHERE status IN ('completed', 'aborted')
        AND completedAt IS NOT NULL
        AND completedAt < datetime('now', ?)
    `).run(REAL_TTL);

    logger.info(
      `chess_matches sweep: noise=${noise.changes}, expired=${expired.changes}`
    );
  } catch (err) {
    logger.error(`chess_matches sweep failed: ${err.message}`);
  }
}

export default {
  name: 'chess_matches_sweeper',
  // Daily at 00:00. master_cron_server.js applies the timezone.
  schedule: '0 0 * * *',
  handler: run,
};
