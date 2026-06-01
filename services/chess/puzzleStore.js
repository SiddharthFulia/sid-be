// SQLite store for the Chess Puzzles feature.
//
// Three tables sit alongside the existing chess_games / chess_matches lane:
//   chess_puzzles          — the imported lichess library (read-mostly)
//   chess_puzzle_users     — one row per nickname playing puzzles
//   chess_puzzle_attempts  — every success/fail with rating delta applied
//
// Rating brackets per difficulty are computed off the user's current rating
// at fetch time — fixing a bracket once at puzzle-creation would defeat the
// "always tougher than what you're rated" promise.

import { db } from '../aiVideo/db.js';

// ── Schema ─────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS chess_puzzles (
    puzzle_id     TEXT PRIMARY KEY,
    fen           TEXT NOT NULL,
    moves         TEXT NOT NULL,          -- space-separated UCI solution moves
    rating        INTEGER NOT NULL,
    popularity    INTEGER,
    nb_plays      INTEGER,
    themes        TEXT,                   -- space-separated theme tags
    game_url      TEXT,
    opening_tags  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_puzzles_rating ON chess_puzzles(rating);
  CREATE INDEX IF NOT EXISTS idx_puzzles_themes ON chess_puzzles(themes);

  CREATE TABLE IF NOT EXISTS chess_puzzle_users (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL UNIQUE,
    rating          INTEGER NOT NULL DEFAULT 1000,
    solved_count    INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL,
    last_active_at  INTEGER
  );

  CREATE TABLE IF NOT EXISTS chess_puzzle_attempts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL REFERENCES chess_puzzle_users(id) ON DELETE CASCADE,
    puzzle_id     TEXT    NOT NULL,
    success       INTEGER NOT NULL,        -- 0 / 1
    attempts_used INTEGER NOT NULL DEFAULT 1,
    rating_delta  INTEGER NOT NULL,        -- signed; applied to user.rating
    viewed_solution INTEGER NOT NULL DEFAULT 0,
    difficulty    TEXT,                    -- 'easy' | 'medium' | 'hard'
    created_at    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_attempts_user_success ON chess_puzzle_attempts(user_id, success);
  CREATE INDEX IF NOT EXISTS idx_attempts_user_puzzle  ON chess_puzzle_attempts(user_id, puzzle_id);
`);

// ── Difficulty brackets (offset from the user's CURRENT rating) ────
// User's rating is the FLOOR. Easy is the gentle stretch; hard is the wall.
// Lower-bound is +1 on every tier so we never serve a puzzle below the user.
export const DIFFICULTY_BRACKETS = {
  easy:   { min: 1,   max: 100 },
  medium: { min: 200, max: 400 },
  hard:   { min: 500, max: 800 },
};

// Points table. retry = won on the 2nd or 3rd try (still positive, smaller).
export const POINTS = {
  easy:   { win: 15, loss: -10, retryWin: -5 },
  medium: { win: 25, loss: -15, retryWin: -10 },
  hard:   { win: 40, loss: -20, retryWin: -15 },
};

// ── Bulk puzzle insert (used by the import script) ─────────────────
// Wrapped in a single transaction so a 100k insert stays under ~5s on
// commodity SSDs. Skips dupes via INSERT OR IGNORE — re-running the
// script just no-ops on rows that already exist.
const insertPuzzleStmt = db.prepare(`
  INSERT OR IGNORE INTO chess_puzzles
    (puzzle_id, fen, moves, rating, popularity, nb_plays, themes, game_url, opening_tags)
  VALUES (@puzzle_id, @fen, @moves, @rating, @popularity, @nb_plays, @themes, @game_url, @opening_tags)
