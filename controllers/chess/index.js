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
import { listOpenings, findBySlug, findByEco, computeFen, identifyOpening } from '../../services/chessOpenings.js';
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

// ─── Variants lane (Chess960 / King-of-the-Hill / Three-Check) ──────
// One endpoint for all three playable variants. The FE owns rules logic
// (chess.js + custom win checks for KoTH / 3-Check); the BE just hands
// back a Stockfish move for the given FEN. For Chess960 we flip the
// engine's UCI_Chess960 flag so castling rights with rook-file letters
// (X-FEN) parse correctly; for the other two Stockfish runs vanilla.
//   POST /api/chess/variant/play
//   body: { variant, fen, moveHistory?, options? }
//     options.elo     — clamped to [1320, 3190] by the engine layer (default 1500)
//     options.thinkMs — engine time budget (default 500)
//     options.depth   — optional depth cap
//   → { bestmove, eval: { type, value } | null, variant, eloUsed }
const SUPPORTED_VARIANTS = new Set(['chess960', 'koth', 'threeCheck']);

export const postVariantPlay = async (req, res) => {
  try {
    const { variant, fen, options = {} } = req.body || {};
    if (!variant || !SUPPORTED_VARIANTS.has(variant)) {
      return error(res, `unsupported variant: ${variant}. Allowed: ${[...SUPPORTED_VARIANTS].join(', ')}`, 400);
    }
    const verr = validateFen(fen);
    if (verr) return error(res, verr, 400);

    // For 960, Stockfish must be told the position is shuffled — otherwise
    // X-FEN castling tokens (e.g. "AHah") are rejected and castles play
    // illegally. KoTH / 3-Check share standard Stockfish; the variant
    // rules live FE-side.
    const elo     = options.elo     ?? 1500;
    const thinkMs = options.thinkMs ?? 500;
    const depth   = options.depth;
    const uciChess960 = variant === 'chess960';

    const out = await play({ fen, elo, thinkMs, uciChess960, depth });
    return success(res, {
      bestmove: out.bestmove || null,
      eval:     out.score || null,
      variant,
      eloUsed:  out.eloUsed,
    });
  } catch (err) {
    logger.error('chess variant play failed', err.message);
    return error(res, err.message, 503);
  }
};

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
      // Any pending takeback request is invalidated the moment someone
      // moves — the position has changed underneath it. Clear it so the
      // opponent doesn't keep seeing a stale request modal.
      takebackRequest: null,
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

// ─── Takeback request flow ───────────────────────────────────────────
// One player requests; opponent must approve on their own screen before
// the move is reverted. Unlimited per match (no counter, no cap).
//
// State shape (stored as JSON in chess_matches.takebackRequest):
//   { requestedBy: 'white'|'black',
//     requestedAtPly: <int>,         -- moveCount when request fired
//     plyToRevertTo: <int>,          -- moveCount the BE will truncate to
//     requestedAt: ISO-string }
//
// On accept: BE truncates moves array (PGN SAN tokens) to plyToRevertTo,
// replays through chess.js to recover the FEN + side-to-move, writes the
// new state, clears the request.
// On decline: BE just clears the request.
// On any new move: clearing happens implicitly via postMatchMove.

export const postTakebackRequest = (req, res) => {
  try {
    const { id } = req.params;
    const { session, plyToRevertTo } = req.body || {};
    if (!session || typeof session !== 'string') return error(res, 'session required', 400);
    const row = getMatch(id);
    if (!row) return error(res, 'match not found', 404);
    if (row.status !== 'active') return error(res, `match is ${row.status}, cannot request takeback`, 400);
    const side = sessionSide(row, session);
    if (!side) return error(res, 'invalid session for this match', 403);
    if (row.moveCount < 1) return error(res, 'no moves to take back yet', 400);

    // Default: revert one move (go back one ply). Allow caller to override
    // for multi-ply takebacks (e.g. revert opponent's move + your reply).
    // Clamp to [0, currentPly - 1] so we always actually undo something.
    const currentPly = row.moveCount;
    let target = (typeof plyToRevertTo === 'number' && Number.isFinite(plyToRevertTo))
      ? Math.floor(plyToRevertTo)
      : currentPly - 1;
    if (target < 0) target = 0;
    if (target >= currentPly) target = currentPly - 1;

    const request = {
      requestedBy:    side,
      requestedAtPly: currentPly,
      plyToRevertTo:  target,
      requestedAt:    new Date().toISOString(),
    };
    const updated = updateMatch(id, { takebackRequest: JSON.stringify(request) });
    return success(res, publicView(updated));
  } catch (err) {
    logger.error('chess takeback request failed', err.message);
    return error(res, err.message);
  }
};

