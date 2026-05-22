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
import { Chess } from 'chess.js';
import { bestMove, analyze, play, engineStatus } from '../../services/chess/engine.js';
import { createGame, getGame, updateGame, deleteGame, listGames, bulkCreateGames, listCollections } from '../../services/chess/gameStore.js';
import {
  createMatch, getMatch, publicView, joinMatch, updateMatch, sessionSide,
} from '../../services/chess/matchStore.js';
import { db } from '../../services/aiVideo/db.js';

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

// ─── Collections (bulk PGN upload + folder index) ────────────────────
// POST /api/chess/games/bulk — body: { games: [{name, pgn, fen, ...}, ...], collection }
// Saves all N games under a single collection label inside one SQLite
// transaction so a 100-game tournament file is atomic.
export const postBulkSaveGames = (req, res) => {
  try {
    const { games, collection } = req.body || {};
    if (!Array.isArray(games) || games.length === 0) {
      return error(res, 'games must be a non-empty array', 400);
    }
    if (typeof collection !== 'string' || !collection.trim()) {
      return error(res, 'collection name is required', 400);
    }
    const coll = collection.trim();
    for (const g of games) {
      if (!g || typeof g.pgn !== 'string') {
        return error(res, 'every game needs a pgn string', 400);
      }
      if (g.name && String(g.name).length > NAME_MAX) {
        return error(res, `name too long (max ${NAME_MAX} chars)`, 400);
      }
    }
    bulkCreateGames(games, coll);
    return success(res, { saved: games.length, collection: coll });
  } catch (err) {
    logger.error('chess bulkSaveGames failed', err.message);
    return error(res, err.message);
  }
};

// GET /api/chess/collections — folder index for the saved-games sidebar.
// Returns [{ collection, count, lastUpdated }, ...]
export const getCollections = (_req, res) => {
  try {
    const items = listCollections();
    return success(res, items);
  } catch (err) {
    logger.error('chess getCollections failed', err.message);
    return error(res, err.message);
  }
};

// ─── Online challenge matches ───────────────────────────────────────
// Lightweight two-player lane. Creator gets back the matchId + their
// session token (stored in sessionStorage on the FE). Joiner hits
// /join with the matchId, gets their own session token. From then on
// every /move and /resign call carries the session so the BE can tell
// which side is acting. Polling is unauthenticated (publicView strips
// session tokens out of the response).

export const postCreateMatch = (req, res) => {
  try {
    const { whiteName = null, timeControlId = null, baseMs = null, incMs = null } = req.body || {};
    const row = createMatch({ whiteName, timeControlId, baseMs, incMs });
    return success(res, { matchId: row.id, whiteSession: row.whiteSession });
  } catch (err) {
    logger.error('chess createMatch failed', err.message);
    return error(res, err.message);
  }
};

export const postJoinMatch = (req, res) => {
  try {
    const { id } = req.params;
    const { blackName = null } = req.body || {};
    const result = joinMatch(id, blackName);
    if (result?.error) return error(res, result.error, 400);
    return success(res, { blackSession: result.blackSession });
  } catch (err) {
    logger.error('chess joinMatch failed', err.message);
    return error(res, err.message);
  }
};

// 60s of total silence (no GET poll from either side) auto-aborts the
// match so closed-tab matches don't sit "active" forever.
const ABORT_STALE_MS = 60_000;

