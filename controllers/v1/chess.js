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