// Replays SAN tokens through chess.js to recover FEN/turn after a
// truncation. SAN is what postMatchMove appends to row.pgn, so this
// inverts that. Empty string → starting position.
const TAKEBACK_STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
function replayToPly(pgnSanString, plyTarget) {
  const tokens = pgnSanString ? pgnSanString.trim().split(/\s+/).filter(Boolean) : [];
  const kept   = tokens.slice(0, Math.max(0, plyTarget));
  const chess  = new Chess();
  for (const san of kept) {
    // chess.js throws on illegal SAN — that means our PGN got out of sync
    // with reality, which is a server bug, not a user error. Let it bubble.
    chess.move(san);
  }
  return {
    pgn:        kept.join(' '),
    fen:        chess.fen() || TAKEBACK_STARTING_FEN,
    sideToMove: chess.turn(),  // 'w' | 'b'
    moveCount:  kept.length,
  };
}

export const postTakebackAccept = (req, res) => {
  try {
    const { id } = req.params;
    const { session } = req.body || {};
    if (!session || typeof session !== 'string') return error(res, 'session required', 400);
    const row = getMatch(id);
    if (!row) return error(res, 'match not found', 404);
    if (row.status !== 'active') return error(res, `match is ${row.status}, cannot accept takeback`, 400);
    const side = sessionSide(row, session);
    if (!side) return error(res, 'invalid session for this match', 403);

    const raw = row.takebackRequest;
    if (!raw) return error(res, 'no pending takeback request', 400);
    let request;
    try { request = JSON.parse(raw); } catch { return error(res, 'takeback request is corrupted', 500); }
    if (!request || !request.requestedBy) return error(res, 'takeback request is malformed', 500);
    // Only the OPPONENT of the requester can accept. The requester can't
    // self-approve.
    if (request.requestedBy === side) return error(res, 'you cannot accept your own takeback', 400);

    const target = request.plyToRevertTo;
    let replayed;
    try {
      replayed = replayToPly(row.pgn || '', target);
    } catch (e) {
      logger.error(`chess takeback replay failed for ${id}: ${e.message}`);
      return error(res, 'failed to replay position to that ply', 500);
    }

    const patch = {
      fen:             replayed.fen,
      pgn:             replayed.pgn,
      sideToMove:      replayed.sideToMove,
      moveCount:       replayed.moveCount,
      // Re-anchor lastMoveAt so the clock starts ticking fresh for whoever
      // now has to move. (We don't refund clock time — keep it simple.)
      lastMoveAt:      new Date().toISOString(),
      takebackRequest: null,
    };
    const updated = updateMatch(id, patch);
    return success(res, publicView(updated));
  } catch (err) {
    logger.error('chess takeback accept failed', err.message);
    return error(res, err.message);
  }
};

export const postTakebackDecline = (req, res) => {
  try {
    const { id } = req.params;
    const { session } = req.body || {};
    if (!session || typeof session !== 'string') return error(res, 'session required', 400);
    const row = getMatch(id);
    if (!row) return error(res, 'match not found', 404);
    const side = sessionSide(row, session);
    if (!side) return error(res, 'invalid session for this match', 403);

    const raw = row.takebackRequest;
    if (!raw) return error(res, 'no pending takeback request', 400);
    // Either side can clear it (the requester might want to cancel their
    // own request). Be lenient — just nuke it. Side is validated above so
    // unrelated clients can't poke at it.
    void side;
    const updated = updateMatch(id, { takebackRequest: null });
    return success(res, publicView(updated));
  } catch (err) {
    logger.error('chess takeback decline failed', err.message);
    return error(res, err.message);
  }
};

// ─── Opening database (lichess-org/chess-openings, CC0) ─────────────
// Two-stage lazy lane:
//   GET /chess/openings              — paginated cheap list (name + eco + slug)
//   GET /chess/openings/:slug        — full record incl. FEN + SAN moves
// The detail endpoint computes the resulting FEN on the fly so the FE
// can pipe it straight to Lichess's Opening Explorer for "master games"
// without us bundling an opening book ourselves.

export const getOpeningsList = (req, res) => {
  try {
    const page  = parseInt(req.query.page, 10)  || 1;
    const limit = parseInt(req.query.limit, 10) || 50;
    const q     = typeof req.query.q === 'string' ? req.query.q : '';
    const out = listOpenings({ page, limit, q });
    return success(res, out);
  } catch (err) {
    logger.error('chess openings list failed', err.message);
    return error(res, err.message);
  }
};

// ─── Lichess Opening Explorer proxy ──────────────────────────────────
// Browsers hitting explorer.lichess.ovh directly get 401'd (the upstream
// is fussy about UA/origin combos and occasionally throttles anonymous
// browser traffic). Proxying server-side fixes it: we send a polite
// identifying UA, cache by FEN for 10 minutes (the masters DB doesn't
// move during a session), and pass 429/5xx straight through so the FE
// can show a "rate-limited, retry in a moment" hint.
//
// GET /api/chess/openings/explorer?fen=...&moves=5
//
// Allowlisted query params (anything else is dropped):
//   fen, play, moves, topGames, ratings, speeds, since, until

const EXPLORER_CACHE = new Map();
const EXPLORER_TTL = 10 * 60 * 1000; // 10 min
const EXPLORER_MAX_ENTRIES = 500;
const EXPLORER_UA = 'siddharthfulia-portfolio/1.0 (https://siddharthfulia.com)';
const EXPLORER_PARAM_ALLOWLIST = ['fen', 'play', 'moves', 'topGames', 'ratings', 'speeds', 'since', 'until'];