// On every terminal transition (completed | aborted) where ≥1 move was
// played, snapshot the match into chess_games under the "Live Matches"
// collection. This is the durable archive: chess_matches is hot working
// state and the midnight cron sweeps it after 24h, but chess_games is
// permanent so either player can revisit the game forever from /chess.
// Zero-move aborts skip the archive — there's no PGN to keep.
function archiveMatchToGames(row) {
  try {
    if (!row || row.moveCount < 1) return;
    const datePart = new Date(row.completedAt || Date.now()).toLocaleDateString('en-GB');
    const white = row.whiteName || 'White';
    const black = row.blackName || 'Black';
    const tag   = row.status === 'aborted' ? ' · aborted' : '';
    createGame({
      name:           `Live · ${white} vs ${black} · ${row.moveCount}m${tag} · ${datePart}`,
      pgn:            row.pgn || '',
      fen:            row.fen,
      side:           'both',
      mode:           'live',
      engineName:     null,
      engineType:     null,
      engineStrength: null,
      timeControl:    row.timeControlId || null,
      result:         row.status === 'aborted' ? '*' : (row.result || '*'),
      moveCount:      row.moveCount,
      collection:     'Live Matches',
    });
  } catch (err) {
    logger.warn(`chess archive to chess_games failed for ${row?.id}: ${err.message}`);
  }
}

export const getMatchState = (req, res) => {
  const row = getMatch(req.params.id);
  if (!row) return error(res, 'match not found', 404);

  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const session = typeof req.query.session === 'string' ? req.query.session : null;
  const side = session ? sessionSide(row, session) : null;

  // Bump the polling side's lastSeenAt — that's how we tell who's still here.
  if (side === 'white') {
    updateMatch(row.id, { whiteLastSeenAt: nowIso });
    row.whiteLastSeenAt = nowIso;
  } else if (side === 'black') {
    updateMatch(row.id, { blackLastSeenAt: nowIso });
    row.blackLastSeenAt = nowIso;
  }

  // Auto-abort if everyone's gone. 'waiting' aborts on creator silence;
  // 'active' aborts only when BOTH sides have been silent past the cutoff.
  // 'completed' / 'aborted' are terminal — nothing to do.
  if (row.status === 'waiting' || row.status === 'active') {
    const wAnchor = row.whiteLastSeenAt || row.createdAt;
    const bAnchor = row.blackLastSeenAt || row.lastMoveAt || row.createdAt;
    const wStale  = wAnchor ? (now - new Date(wAnchor).getTime() > ABORT_STALE_MS) : true;
    const bStale  = bAnchor ? (now - new Date(bAnchor).getTime() > ABORT_STALE_MS) : true;
    const shouldAbort = row.status === 'waiting'
      ? wStale
      : (wStale && bStale);
    if (shouldAbort) {
      const aborted = updateMatch(row.id, {
        status: 'aborted',
        result: '*',
        completedAt: nowIso,
      });
      // ≥1 move played? Snapshot to chess_games so the partial game
      // survives the 24h chess_matches sweep.
      archiveMatchToGames(aborted);
      return success(res, publicView(aborted));
    }
  }

  return success(res, publicView(row));
};

