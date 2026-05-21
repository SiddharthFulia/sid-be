// Online chess match store. Schema in services/aiVideo/db.js.
//
// Matches are short-lived live games — created by player A, joined by
// player B via the same matchId, played out with HTTP polling for
// opponent moves. Once completed, the row is preserved and the same
// PGN is also copied into chess_games so it shows up in the player's
// saved library.

import { randomBytes } from 'crypto';
import { db } from '../aiVideo/db.js';

const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

// Short URL-friendly id (5 chars, base36 from random bytes). ~60M possible
// ids → cheap collision check + retry covers it. Excludes lookalikes
// (0/o/1/l/i) so 'CHESS/abc12' is hard to mistype over voice.
const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
function genMatchId() {
  const bytes = randomBytes(5);
  let out = '';
  for (let i = 0; i < 5; i++) out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  return out;
}

// 24-char hex — used as side-session tokens. Server validates these
// before accepting a move; never sent in the GET /matches/:id response
// so polling can be public without leaking the opponent's session.
function genSessionToken() {
  return randomBytes(12).toString('hex');
}

const insertStmt = db.prepare(`INSERT INTO chess_matches (
  id, status, whiteSession, blackSession, whiteName, blackName,
  fen, pgn, sideToMove, moveCount, result,
  timeControlId, baseMs, incMs, whiteMs, blackMs,
  createdAt, updatedAt, lastMoveAt, completedAt
) VALUES (
  @id, @status, @whiteSession, @blackSession, @whiteName, @blackName,
  @fen, @pgn, @sideToMove, @moveCount, @result,
  @timeControlId, @baseMs, @incMs, @whiteMs, @blackMs,
  @createdAt, @updatedAt, @lastMoveAt, @completedAt
)`);

const selectStmt = db.prepare('SELECT * FROM chess_matches WHERE id = ?');

const UPDATABLE = new Set([
  'status', 'blackSession', 'whiteName', 'blackName',
  'fen', 'pgn', 'sideToMove', 'moveCount', 'result',
  'whiteMs', 'blackMs', 'lastMoveAt', 'completedAt',
  'whiteLastSeenAt', 'blackLastSeenAt',
]);

export function createMatch({
  whiteName = null,
  timeControlId = null,
  baseMs = null,
  incMs = null,
} = {}) {
  // Retry on collision (rare with 60M id space).
  let id;
  for (let i = 0; i < 5; i++) {
    id = genMatchId();
    if (!selectStmt.get(id)) break;
  }
  const now = new Date().toISOString();
  const row = {
    id,
    status: 'waiting',
    whiteSession: genSessionToken(),
    blackSession: null,
    whiteName,
    blackName: null,
    fen: STARTING_FEN,
    pgn: '',
    sideToMove: 'w',
    moveCount: 0,
    result: '*',
    timeControlId,
    baseMs,
    incMs,
    whiteMs: baseMs,
    blackMs: baseMs,
    createdAt: now,
    updatedAt: now,
    lastMoveAt: null,
    completedAt: null,
  };
  insertStmt.run(row);
  return row;
}

export function getMatch(id) {
  return selectStmt.get(id) || null;
}

// Public view — strips session tokens so polling can't leak them.
export function publicView(row) {
  if (!row) return null;
  const { whiteSession: _w, blackSession: _b, ...rest } = row;
  return rest;
}

export function joinMatch(id, blackName = null) {
  const row = selectStmt.get(id);
  if (!row) return { error: 'match not found' };
  if (row.status !== 'waiting') return { error: 'match already in progress or finished' };
  const blackSession = genSessionToken();
  const now = new Date().toISOString();
  db.prepare(`UPDATE chess_matches
    SET blackSession = ?, blackName = ?, status = 'active', updatedAt = ?, lastMoveAt = ?
    WHERE id = ?`).run(blackSession, blackName, now, now, id);
  return { row: selectStmt.get(id), blackSession };
}

export function updateMatch(id, patch) {
  const existing = selectStmt.get(id);
  if (!existing) return null;
  const cols = Object.keys(patch).filter(c => UPDATABLE.has(c));
  if (cols.length === 0) return existing;
  if (!cols.includes('updatedAt')) cols.push('updatedAt');
  const params = { id, updatedAt: new Date().toISOString() };
  for (const c of cols) params[c] = c === 'updatedAt' ? params.updatedAt : patch[c];
  const set = cols.map(c => `${c} = @${c}`).join(', ');
  db.prepare(`UPDATE chess_matches SET ${set} WHERE id = @id`).run(params);
  return selectStmt.get(id);
}

// Auth helper — caller passes the session they think they have; we
// return 'white', 'black', or null. Match controllers use this to gate
// move submissions and resigns.
export function sessionSide(row, token) {
  if (!row || !token) return null;
  if (row.whiteSession === token) return 'white';
  if (row.blackSession === token) return 'black';
  return null;
}
