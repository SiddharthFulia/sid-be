// /api/chess/puzzles/* — controllers for the Chess Puzzles lane.
//
// Public:
//   GET    /chess/puzzles/users
//   POST   /chess/puzzles/users               { name }
//   GET    /chess/puzzles/next?userId=&difficulty=
//   POST   /chess/puzzles/attempt             { userId, puzzleId, success, attemptsUsed, viewedSolution, difficulty }
//   GET    /chess/puzzles/stats?userId=
//
// Vault-gated:
//   DELETE /chess/puzzles/users/:id           — wired via requireVault on the router.

import { success, error } from '../../helpers/res_helper.js';
import logger from '../../helpers/logger.js';
import {
  listPuzzleUsers, getPuzzleUser, getPuzzleUserByName,
  createPuzzleUser, deletePuzzleUser,
  pickNextPuzzle, getPuzzleById,
  recordAttempt, getPuzzleStats,
  puzzlesCount,
  POINTS,
} from '../../services/chess/puzzleStore.js';

const NAME_MIN = 2;
const NAME_MAX = 24;
const NAME_RE  = /^[a-zA-Z0-9_\-. ]+$/;

const DIFFICULTIES = new Set(['easy', 'medium', 'hard']);

// Rotating success blurbs — one is picked at random on every win so the
// user doesn't see the same congratulations twice in a row.
const WIN_MESSAGES_FIRST_TRY = [
  'Excellent!', 'Amazing!', 'Brilliant!', 'Sharp eye!', 'Crushing!', 'Magnificent!',
];
const WIN_MESSAGES_RETRY = [
  'Good going!', 'Got there in the end!', 'Solid recovery!', 'Nice grit!',
];
const LOSS_MESSAGES = [
  'Tough one — try again.', 'Not this time.', 'Better luck next puzzle.',
];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// ── Users ─────────────────────────────────────────────────────────
export const getPuzzleUsersList = (_req, res) => {
  try {
    return success(res, { items: listPuzzleUsers() });
  } catch (err) {
    logger.error('chess puzzle users list failed', err.message);
    return error(res, err.message);
  }
};

export const postPuzzleUser = (req, res) => {
  try {
    const raw = req.body?.name;
    if (typeof raw !== 'string') return error(res, 'name required', 400);
    const name = raw.trim();
    if (name.length < NAME_MIN || name.length > NAME_MAX) {
      return error(res, `name must be ${NAME_MIN}-${NAME_MAX} chars`, 400);
    }
    if (!NAME_RE.test(name)) {
      return error(res, 'name can use letters, numbers, _ - . and spaces', 400);
    }
    if (getPuzzleUserByName(name)) {
      return error(res, 'name already taken', 409);
    }
    const user = createPuzzleUser(name);
    return success(res, user);
  } catch (err) {
    logger.error('chess puzzle user create failed', err.message);
    return error(res, err.message);
  }
};

export const removePuzzleUser = (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return error(res, 'invalid id', 400);
    const ok = deletePuzzleUser(id);
    if (!ok) return error(res, 'user not found', 404);
    return success(res, { ok: true });
  } catch (err) {
    logger.error('chess puzzle user delete failed', err.message);
    return error(res, err.message);
  }
};

// ── Puzzle fetch ──────────────────────────────────────────────────
export const getNextPuzzle = (req, res) => {
  try {
    const userId = parseInt(req.query.userId, 10);
    const difficulty = String(req.query.difficulty || 'easy').toLowerCase();
    if (!Number.isFinite(userId)) return error(res, 'userId is required', 400);
    if (!DIFFICULTIES.has(difficulty)) return error(res, 'difficulty must be easy | medium | hard', 400);

    if (puzzlesCount() === 0) {
      return error(res, 'puzzle library not imported yet — run scripts/import-lichess-puzzles.mjs', 503);
    }

    const user = getPuzzleUser(userId);
    if (!user) return error(res, 'user not found', 404);

    const row = pickNextPuzzle({ userId, difficulty });
    if (!row) return error(res, 'no fresh puzzles left in this bracket — try a different difficulty', 404);

    // Shape the response in camelCase. Don't leak the full solution moves
    // until the attempt is over — but the FE needs them client-side to
    // detect a correct sequence. Sending them is fine here because puzzles
    // are public knowledge anyway (lichess gives them away for free).
    return success(res, {
      puzzleId:   row.puzzle_id,
      fen:        row.fen,
      moves:      row.moves,         // space-separated UCI; FE matches each ply
      rating:     row.rating,
      themes:     row.themes ? row.themes.split(' ').filter(Boolean) : [],
      gameUrl:    row.game_url || null,
      openingTags: row.opening_tags ? row.opening_tags.split(' ').filter(Boolean) : [],
      popularity: row.popularity,
      nbPlays:    row.nb_plays,
      // Echo the user's rating + difficulty so the FE can show "bracket
      // 1850-1950" without a second round-trip.
      userRating: user.rating,
      difficulty,
    });
  } catch (err) {
    logger.error('chess puzzle next failed', err.message);
    return error(res, err.message);
  }
};

// ── Attempt submission ────────────────────────────────────────────
export const postAttempt = (req, res) => {
  try {
    const {
      userId, puzzleId, success: succRaw,
      attemptsUsed = 1, viewedSolution = false, difficulty = 'easy',
    } = req.body || {};
    if (!Number.isFinite(parseInt(userId, 10))) return error(res, 'userId required', 400);
    if (typeof puzzleId !== 'string' || !puzzleId.trim()) return error(res, 'puzzleId required', 400);
    if (typeof succRaw !== 'boolean' && succRaw !== 0 && succRaw !== 1) {
      return error(res, 'success must be a boolean', 400);
    }
    const diff = String(difficulty).toLowerCase();
    if (!DIFFICULTIES.has(diff)) return error(res, 'difficulty must be easy | medium | hard', 400);

    const uid = parseInt(userId, 10);
    const succ = !!succRaw;
    const tries = Math.max(1, Math.min(3, parseInt(attemptsUsed, 10) || 1));
    const viewed = !!viewedSolution;

    const user = getPuzzleUser(uid);
    if (!user) return error(res, 'user not found', 404);
    const puzzle = getPuzzleById(puzzleId);
    if (!puzzle) return error(res, 'puzzle not found', 404);

    const { user: updated, ratingDelta } = recordAttempt({
      userId: uid, puzzleId,
      success: succ,
      attemptsUsed: tries,
      viewedSolution: viewed,
      difficulty: diff,
    });

    // Pick a vibrant message that matches the outcome.
    let message;
    if (succ && tries === 1) message = pick(WIN_MESSAGES_FIRST_TRY);
    else if (succ && tries > 1) message = pick(WIN_MESSAGES_RETRY);
    else message = pick(LOSS_MESSAGES);

    return success(res, {
      newRating: updated.rating,
      ratingDelta,
      solvedCount: updated.solved_count,
      message,
      // Echo the points table so the FE can render "Easy: +15 / -10" tips
      // without duplicating the table in JS.
      pointsTable: POINTS[diff],
    });
  } catch (err) {
    logger.error('chess puzzle attempt failed', err.message);
    return error(res, err.message);
  }
};

// ── Stats ─────────────────────────────────────────────────────────
export const getStats = (req, res) => {
  try {
    const userId = parseInt(req.query.userId, 10);
    if (!Number.isFinite(userId)) return error(res, 'userId required', 400);
    const stats = getPuzzleStats(userId);
    if (!stats) return error(res, 'user not found', 404);
    return success(res, stats);
  } catch (err) {
    logger.error('chess puzzle stats failed', err.message);
    return error(res, err.message);
  }
};
