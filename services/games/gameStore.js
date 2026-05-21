// SQLite store for the Runner game (hand-gesture Subway-Surfers-style).
// Two tables — games_players (name registry, no auth) and games_scores
// (leaderboard). Schema lives in services/aiVideo/db.js so the existing
// migration runner picks it up on boot.

import { db } from '../aiVideo/db.js';

// ─── Players ───────────────────────────────────────────────────
// "pick existing or create new" → upsertPlayer is the canonical entry
// point. Case-insensitive UNIQUE(name) means "Siddharth" === "siddharth"
// so the user can't accidentally fork their own profile.
const insertPlayerStmt = db.prepare(
  `INSERT OR IGNORE INTO games_players (name, createdAt, lastPlayedAt)
   VALUES (@name, @createdAt, @lastPlayedAt)`
);
const selectPlayerByNameStmt = db.prepare(
  'SELECT * FROM games_players WHERE name = ? COLLATE NOCASE'
);
const selectPlayerByIdStmt = db.prepare(
  'SELECT * FROM games_players WHERE id = ?'
);
const updatePlayerLastPlayedStmt = db.prepare(
  'UPDATE games_players SET lastPlayedAt = ? WHERE id = ?'
);
const listPlayersStmt = db.prepare(
  `SELECT id, name, createdAt, lastPlayedAt
   FROM games_players
   ORDER BY (lastPlayedAt IS NULL) ASC, lastPlayedAt DESC, name ASC
   LIMIT ?`
);

export function upsertPlayer(name) {
  const clean = String(name || '').trim();
  if (!clean) return null;
  if (clean.length > 32) return null;
  const now = new Date().toISOString();
  insertPlayerStmt.run({ name: clean, createdAt: now, lastPlayedAt: now });
  return selectPlayerByNameStmt.get(clean);
}

export function getPlayerByName(name) {
  const clean = String(name || '').trim();
  if (!clean) return null;
  return selectPlayerByNameStmt.get(clean) || null;
}

export function getPlayerById(id) {
  return selectPlayerByIdStmt.get(id) || null;
}

export function touchPlayer(id) {
  updatePlayerLastPlayedStmt.run(new Date().toISOString(), id);
}

export function listPlayers(limit = 200) {
  const safe = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 500);
  return listPlayersStmt.all(safe);
}

// ─── Scores ────────────────────────────────────────────────────
const insertScoreStmt = db.prepare(
  `INSERT INTO games_scores
     (playerId, playerName, score, distance, difficulty, revived, createdAt)
   VALUES
     (@playerId, @playerName, @score, @distance, @difficulty, @revived, @createdAt)`
);

export function saveScore({ playerId, playerName, score, distance, difficulty, revived = false }) {
  const row = {
    playerId,
    playerName,
    score: Math.max(0, Math.floor(score || 0)),
    distance: Math.max(0, Math.floor(distance || 0)),
    difficulty: ['easy', 'medium', 'hard', 'classic'].includes(difficulty) ? difficulty : 'classic',
    revived: revived ? 1 : 0,
    createdAt: new Date().toISOString(),
  };
  const info = insertScoreStmt.run(row);
  touchPlayer(playerId);
  return { id: info.lastInsertRowid, ...row };
}

// Top-N all-time, or top-N for a specific difficulty if passed.
export function leaderboard({ difficulty, limit = 50 } = {}) {
  const safe = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  if (difficulty && ['easy', 'medium', 'hard', 'classic'].includes(difficulty)) {
    return db.prepare(
      `SELECT id, playerId, playerName, score, distance, difficulty, revived, createdAt
       FROM games_scores
       WHERE difficulty = ?
       ORDER BY score DESC, createdAt ASC
       LIMIT ?`
    ).all(difficulty, safe);
  }
  return db.prepare(
    `SELECT id, playerId, playerName, score, distance, difficulty, revived, createdAt
     FROM games_scores
     ORDER BY score DESC, createdAt ASC
     LIMIT ?`
  ).all(safe);
}

// Personal-best per difficulty for a given player. Used by the start
// screen so the user sees "you previously hit 1240 on Hard" before they
// pick their difficulty.
export function getPlayerBests(playerId) {
  return db.prepare(
    `SELECT difficulty, MAX(score) AS best, MAX(distance) AS farthest, COUNT(*) AS runs
     FROM games_scores
     WHERE playerId = ?
     GROUP BY difficulty`
  ).all(playerId);
}
