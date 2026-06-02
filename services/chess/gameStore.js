// SQLite store for the chess saved-games library.
//
// Lichess-style: every game saved as PGN + metadata. The FE library list
// renders one card per row with preview FEN, engine info, result, etc.
// Updates (auto-save during play) just bump updatedAt + replace pgn/fen.

import { db } from '../aiVideo/db.js';

const insertStmt = db.prepare(`INSERT INTO chess_games (
  name, pgn, fen, side, mode, engineName, engineType, engineStrength,
  timeControl, result, moveCount, collection, variant, startFen, movesUci,
  createdAt, updatedAt
) VALUES (
  @name, @pgn, @fen, @side, @mode, @engineName, @engineType, @engineStrength,
  @timeControl, @result, @moveCount, @collection, @variant, @startFen, @movesUci,
  @createdAt, @updatedAt
)`);

const selectStmt = db.prepare('SELECT * FROM chess_games WHERE id = ?');
const deleteStmt = db.prepare('DELETE FROM chess_games WHERE id = ?');

const UPDATABLE_COLS = new Set([
  'name', 'pgn', 'fen', 'side', 'mode', 'engineName', 'engineType',
  'engineStrength', 'timeControl', 'result', 'moveCount', 'collection',
  'variant', 'startFen', 'movesUci', 'updatedAt',
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
    collection: data.collection || null,
    variant: data.variant || 'standard',
    startFen: data.startFen || null,
    movesUci: data.movesUci || null,
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

export function listGames({ limit = 50, result, variant } = {}) {
  const safe = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const where = [];
  const params = [];
  if (result && ['1-0', '0-1', '1/2-1/2', '*'].includes(result)) {
    where.push('result = ?'); params.push(result);
  }
  if (variant && typeof variant === 'string' && variant.length <= 24) {
    where.push('variant = ?'); params.push(variant);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db.prepare(
    `SELECT * FROM chess_games ${clause} ORDER BY updatedAt DESC LIMIT ?`
  ).all(...params, safe);
}

// ─── Collections ─────────────────────────────────────────────────────
// Folder-style grouping of saved games. Each row in chess_games can opt
// into a `collection` text label — when a PGN file with 100+ games is
// bulk-uploaded, all rows land under the same collection so the FE can
// fold them under a single ►/▼ header.
export function listCollections() {
  return db.prepare(
    `SELECT collection, COUNT(*) AS count, MAX(updatedAt) AS lastUpdated
       FROM chess_games
      WHERE collection IS NOT NULL
   GROUP BY collection
   ORDER BY lastUpdated DESC`
  ).all();
}

// Bulk insert N games under one collection in a single SQLite transaction
// so a 100-game PGN file saves atomically (no half-saved batches if the
// connection drops mid-flight). Returns the array of new row ids.
export function bulkCreateGames(rows, collection) {
  const insertMany = db.transaction((games) => {
    const ids = [];
    for (const g of games) {
      const now = new Date().toISOString();
      const row = {
        name: g.name || `Game · ${now.slice(0, 10)}`,
        pgn: g.pgn || '',
        fen: g.fen || 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        side: g.side || null,
        mode: g.mode || 'analyze',
        engineName: g.engineName || null,
        engineType: g.engineType || null,
        engineStrength: g.engineStrength || null,
        timeControl: g.timeControl || null,
        result: g.result || '*',
        moveCount: g.moveCount || 0,
        collection: collection || null,
        variant: g.variant || 'standard',
        startFen: g.startFen || null,
        movesUci: g.movesUci || null,
        createdAt: now,
        updatedAt: now,
      };
      const info = insertStmt.run(row);
      ids.push(info.lastInsertRowid);
    }
    return ids;
  });
  return insertMany(rows);
}
