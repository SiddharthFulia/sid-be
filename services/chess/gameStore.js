// SQLite store for the chess saved-games library.
//
// Lichess-style: every game saved as PGN + metadata. The FE library list
// renders one card per row with preview FEN, engine info, result, etc.
// Updates (auto-save during play) just bump updatedAt + replace pgn/fen.

import { db } from '../aiVideo/db.js';

const insertStmt = db.prepare(`INSERT INTO chess_games (
  name, pgn, fen, side, mode, engineName, engineType, engineStrength,
  timeControl, result, moveCount, createdAt, updatedAt
) VALUES (
  @name, @pgn, @fen, @side, @mode, @engineName, @engineType, @engineStrength,
  @timeControl, @result, @moveCount, @createdAt, @updatedAt
)`);

const selectStmt = db.prepare('SELECT * FROM chess_games WHERE id = ?');
const deleteStmt = db.prepare('DELETE FROM chess_games WHERE id = ?');

const UPDATABLE_COLS = new Set([
  'name', 'pgn', 'fen', 'side', 'mode', 'engineName', 'engineType',
  'engineStrength', 'timeControl', 'result', 'moveCount', 'updatedAt',
]);

export function createGame(data) {
  const now = new Date().toISOString();
  const row = {
    name: data.name || `Game · ${now.slice(0, 10)}`,
    pgn: data.pgn || '',
    fen: data.fen || 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    side: data.side || null,
    mode: data.mode || 'play',
    engineName: data.engineName || null,
    engineType: data.engineType || null,
    engineStrength: data.engineStrength || null,
    timeControl: data.timeControl || null,
    result: data.result || '*',
    moveCount: data.moveCount || 0,
    createdAt: now,
    updatedAt: now,
  };
  const info = insertStmt.run(row);
  return { id: info.lastInsertRowid, ...row };
}

export function getGame(id) {
  return selectStmt.get(id) || null;
}

export function updateGame(id, patch) {
  const existing = selectStmt.get(id);
  if (!existing) return null;
  const cols = Object.keys(patch).filter(c => UPDATABLE_COLS.has(c));
  if (cols.length === 0) return existing;
  // Always bump updatedAt on any change.
  if (!cols.includes('updatedAt')) cols.push('updatedAt');
  const params = { id, updatedAt: new Date().toISOString() };
  for (const c of cols) params[c] = c === 'updatedAt' ? params.updatedAt : patch[c];
  const set = cols.map(c => `${c} = @${c}`).join(', ');
  db.prepare(`UPDATE chess_games SET ${set} WHERE id = @id`).run(params);
  return selectStmt.get(id);
}

export function deleteGame(id) {
  return deleteStmt.run(id).changes > 0;
}

export function listGames({ limit = 50, result } = {}) {
  const safe = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  if (result && ['1-0', '0-1', '1/2-1/2', '*'].includes(result)) {
    return db.prepare(
      `SELECT * FROM chess_games WHERE result = ? ORDER BY updatedAt DESC LIMIT ?`
    ).all(result, safe);
  }
  return db.prepare(
    `SELECT * FROM chess_games ORDER BY updatedAt DESC LIMIT ?`
  ).all(safe);
}
