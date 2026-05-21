// Chess endpoints — thin wrappers around services/chess/engine.js.
//
//   POST /api/chess/best-move  { fen, depth?, thinkMs? }
//   POST /api/chess/analyze    { fen, multiPv?, depth?, thinkMs? }
//   POST /api/chess/play       { fen, elo? }
//   GET  /api/chess/status     — engine binary diagnostic
//
// All endpoints are public (no Vault). FEN validation is minimal (string
// + 6 whitespace-separated tokens) — Stockfish itself rejects garbage
// FENs cleanly, so we let it.

import { success, error } from '../../helpers/res_helper.js';
import logger from '../../helpers/logger.js';
import { bestMove, analyze, play, engineStatus } from '../../services/chess/engine.js';
import { createGame, getGame, updateGame, deleteGame, listGames } from '../../services/chess/gameStore.js';

const FEN_MIN_TOKENS = 4;   // some PGN exports omit halfmove/fullmove

function validateFen(fen) {
  if (typeof fen !== 'string') return 'fen must be a string';
  const tokens = fen.trim().split(/\s+/);
  if (tokens.length < FEN_MIN_TOKENS) return 'fen looks malformed (expected board + side + castle + ep [+ halfmove + fullmove])';
  if (!/^[1-8KQRBNPkqrbnp/]+$/.test(tokens[0])) return 'fen board has invalid characters';
  if (!/^[wb]$/.test(tokens[1])) return 'fen side-to-move must be w or b';
  return null;
}

export const postBestMove = async (req, res) => {
  try {
    const { fen, depth, thinkMs } = req.body || {};
    const verr = validateFen(fen);
    if (verr) return error(res, verr, 400);
    const out = await bestMove({ fen, depth, thinkMs });
    return success(res, out);
  } catch (err) {
    logger.error('chess bestMove failed', err.message);
    return error(res, err.message, 503);
  }
};

export const postAnalyze = async (req, res) => {
  try {
    const { fen, multiPv, depth, thinkMs } = req.body || {};
    const verr = validateFen(fen);
    if (verr) return error(res, verr, 400);
    const out = await analyze({ fen, multiPv, depth, thinkMs });
    return success(res, out);
  } catch (err) {
    logger.error('chess analyze failed', err.message);
    return error(res, err.message, 503);
  }
};

export const postPlay = async (req, res) => {
  try {
    const { fen, elo, thinkMs } = req.body || {};
    const verr = validateFen(fen);
    if (verr) return error(res, verr, 400);
    const out = await play({ fen, elo, thinkMs });
    return success(res, out);
  } catch (err) {
    logger.error('chess play failed', err.message);
    return error(res, err.message, 503);
  }
};

export const getStatus = (_req, res) => success(res, engineStatus());

// ─── Saved games library (Lichess-style) ─────────────────────────────
// POST /api/chess/games — create
// GET  /api/chess/games — list
// GET  /api/chess/games/:id — load
// PATCH /api/chess/games/:id — rename / autosave updates
// DELETE /api/chess/games/:id — drop

const NAME_MAX = 80;

export const postSaveGame = (req, res) => {
  try {
    const { name, pgn, fen, side, mode, engineName, engineType, engineStrength, timeControl, result, moveCount } = req.body || {};
    if (typeof pgn !== 'string') return error(res, 'pgn is required', 400);
    if (typeof fen !== 'string' || !fen.trim()) return error(res, 'fen is required', 400);
    if (name && String(name).length > NAME_MAX) return error(res, `name too long (max ${NAME_MAX} chars)`, 400);
    const row = createGame({
      name: name ? String(name).trim() : undefined,
      pgn, fen, side, mode, engineName, engineType, engineStrength, timeControl, result, moveCount,
    });
    return success(res, row);
  } catch (err) {
    logger.error('chess saveGame failed', err.message);
    return error(res, err.message);
  }
};

export const getGames = (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 50;
    const result = typeof req.query.result === 'string' ? req.query.result : undefined;
    const items = listGames({ limit, result });
    return success(res, { items, total: items.length });
  } catch (err) {
    logger.error('chess getGames failed', err.message);
    return error(res, err.message);
  }
};

export const getOneGame = (req, res) => {
  const row = getGame(parseInt(req.params.id, 10));
  if (!row) return error(res, 'game not found', 404);
  return success(res, row);
};

export const patchGame = (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const patch = req.body || {};
    if (patch.name && String(patch.name).length > NAME_MAX) {
      return error(res, `name too long (max ${NAME_MAX} chars)`, 400);
    }
    const row = updateGame(id, patch);
    if (!row) return error(res, 'game not found', 404);
    return success(res, row);
  } catch (err) {
    logger.error('chess patchGame failed', err.message);
    return error(res, err.message);
  }
};

export const removeGame = (req, res) => {
  const id = parseInt(req.params.id, 10);
  const ok = deleteGame(id);
  if (!ok) return error(res, 'game not found', 404);
  return success(res, { ok: true });
};
