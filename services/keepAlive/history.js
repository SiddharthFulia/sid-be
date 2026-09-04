// SQLite-backed history for keep-alive runs.
//
// Was: in-memory ring buffer inside services/keepAlive/index.js. That
// stopped working once the consumer moved to its own process — the API
// couldn't see the consumer's memory anymore. SQLite is the shared surface
// both processes hit.
//
// Table auto-creates on first import. Uses the same `data/sid.db` file the
// rest of the app writes to, so nothing new to back up.

import Database from 'better-sqlite3';
import path from 'path';

const DB_PATH = path.join(process.cwd(), 'data', 'sid.db');

// Lazy-open — the consumer script uses this from a separate process, so
// each process opens its own handle to the same file. WAL mode (set by
// services/aiVideo/db.js in the API process) means readers don't block
// writers, so concurrent access is safe.
let _db = null;
function db() {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL');
  _db.exec(`
    CREATE TABLE IF NOT EXISTS keep_alive_history (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      requestId    TEXT NOT NULL,
      reason       TEXT NOT NULL,         -- 'cron' | 'manual'
      triggeredAt  TEXT,                  -- ISO from publisher
      startedAt    TEXT NOT NULL,         -- ISO — when consumer picked it up
      finishedAt   TEXT NOT NULL,         -- ISO — when probes finished
      probesJson   TEXT NOT NULL,         -- JSON array of probe results
      ok           INTEGER NOT NULL       -- 0/1
    );
    CREATE INDEX IF NOT EXISTS idx_ka_history_started
      ON keep_alive_history(startedAt DESC);
  `);
  return _db;
}

const HISTORY_MAX = 200;   // hard cap in the table — pruned on every insert

const insertStmt = () => db().prepare(`
  INSERT INTO keep_alive_history
    (requestId, reason, triggeredAt, startedAt, finishedAt, probesJson, ok)
  VALUES (@requestId, @reason, @triggeredAt, @startedAt, @finishedAt, @probesJson, @ok)
`);

const pruneStmt = () => db().prepare(`
  DELETE FROM keep_alive_history
  WHERE id NOT IN (
    SELECT id FROM keep_alive_history ORDER BY startedAt DESC LIMIT ?
  )
`);

/**
 * Called by the consumer after each run.
 */
export function recordKeepAliveRun(entry) {
  insertStmt().run({
    requestId:   entry.requestId,
    reason:      entry.reason,
    triggeredAt: entry.triggeredAt,
    startedAt:   entry.startedAt,
    finishedAt:  entry.finishedAt,
    probesJson:  JSON.stringify(entry.probes || []),
    ok:          entry.ok ? 1 : 0,
  });
  // Keep the table lean — the admin panel only shows the last 20 anyway.
  pruneStmt().run(HISTORY_MAX);
}

/**
 * Called by the API's GET /admin/keep-alive/status handler.
 */
export function listKeepAliveHistory(limit = 20) {
  const rows = db().prepare(`
    SELECT requestId, reason, triggeredAt, startedAt, finishedAt, probesJson, ok
    FROM keep_alive_history
    ORDER BY startedAt DESC
    LIMIT ?
  `).all(limit);
  return rows.map((r) => ({
    requestId:   r.requestId,
    reason:      r.reason,
    triggeredAt: r.triggeredAt,
    startedAt:   r.startedAt,
    finishedAt:  r.finishedAt,
    probes:      safeJson(r.probesJson, []),
    ok:          !!r.ok,
  }));
}

function safeJson(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}
