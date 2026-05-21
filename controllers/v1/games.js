// Runner game endpoints — players + scoreboard. No auth (single-game
// portfolio toy); the only sanity check is name length + difficulty
// whitelist. Rate-limit relies on the global `app.js` budget.

import { success, error } from '../../helpers/res_helper.js';
import logger from '../../helpers/logger.js';
import {
  upsertPlayer, getPlayerByName, getPlayerById, listPlayers,
  saveScore, leaderboard, getPlayerBests,
} from '../../services/games/gameStore.js';

const DIFFS = new Set(['easy', 'medium', 'hard', 'classic']);
const MAX_NAME = 32;
const MAX_SCORE = 9_999_999;       // absurd cap so a runaway client can't poison the board
const MAX_DISTANCE = 99_999_999;

// GET /api/games/players?limit=200
export const getPlayers = (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 200;
    const items = listPlayers(limit);
    return success(res, { items, total: items.length });
  } catch (err) {
    logger.error('games getPlayers failed', err.message);
    return error(res, err.message);
  }
};

// POST /api/games/players { name }
// Idempotent — if a player with that case-insensitive name exists, returns
// the existing row instead of creating a duplicate.
export const postPlayer = (req, res) => {
  try {
    const raw = req.body?.name;
    const name = String(raw || '').trim();
    if (!name) return error(res, 'name is required', 400);
    if (name.length > MAX_NAME) return error(res, `name must be ≤ ${MAX_NAME} chars`, 400);

    const player = upsertPlayer(name);
    if (!player) return error(res, 'could not create player', 500);

    const bests = getPlayerBests(player.id);
    return success(res, { player, bests });
  } catch (err) {
    logger.error('games postPlayer failed', err.message);
    return error(res, err.message);
  }
};

// GET /api/games/players/:idOrName  (idOrName is integer → id lookup, else name)
export const getPlayer = (req, res) => {
  try {
    const key = req.params.idOrName;
    const numeric = /^\d+$/.test(String(key));
    const player = numeric
      ? getPlayerById(parseInt(key, 10))
      : getPlayerByName(key);
    if (!player) return error(res, 'player not found', 404);
    const bests = getPlayerBests(player.id);
    return success(res, { player, bests });
  } catch (err) {
    logger.error('games getPlayer failed', err.message);
    return error(res, err.message);
  }
};

// POST /api/games/scores { playerName, score, distance, difficulty, revived? }
// playerName is upserted automatically — caller doesn't need to call
// POST /players first. We tolerate either playerId OR playerName for
// flexibility but prefer playerName since the FE knows it.
export const postScore = (req, res) => {
  try {
    const {
      playerName: rawName, playerId: rawId,
      score, distance, difficulty,
      revived = false,
    } = req.body || {};

    // Resolve player by name (canonical) or id (fallback)
    let player = null;
    if (rawName) {
      const name = String(rawName).trim();
      if (!name) return error(res, 'playerName is required', 400);
      if (name.length > MAX_NAME) return error(res, `playerName too long (max ${MAX_NAME})`, 400);
      player = upsertPlayer(name);
    } else if (rawId) {
      player = getPlayerById(parseInt(rawId, 10));
    }
    if (!player) return error(res, 'playerName or valid playerId is required', 400);

    // Validate numbers
    const s = parseInt(score, 10);
    const d = parseInt(distance, 10);
    if (!Number.isFinite(s) || s < 0 || s > MAX_SCORE)    return error(res, `score must be 0..${MAX_SCORE}`, 400);
    if (!Number.isFinite(d) || d < 0 || d > MAX_DISTANCE) return error(res, `distance must be 0..${MAX_DISTANCE}`, 400);
    if (!DIFFS.has(difficulty)) return error(res, "difficulty must be 'easy' | 'medium' | 'hard' | 'classic'", 400);

    const saved = saveScore({
      playerId: player.id,
      playerName: player.name,
      score: s, distance: d, difficulty,
      revived: !!revived,
    });
    logger.info(`GAME SCORE | ${player.name} | ${difficulty} | ${s} pts / ${d} m${revived ? ' (revived)' : ''}`);

    return success(res, { saved, playerId: player.id, playerName: player.name });
  } catch (err) {
    logger.error('games postScore failed', err.message);
    return error(res, err.message);
  }
};

// GET /api/games/scores?difficulty=&limit=
//   difficulty omitted ⇒ all-time top-N across modes.
//   difficulty in set ⇒ top-N for that mode only.
export const getScores = (req, res) => {
  try {
    const { difficulty } = req.query;
    const limit = parseInt(req.query.limit, 10) || 50;
    const items = leaderboard({
      difficulty: typeof difficulty === 'string' && DIFFS.has(difficulty) ? difficulty : undefined,
      limit,
    });
    return success(res, { items, total: items.length });
  } catch (err) {
    logger.error('games getScores failed', err.message);
    return error(res, err.message);
  }
};