`);
export const insertPuzzlesTx = db.transaction((rows) => {
  let inserted = 0;
  for (const r of rows) {
    const info = insertPuzzleStmt.run(r);
    inserted += info.changes;
  }
  return inserted;
});

export function puzzlesCount() {
  return db.prepare('SELECT COUNT(*) AS c FROM chess_puzzles').get().c;
}

// ── User management ────────────────────────────────────────────────
export function listPuzzleUsers() {
  return db.prepare(`
    SELECT id, name, rating, solved_count, created_at, last_active_at
    FROM chess_puzzle_users
    ORDER BY last_active_at DESC NULLS LAST, created_at DESC
  `).all();
}

export function getPuzzleUser(id) {
  return db.prepare('SELECT * FROM chess_puzzle_users WHERE id = ?').get(id) || null;
}

export function getPuzzleUserByName(name) {
  return db.prepare('SELECT * FROM chess_puzzle_users WHERE name = ?').get(name) || null;
}

export function createPuzzleUser(name) {
  const now = Date.now();
  const info = db.prepare(`
    INSERT INTO chess_puzzle_users (name, rating, solved_count, created_at, last_active_at)
    VALUES (?, 1000, 0, ?, ?)
  `).run(name, now, now);
  return getPuzzleUser(info.lastInsertRowid);
}

export function deletePuzzleUser(id) {
  return db.prepare('DELETE FROM chess_puzzle_users WHERE id = ?').run(id).changes > 0;
}

function bumpLastActive(userId) {
  db.prepare('UPDATE chess_puzzle_users SET last_active_at = ? WHERE id = ?').run(Date.now(), userId);
}

// ── Puzzle selection ───────────────────────────────────────────────
// Random pick within rating bracket, EXCLUDING puzzles the user already
// won on. We allow failed-but-not-won puzzles to come back — that's how
// the user gets a second crack at lessons they bungled.
//
// SQL note: `ORDER BY RANDOM() LIMIT 1` is correct for this load (one
// row out of ~100k); SQLite scans the rating-index range then sorts
// the bucket. No detectable pattern client-side.
export function pickNextPuzzle({ userId, difficulty }) {
  const user = getPuzzleUser(userId);
  if (!user) return null;
  const bracket = DIFFICULTY_BRACKETS[difficulty] || DIFFICULTY_BRACKETS.easy;
  const minRating = user.rating + bracket.min;
  const maxRating = user.rating + bracket.max;

  // Pull one puzzle in the bracket, not yet SOLVED by this user.
  // (We let the user retry failed puzzles by filtering only on success=1.)
  const row = db.prepare(`
    SELECT p.*
    FROM chess_puzzles p
    WHERE p.rating BETWEEN ? AND ?
      AND p.puzzle_id NOT IN (
        SELECT puzzle_id FROM chess_puzzle_attempts
        WHERE user_id = ? AND success = 1
      )
    ORDER BY RANDOM()
    LIMIT 1
  `).get(minRating, maxRating, userId);

  if (!row) {
    // Bracket dry — relax max upward in 200-rating chunks until we find one.
    // Beats showing "no puzzles available" because the user is on the
    // hard-rating frontier of the imported subset.
    for (let bump = 200; bump <= 1500; bump += 200) {
      const widened = db.prepare(`
        SELECT p.* FROM chess_puzzles p
        WHERE p.rating BETWEEN ? AND ?
          AND p.puzzle_id NOT IN (
            SELECT puzzle_id FROM chess_puzzle_attempts
            WHERE user_id = ? AND success = 1
          )
        ORDER BY RANDOM() LIMIT 1
      `).get(minRating, maxRating + bump, userId);
      if (widened) return widened;
    }
    return null;
  }
  return row;
}

export function getPuzzleById(puzzleId) {
  return db.prepare('SELECT * FROM chess_puzzles WHERE puzzle_id = ?').get(puzzleId) || null;
}

// ── Attempt recording + rating apply ───────────────────────────────
// Single transaction: insert the attempt row, bump user.rating, bump
// solved_count if it was a fresh win, refresh last_active_at. Returns
// the updated user.
export function recordAttempt({ userId, puzzleId, success, attemptsUsed, viewedSolution, difficulty }) {
  const user = getPuzzleUser(userId);
  if (!user) throw new Error('user not found');
  const table = POINTS[difficulty] || POINTS.easy;

  // Rating delta logic:
  //   viewedSolution before solving  → counts as a full loss (table.loss)
  //   solved on 1st try              → table.win
  //   solved on retry (attemptsUsed>1) → table.retryWin
  //   used all 3 tries and still failed → table.loss
  let delta;
  if (viewedSolution && !success) delta = table.loss;
  else if (success && attemptsUsed === 1) delta = table.win;
  else if (success && attemptsUsed > 1)   delta = table.retryWin;
  else                                     delta = table.loss;

  const newRating = Math.max(100, user.rating + delta); // floor at 100

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO chess_puzzle_attempts
        (user_id, puzzle_id, success, attempts_used, rating_delta, viewed_solution, difficulty, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      userId, puzzleId,
      success ? 1 : 0,
      attemptsUsed,
      delta,
      viewedSolution ? 1 : 0,
      difficulty || null,
      Date.now(),
    );
    db.prepare(`
      UPDATE chess_puzzle_users
      SET rating = ?,
          solved_count = solved_count + ?,
          last_active_at = ?
      WHERE id = ?
    `).run(newRating, success ? 1 : 0, Date.now(), userId);
  });
  tx();

  return { user: getPuzzleUser(userId), ratingDelta: delta };
}

export function listRecentAttempts(userId, limit = 10) {
  return db.prepare(`
    SELECT a.*, p.rating AS puzzle_rating, p.themes
    FROM chess_puzzle_attempts a
    LEFT JOIN chess_puzzles p ON p.puzzle_id = a.puzzle_id
    WHERE a.user_id = ?
    ORDER BY a.created_at DESC
    LIMIT ?
  `).all(userId, Math.min(Math.max(parseInt(limit, 10) || 10, 1), 100));
}

export function getPuzzleStats(userId) {
  const user = getPuzzleUser(userId);
  if (!user) return null;
  const totalAvailable = puzzlesCount();
  const recent = listRecentAttempts(userId, 10);
  // Mark last_active for the dropdown's "active recently" sort.
  bumpLastActive(userId);
  return {
    userId: user.id,
    name: user.name,
    rating: user.rating,
    solvedCount: user.solved_count,
    totalAvailable,
    lastAttempts: recent,
  };
}