function explorerCacheGet(key) {
  const entry = EXPLORER_CACHE.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > EXPLORER_TTL) {
    EXPLORER_CACHE.delete(key);
    return null;
  }
  return entry.data;
}

function explorerCacheSet(key, data) {
  EXPLORER_CACHE.set(key, { data, ts: Date.now() });
  // Evict oldest if we're getting heavy — Map iteration order is insertion order.
  if (EXPLORER_CACHE.size > EXPLORER_MAX_ENTRIES) {
    const oldest = EXPLORER_CACHE.keys().next().value;
    EXPLORER_CACHE.delete(oldest);
  }
}

export const getOpeningExplorer = async (req, res) => {
  try {
    const params = new URLSearchParams();
    for (const k of EXPLORER_PARAM_ALLOWLIST) {
      const v = req.query[k];
      if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
    }
    if (!params.has('fen')) return error(res, 'fen query param is required', 400);

    // Cache key = full canonical query string. Different `moves` / `topGames`
    // values warrant separate cache entries since the payload differs.
    const qs = params.toString();
    const cached = explorerCacheGet(qs);
    if (cached) return success(res, cached);

    const upstream = `https://explorer.lichess.ovh/masters?${qs}`;
    let r;
    try {
      r = await fetch(upstream, {
        headers: {
          'User-Agent': EXPLORER_UA,
          'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(10000),
      });
    } catch (fetchErr) {
      // AbortError on timeout, or network failure.
      if (fetchErr.name === 'TimeoutError' || fetchErr.name === 'AbortError') {
        return error(res, 'lichess explorer timed out', 504);
      }
      return error(res, `lichess explorer unreachable: ${fetchErr.message}`, 502);
    }

    if (r.status === 429) {
      const retryAfter = r.headers.get('retry-after');
      if (retryAfter) res.set('Retry-After', retryAfter);
      return error(res, 'lichess explorer rate-limited', 429, { retryAfter: retryAfter || null });
    }
    if (r.status >= 500) {
      return error(res, `lichess explorer ${r.status}`, r.status);
    }
    if (!r.ok) {
      return error(res, `lichess explorer ${r.status}: ${r.statusText}`, r.status);
    }

    const data = await r.json();
    explorerCacheSet(qs, data);
    return success(res, data);
  } catch (err) {
    logger.error('chess openings explorer proxy failed', err.message);
    return error(res, err.message, 500);
  }
};

export const getOpeningDetail = (req, res) => {
  try {
    const key = String(req.params.slug || '').trim();
    if (!key) return error(res, 'slug required', 400);
    // Accept either a slug or an ECO code (e.g. /openings/B90 → Najdorf).
    // ECO codes are 3 chars, letter A-E + two digits — easy to detect.
    const isEco = /^[A-Ea-e]\d{2}$/.test(key);
    const row = isEco ? findByEco(key.toUpperCase()) : findBySlug(key);
    if (!row) return error(res, `opening not found: ${key}`, 404);
    let fen;
    try {
      fen = computeFen(row.moves);
    } catch (e) {
      logger.error(`chess openings: FEN replay failed for ${row.slug} — ${e.message}`);
      return error(res, `internal: could not replay opening "${row.name}"`, 500);
    }
    return success(res, {
      eco:   row.eco,
      name:  row.name,
      slug:  row.slug,
      pgn:   row.pgn,
      moves: row.moves,
      fen,
    });
  } catch (err) {
    logger.error('chess openings detail failed', err.message);
    return error(res, err.message);
  }
};

// ─── Live opening identification ─────────────────────────────────────
// POST /api/chess/openings/identify { moves: [SAN, ...] }
// GET  /api/chess/openings/identify?moves=e4,c5,Nf3,d6,d4   (lenient)
//
// Returns the most-specific known opening whose move list is a prefix
// of the input. Pure read — nothing persisted; the FE calls this after
// each ply to live-update the opening heading above the move list.
// When the game leaves book entirely (no prefix matches at any depth)
// the response carries { eco: null, name: null } so the FE can show
// the last-known name with an "(out of book)" tag.
export const postIdentifyOpening = (req, res) => {
  try {
    // Body wins over query when both are present. Both shapes are
    // tolerated to keep cURL / quick-test ergonomics open.
    let moves = null;
    const body = req.body || {};
    if (Array.isArray(body.moves)) {
      moves = body.moves;
    } else if (typeof req.query.moves === 'string' && req.query.moves.trim()) {
      moves = req.query.moves.split(',').map(s => s.trim()).filter(Boolean);
    }
    if (!Array.isArray(moves)) return error(res, 'moves must be an array of SAN strings', 400);
    // Cap the input — pathological 200-ply payloads aren't useful for
    // opening identification and we don't want to allocate a huge key.
    if (moves.length > 60) moves = moves.slice(0, 60);

    const hit = identifyOpening(moves);
    if (!hit) {
      return success(res, { eco: null, name: null, slug: null, matchedPly: 0 });
    }
    return success(res, hit);
  } catch (err) {
    logger.error('chess identifyOpening failed', err.message);
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