export const postMatchMove = (req, res) => {
  try {
    const { id } = req.params;
    const { session, uci } = req.body || {};
    if (!session || typeof session !== 'string') return error(res, 'session required', 400);
    if (!uci || typeof uci !== 'string' || uci.length < 4) return error(res, 'uci must be a 4-5 char move string', 400);
    const row = getMatch(id);
    if (!row) return error(res, 'match not found', 404);
    if (row.status !== 'active') return error(res, `match is ${row.status}, cannot move`, 400);
    const side = sessionSide(row, session);
    if (!side) return error(res, 'invalid session for this match', 403);
    const expectedSide = row.sideToMove === 'w' ? 'white' : 'black';
    if (side !== expectedSide) return error(res, 'not your turn', 400);

    // Clock deduction — if a base time control is configured, deduct the
    // elapsed time since the previous move from the moving side's clock,
    // then add the Fischer increment. Anchored to lastMoveAt; FE interpolates
    // between polls but the BE value is authoritative on each move.
    let whiteMsNew = row.whiteMs;
    let blackMsNew = row.blackMs;
    let flagged = false;
    const nowMs = Date.now();
    if (row.baseMs) {
      const elapsedMs = row.lastMoveAt ? (nowMs - new Date(row.lastMoveAt).getTime()) : 0;
      if (side === 'white') {
        whiteMsNew = Math.max(0, (row.whiteMs ?? row.baseMs) - elapsedMs);
        if (whiteMsNew <= 0) flagged = true;
        else whiteMsNew += (row.incMs || 0);
      } else {
        blackMsNew = Math.max(0, (row.blackMs ?? row.baseMs) - elapsedMs);
        if (blackMsNew <= 0) flagged = true;
        else blackMsNew += (row.incMs || 0);
      }
    }

    const chess = new Chess(row.fen);
    let move;
    try {
      move = chess.move({
        from: uci.slice(0, 2),
        to:   uci.slice(2, 4),
        promotion: uci.length === 5 ? uci[4] : undefined,
      });
    } catch (e) {
      return error(res, `illegal move: ${e.message}`, 400);
    }
    if (!move) return error(res, 'illegal move', 400);

    // Append SAN to running PGN (just SAN tokens, space-separated — good
    // enough for the FE move list; full PGN export uses chess.pgn() from
    // a re-hydrated game when needed).
    const newPgn = row.pgn ? `${row.pgn} ${move.san}` : move.san;
    const newFen = chess.fen();
    const nextSide = chess.turn();        // 'w' | 'b'
    const moveCount = row.moveCount + 1;
    const now = new Date().toISOString();

    const patch = {
      fen: newFen,
      pgn: newPgn,
      sideToMove: nextSide,
      moveCount,
      lastMoveAt: now,
      whiteMs: whiteMsNew,
      blackMs: blackMsNew,
    };

    if (chess.isGameOver()) {
      patch.status = 'completed';
      patch.completedAt = now;
      if (chess.isCheckmate()) {
        // The side TO move is the one that got mated → opposite side wins.
        patch.result = nextSide === 'w' ? '0-1' : '1-0';
      } else {
        patch.result = '1/2-1/2';
      }
    } else if (flagged) {
      // The moving side just flagged — opponent wins.
      patch.status = 'completed';
      patch.completedAt = now;
      patch.result = side === 'white' ? '0-1' : '1-0';
    }

    const updated = updateMatch(id, patch);
    // Terminal transition (checkmate / draw / flag) — archive the
    // finished game into the permanent saved-games library.
    if (patch.status === 'completed') archiveMatchToGames(updated);
    return success(res, publicView(updated));
  } catch (err) {
    logger.error('chess match move failed', err.message);
    return error(res, err.message);
  }
};

export const postResignMatch = (req, res) => {
  try {
    const { id } = req.params;
    const { session } = req.body || {};
    if (!session || typeof session !== 'string') return error(res, 'session required', 400);
    const row = getMatch(id);
    if (!row) return error(res, 'match not found', 404);
    if (row.status === 'completed') return error(res, 'match already completed', 400);
    const side = sessionSide(row, session);
    if (!side) return error(res, 'invalid session for this match', 403);
    // Opponent wins on resignation.
    const result = side === 'white' ? '0-1' : '1-0';
    const now = new Date().toISOString();
    const updated = updateMatch(id, {
      status: 'completed',
      result,
      completedAt: now,
    });
    archiveMatchToGames(updated);
    return success(res, publicView(updated));
  } catch (err) {
    logger.error('chess match resign failed', err.message);
    return error(res, err.message);
  }
};

// ─── Live lobby ──────────────────────────────────────────────────────
// One-shot listing of matches currently waiting for an opponent. The FE
// calls this once on page load + on user-triggered refresh — no polling —
// so the BE doesn't need to be ultra-fast. Public view only.
export const listLiveMatches = (req, res) => {
  try {
    const rows = db
      .prepare(`SELECT * FROM chess_matches WHERE status = 'waiting' ORDER BY createdAt DESC LIMIT 20`)
      .all();
    return success(res, { items: rows.map(publicView) });
  } catch (err) {
    logger.error('chess listLiveMatches failed', err.message);
    return error(res, err.message);
  }
};
